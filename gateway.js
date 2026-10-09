#!/usr/bin/env node
/**
 * workbuddy-gateway — expose a locally logged-in WorkBuddy / CodeBuddy account as an
 * OpenAI-compatible endpoint.
 *
 * What it does
 * ------------
 *   1. injects the desktop client's session headers into every upstream request;
 *   2. normalizes the upstream SSE stream into clean OpenAI chunks;
 *   3. desensitizes the compliance boilerplate in system/developer messages, which
 *      the upstream content filter otherwise rejects with
 *      `11128 Illegal API invocation from an unapproved channel`;
 *   4. retries once with heavier desensitization when that rejection still happens.
 *
 * Zero dependencies. Node >= 18 (built-in fetch).
 *
 * Usage:
 *   node gateway.js [--port 8790] [--host 127.0.0.1] [--api-key KEY]
 *                   [--upstream URL] [--auth-file PATH]
 *                   [--model-list a,b,c] [--config PATH] [--log FILE]
 *                   [--debug] [--detach] [--no-desensitize] [--no-retry] [--expose-identity]
 *
 * --detach re-launches the gateway in the background and returns immediately; stop it
 * with the PID printed, or with the pid file written next to --log.
 *
 * See README.md. Logic lives in lib/core.js and lib/credentials.js.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  buildUpstreamBody, isBlockPayload, StreamAccumulator,
  makeChunk, makeUsageChunk, SSE_DONE, sseFrame, countZeroWidth,
  sessionIdFromHeaders, resolveConversationId,
  modelLimits, MODEL_LIMITS,
} = require('./lib/core');
const { Credential } = require('./lib/credentials');
const catalog = require('./lib/catalog');

// ---------------------------------------------------------------------------
// Configuration: defaults, then the config file, then CLI flags / environment
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_FILE = path.join(os.homedir(), '.workbuddy-gateway', 'config.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

const args = parseArgs(process.argv);

/**
 * Read a JSON config file, tolerating a UTF-8 BOM.
 *
 * Windows tooling adds one readily: PowerShell 5.1's `Set-Content -Encoding UTF8`
 * writes a BOM, and so does Notepad when a user edits the file by hand.
 * JSON.parse rejects the leading U+FEFF outright, which turns an otherwise valid
 * config into a hard startup failure.
 */
function readConfigFile(file) {
  if (!file) return {};
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error('cannot read config file ' + file + ': ' + e.message);
  }
}

const configFile = args.config === true ? DEFAULT_CONFIG_FILE
  : (typeof args.config === 'string' ? args.config
    : (process.env.WORKBUDDY_GATEWAY_CONFIG || DEFAULT_CONFIG_FILE));

let fileConfig;
try { fileConfig = readConfigFile(configFile); }
catch (e) { process.stderr.write('[workbuddy-gateway] ' + e.message + '\n'); process.exit(1); }

function pick(...values) {
  for (const v of values) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

/**
 * Default model list.
 *
 * Every id here was probed against the upstream on 2026-09 (see
 * `probes/probe-models.js`); the multiplier comes from the upstream catalog
 * `/v3/config` `credits` field — **not** from marketing docs, which are stale
 * (they advertise DeepSeek-V4-Flash as x0.06 while the catalog says x0.17).
 *
 * Two things the pricing depends on, in order of impact:
 *
 * 1. **The model id.** `hy4-preview-f` is x0.00 and bills 0 even on a 23k-token
 *    prompt; `hy4-preview` is x0.29 and bills on every request. They differ by a
 *    single `-f`, and the official client's UI labels *both* as "Hy4 preview" —
 *    the client actually uses `hy4-preview-f`. Pick the free one by default.
 * 2. **Prefix cache hits.** A repeated prompt prefix with a stable
 *    `prompt_cache_key` drops the billed amount by roughly an order of magnitude
 *    (measured: 0.68 → 0.04). That is why this gateway injects the key.
 *
 * Ids present in the catalog but returning `11102 service info not found` are
 * excluded: minimax-m2.5, glm-4.6v, glm-4.6, kimi-k2-thinking,
 * kimi-k2-instruct-taiji, deepseek-v3-1-volc, deepseek-v3-1, deepseek-r1-0528,
 * deepseek-v3-0324-taco-completion, completion-gf, default-1.1, default-1.2,
 * hunyuan-3b, hunyuan-7b-dense, codewise-completions.
 * `hunyuan-image-alpha*` returns 11103 (not a chat backend) and the
 * `codewise-*`/`completion-*` ids are completion models rather than chat models.
 */
const FREE_MODELS = [
  'auto',                     // resolves to hy4-preview-f upstream
  'hy4-preview-f',            // the id the official client actually uses
  'hy3',                      // x0.00
  'glm-5.3-flash', 'glm-5.1', 'glm-5.0-turbo',
  'kimi-k2.7', 'kimi-k2.6', 'kimi-k2.5',
  'minimax-m2.7',
  'deepseek-v4-flash', 'deepseek-v3.2',
];

const PAID_MODELS = [
  'deepseek-v4.1-flash',      // x0.03  lowest multiplier available
  'hy3-x',                    // x0.05
  'fast-model',               // x0.21
  'minimax-m3',               // x0.25
  'hy4-preview',              // x0.29  NOT the official "Hy4 preview"
  'deepseek-v3-2-volc',       // x0.29
  'deepseek-v4-pro',          // x0.51
  'deepseek-v3-1-lkeap',      // x0.52
  'deepseek-v3-0324-lkeap',   // x0.52
  'balanced-model',           // x0.65
  'glm-5v-turbo',             // x0.71
  'kimi-k2.8-preview',        // x0.77
  'glm-5.3',                  // x0.79
  'glm-5.2',                  // x0.79
  'deep-model',               // x1.20
  'kimi-k3',                  // x1.62
  'kimi-k3-1',                // x1.62  most expensive
  'deepseek-r1-0528-lkeap',   // catalog lists no multiplier
  'deepseek-v3-0324',         // catalog lists no multiplier
  'hunyuan-2.0-instruct',     // catalog lists no multiplier
];

const DEFAULT_MODELS = [...FREE_MODELS, ...PAID_MODELS];

/** Whether a model bills credits: "free" | "paid" | "unknown". */
function modelTier(id) {
  if (PAID_MODELS.includes(id)) return 'paid';
  if (FREE_MODELS.includes(id)) return 'free';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Live model registry
// ---------------------------------------------------------------------------
//
// The lists above are a snapshot. The upstream publishes new ids and retires old
// ones without notice, so the served list is built by merging the snapshot with
// the upstream catalog at startup and on an interval. `MODELS` is the merged
// result; `/v1/models` and the usage log both read from it.
//
// When the catalog cannot be reached, the last good result is loaded from disk,
// and failing that the snapshot is used. The gateway therefore always has a list
// — a network failure degrades the list, it does not empty it.

let MODELS = DEFAULT_MODELS.map(id => ({ id, tier: modelTier(id), ...modelLimits(id), source: 'curated' }));

/** Look up the merged entry for an id. */
function modelEntry(id) {
  return MODELS.find(m => m.id === id) || null;
}

/** The ids in served order. */
function modelIds() {
  return MODELS.map(m => m.id);
}

/** Context/output limits for an id, from the merged entry. */
function liveLimits(id) {
  const entry = modelEntry(id);
  if (entry) return { contextWindow: entry.contextWindow, maxOutputTokens: entry.maxOutputTokens };
  return modelLimits(id);
}

/**
 * Rebuild MODELS from the curated lists plus the upstream catalog.
 * Never throws: on any failure the previous list stays in place.
 */
async function refreshModelCatalog(cred, options) {
  const opts = options || {};
  const silent = opts.silent === true;

  let session = null;
  try {
    session = cred ? cred.auth() : null;
  } catch { /* no credential yet: fall back to cache/snapshot below */ }

  let fetched = { models: new Map(), error: 'no credential available' };
  if (session && session.accessToken) {
    fetched = await catalog.fetchCatalog({
      token: session.accessToken,
      uid: session.uid,
      domain: session.domain,
      upstream: CONFIG.upstream,
    });
  }

  const merged = catalog.mergeCatalog({
    // A user-supplied list wins outright: it is an explicit instruction, so the
    // catalog is not consulted for additions at all in that case.
    curated: CONFIG.explicitModelList || DEFAULT_MODELS,
    catalog: fetched.models,
    limits: (id) => modelLimits(id),
    tierOf: (id) => modelTier(id),
    defaultContext: catalog.DEFAULT_CONTEXT_TOKENS,
    defaultOutput: catalog.DEFAULT_OUTPUT_TOKENS,
  });

  if (fetched.error) {
    // Prefer the last good catalog over silently shrinking the list.
    const cached = catalog.readCache(CONFIG.catalogCacheFile);
    if (cached && cached.length) {
      MODELS = cached;
      if (!silent) log('catalog   : fetch failed (' + fetched.error + '), using cached list of ' + cached.length + ' models');
      return MODELS;
    }
    if (!silent) log('catalog   : fetch failed (' + fetched.error + '), using the built-in list of ' + merged.length + ' models');
    MODELS = merged;
    return MODELS;
  }

  const added = merged.filter(m => m.source === 'catalog');
  MODELS = merged;
  catalog.writeCache(CONFIG.catalogCacheFile, merged);

  if (!silent) {
    log('catalog   : ' + fetched.models.size + ' upstream, serving ' + merged.length
      + (added.length ? ' (+' + added.length + ' new: ' + added.map(m => m.id).join(', ') + ')' : ''));
  }
  return MODELS;
}

/** Start periodic catalog refreshes. Returns a stop function. */
function startCatalogRefresh(cred) {
  if (CONFIG.catalogRefreshMs <= 0) return () => {};

  const tick = () => {
    refreshModelCatalog(cred, { silent: false })
      .catch(e => log('catalog   : refresh error: ' + (e && e.message ? e.message : e)));
  };

  // Delay the first refresh slightly so startup (and its log banner) is not
  // blocked on the network; the curated list already serves requests by then.
  const first = setTimeout(tick, 1500);
  const timer = setInterval(tick, CONFIG.catalogRefreshMs);
  if (typeof timer.unref === 'function') timer.unref();

  return () => { clearTimeout(first); clearInterval(timer); };
}

const CONFIG = {
  host: pick(args.host, process.env.WORKBUDDY_GATEWAY_HOST, fileConfig.host, '127.0.0.1'),
  port: Number(pick(args.port, process.env.WORKBUDDY_GATEWAY_PORT, fileConfig.port, 8790)),
  apiKey: pick(args['api-key'], process.env.WORKBUDDY_GATEWAY_API_KEY, fileConfig.apiKey, ''),
  upstream: pick(args.upstream, process.env.WORKBUDDY_UPSTREAM, fileConfig.upstream, 'https://copilot.tencent.com'),
  authFile: pick(args['auth-file'], process.env.WORKBUDDY_AUTH_FILE, fileConfig.authFile, ''),
  logFile: pick(args.log, process.env.WORKBUDDY_GATEWAY_LOG, fileConfig.logFile, ''),
  desensitize: pick(fileConfig.desensitize, true) !== false && !args['no-desensitize'],
  retryOnBlock: pick(fileConfig.retryOnBlock, true) !== false && !args['no-retry'],
  exposeIdentity: !!args['expose-identity'] || fileConfig.exposeIdentity === true,
  debug: !!args.debug || process.env.WORKBUDDY_GATEWAY_DEBUG === '1' || fileConfig.debug === true,
  userAgent: pick(fileConfig.userAgent, 'workbuddy-gateway/1.0'),
  models: (() => {
    const raw = pick(args['model-list'], process.env.WORKBUDDY_MODELS, fileConfig.models);
    if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
    if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
    return DEFAULT_MODELS;
  })(),
};

// Whether the user pinned the model list. When they did, the upstream catalog is
// not consulted for additions — an explicit list is an instruction, not a seed.
CONFIG.explicitModelList = (() => {
  const raw = pick(args['model-list'], process.env.WORKBUDDY_MODELS, fileConfig.models);
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
  return null;
})();

// Catalog refresh interval in ms. 0 disables it (serving only the built-in list).
CONFIG.catalogRefreshMs = Number(pick(
  args['catalog-refresh'],
  process.env.WORKBUDDY_CATALOG_REFRESH,
  fileConfig.catalogRefreshMs,
  6 * 60 * 60 * 1000,
));
// Where the last good merged list is kept, so a restart with no network still
// serves the full list.
CONFIG.catalogCacheFile = pick(
  fileConfig.catalogCacheFile,
  path.join(path.dirname(CONFIG.logFile || DEFAULT_CONFIG_FILE), 'models-cache.json'),
);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(...parts) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = '[' + ts + '] ' + parts.join(' ') + '\n';
  process.stdout.write(line);
  if (CONFIG.logFile) {
    try {
      fs.mkdirSync(path.dirname(CONFIG.logFile), { recursive: true });
      fs.appendFileSync(CONFIG.logFile, line);
    } catch { /* logging must never break the proxy */ }
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function openaiError(message, type, status) {
  return { error: { message, type: type || 'upstream_error', code: status || 502 } };
}

function checkAuth(req) {
  if (!CONFIG.apiKey) return true;
  const auth = req.headers['authorization'] || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  return (bearer || req.headers['x-api-key'] || '') === CONFIG.apiKey;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('request body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Upstream
// ---------------------------------------------------------------------------

let credential = null;

/** Stops the periodic catalog refresh; replaced once startup reaches it. */
let stopCatalogRefresh = () => {};

/** Paid models already warned about, so the log is not flooded. */
const warnedPaid = new Set();

async function callUpstream(body) {
  const headers = await credential.ensureFresh();
  if (CONFIG.debug) {
    log('upstream request (' + JSON.stringify(body).length + ' bytes, '
      + countZeroWidth(body) + ' zero-width insertions)');
  }
  return fetch(CONFIG.upstream + '/v2/chat/completions', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}

/** Read an upstream stream to completion, forwarding deltas to `onDelta`. */
async function collect(upstreamRes, onDelta) {
  const acc = new StreamAccumulator(onDelta);
  for await (const part of upstreamRes.body) acc.push(part);
  return acc.end();
}

/**
 * Non-streaming path: aggregate, retrying with heavier desensitization when the
 * upstream rejects the request on security grounds.
 *
 * `ctx` carries { uid, sessionId }: the account uid is the hard isolation
 * segment of the prompt cache key, the session id is its conversation segment.
 */
async function completeOnce(payload, ctx) {
  const context = ctx || {};
  let lastErr = null;
  for (const aggressive of [false, true]) {
    if (aggressive && !CONFIG.retryOnBlock) break;
    const body = buildUpstreamBody(payload, aggressive, {
      desensitize: CONFIG.desensitize,
      uid: context.uid,
      conversationId: resolveConversationId(payload, context.sessionId),
    });
    if (CONFIG.debug) {
      log('attempt ' + (aggressive ? 2 : 1) + ' | aggressive=' + aggressive
        + ' | roles=' + body.messages.map(m => m.role).join(',')
        + ' | zero-width=' + countZeroWidth(body)
        + ' | cache_key=' + body.prompt_cache_key
        + ' | max_tokens=' + (body.max_tokens === undefined ? '(unset)' : body.max_tokens));
    }

    const res = await callUpstream(body);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (CONFIG.debug) log('  attempt ' + (aggressive ? 2 : 1) + ' HTTP ' + res.status + ' | ' + text.slice(0, 160).replace(/\s+/g, ' '));
      if (isBlockPayload(text) && !aggressive && CONFIG.retryOnBlock) {
        log('blocked by upstream security policy, retrying with heavier desensitization: ' + text.slice(0, 120).replace(/\s+/g, ' '));
        lastErr = { status: res.status, text };
        continue;
      }
      return { ok: false, status: res.status, text };
    }

    const acc = await collect(res, () => {});
    if (acc.blockText && !aggressive && CONFIG.retryOnBlock) {
      log('blocked mid-stream, retrying with heavier desensitization: ' + acc.blockText.slice(0, 120));
      lastErr = { status: 200, text: acc.blockText };
      continue;
    }
    if (acc.blockText) return { ok: false, status: 400, text: acc.blockText };
    return { ok: true, result: acc.response(), retried: aggressive, acc };
  }
  return { ok: false, status: (lastErr && lastErr.status) || 400, text: (lastErr && lastErr.text) || 'blocked' };
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async function handleChat(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch (e) { return sendJson(res, 400, openaiError('bad json: ' + e.message, 'invalid_request_error', 400)); }

  if (!Array.isArray(payload.messages) || !payload.messages.length) {
    return sendJson(res, 400, openaiError('messages is required', 'invalid_request_error', 400));
  }

  const model = payload.model || 'auto';
  const t0 = Date.now();

  // A paid model bills on every request; say so once per model so a long
  // session cannot quietly drain credits.
  if (modelTier(model) === 'paid' && !warnedPaid.has(model)) {
    warnedPaid.add(model);
    log('paid model in use | model=' + model
      + ' - billed per request (~0.17 on a 23k-token prompt).'
      + ' Free alternatives: hy4-preview-f / auto / deepseek-v4-flash');
  }

  // Outbound context: the account uid isolates the prompt cache key per account,
  // the session id keeps it stable inside one conversation.
  const ctx = {
    uid: (() => { try { return String(credential.account().uid || ''); } catch { return ''; } })(),
    sessionId: sessionIdFromHeaders(req.headers),
  };
  const cacheContext = () => ({
    desensitize: CONFIG.desensitize,
    uid: ctx.uid,
    conversationId: resolveConversationId(payload, ctx.sessionId),
  });
  if (CONFIG.debug) {
    log('inbound session | sessionId=' + (ctx.sessionId || '(none)')
      + ' | body.conversation_id='
      + (payload.conversation_id || payload.conversationId
        || (payload.metadata && (payload.metadata.conversation_id || payload.metadata.conversationId))
        || '(none)')
      + ' | max_completion_tokens='
      + (payload.max_completion_tokens === undefined ? '(none)' : payload.max_completion_tokens));
  }

  if (!payload.stream) {
    let out;
    try { out = await completeOnce(payload, ctx); }
    catch (e) { return sendJson(res, 502, openaiError('upstream unreachable: ' + e.message, 'upstream_error', 502)); }
    if (!out.ok) {
      log('upstream failed | model=' + model + ' | HTTP ' + out.status + ' | ' + String(out.text).slice(0, 200).replace(/\s+/g, ' '));
      return sendJson(res, out.status, openaiError(String(out.text).slice(0, 500), 'upstream_error', out.status));
    }
    const r = out.result;
    const ru = r.usage || {};
    log('chat | model=' + model + ' | non-stream' + (out.retried ? ' | recovered on retry' : '')
      + ' | ' + (Date.now() - t0) + 'ms | finish=' + r.choices[0].finish_reason
      + ' | tokens=' + ru.total_tokens
      + ' | credit=' + (ru.credit === undefined ? '?' : ru.credit)
      + ' | cache_hit=' + (ru.prompt_cache_hit_tokens === undefined ? '?' : ru.prompt_cache_hit_tokens));
    return sendJson(res, 200, r);
  }

  // Streaming. The answer is buffered before being written so that a mid-stream
  // block can still be retried instead of emitting half a response.
  let upstreamRes;
  let body = buildUpstreamBody(payload, false, cacheContext());
  try { upstreamRes = await callUpstream(body); }
  catch (e) { return sendJson(res, 502, openaiError('upstream unreachable: ' + e.message, 'upstream_error', 502)); }

  let retried = false;
  if (!upstreamRes.ok) {
    const text = await upstreamRes.text().catch(() => '');
    if (isBlockPayload(text) && CONFIG.retryOnBlock) {
      log('blocked by upstream security policy (HTTP), retrying with heavier desensitization: ' + text.slice(0, 120).replace(/\s+/g, ' '));
      try {
        body = buildUpstreamBody(payload, true, cacheContext());
        upstreamRes = await callUpstream(body);
        retried = true;
      } catch (e) { return sendJson(res, 502, openaiError('upstream unreachable: ' + e.message, 'upstream_error', 502)); }
    }
    if (!upstreamRes.ok) {
      const t2 = await upstreamRes.text().catch(() => '');
      log('upstream failed | model=' + model + ' | HTTP ' + upstreamRes.status + ' | ' + t2.slice(0, 200).replace(/\s+/g, ' '));
      return sendJson(res, upstreamRes.status, openaiError(t2.slice(0, 500), 'upstream_error', upstreamRes.status));
    }
  }

  const pending = [];
  let sawAny = false;
  const sink = (delta) => { pending.push(delta); if (!delta.error) sawAny = true; };

  let acc;
  try { acc = await collect(upstreamRes, sink); }
  catch (e) {
    log('stream forwarding interrupted: ' + e.message);
    acc = { blockText: null, finishReason: 'error' };
  }

  if (acc.blockText && !retried && CONFIG.retryOnBlock && !sawAny) {
    log('blocked mid-stream, retrying with heavier desensitization: ' + String(acc.blockText).slice(0, 120));
    pending.length = 0;
    try {
      const res2 = await callUpstream(buildUpstreamBody(payload, true, cacheContext()));
      if (res2.ok) { retried = true; acc = await collect(res2, sink); }
    } catch (e) { log('retry failed: ' + e.message); }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  const chunkId = 'chatcmpl-' + Math.random().toString(16).slice(2, 14);
  const resolvedModel = (acc && acc.model) || model;

  if (acc && acc.blockText) {
    res.write(sseFrame({ error: { message: String(acc.blockText).slice(0, 400), type: 'content_policy_blocked' } }));
  } else {
    res.write(sseFrame(makeChunk(chunkId, resolvedModel, { role: 'assistant', content: '' })));
    for (const d of pending) {
      if (d.error) res.write(sseFrame(d));
      else res.write(sseFrame(makeChunk(chunkId, resolvedModel, d)));
    }
    res.write(sseFrame(makeChunk(chunkId, resolvedModel, {}, (acc && acc.finishReason) || 'stop')));
    if (acc && acc.usage) res.write(sseFrame(makeUsageChunk(chunkId, resolvedModel, acc.usage)));
  }
  res.write(SSE_DONE);
  res.end();

  const uu = (acc && acc.usage) || {};
  log('chat | model=' + model + ' | stream' + (retried ? ' | recovered on retry' : '')
    + ' | ' + (Date.now() - t0) + 'ms | finish=' + (acc && acc.finishReason)
    + ' | tokens=' + uu.total_tokens
    + ' | credit=' + (uu.credit === undefined ? '?' : uu.credit)
    + ' | cache_hit=' + (uu.prompt_cache_hit_tokens === undefined ? '?' : uu.prompt_cache_hit_tokens));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  try {
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      let cred;
      try { cred = credential.summary(); } catch (e) { cred = { error: e.message }; }
      return sendJson(res, 200, {
        status: 'ok',
        service: 'workbuddy-gateway',
        upstream: CONFIG.upstream,
        node: process.version,
        models: modelIds(),
        desensitize: CONFIG.desensitize,
        retryOnBlock: CONFIG.retryOnBlock,
        credential: cred,
      });
    }

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      if (!checkAuth(req)) return sendJson(res, 401, openaiError('invalid api key', 'auth_error', 401));
      return sendJson(res, 200, {
        object: 'list',
        // Served from the merged registry: the curated list plus whatever the
        // upstream catalog currently offers (see refreshModelCatalog).
        data: MODELS.map(m => ({
          id: m.id,
          object: 'model',
          created: 1700000000,
          owned_by: 'workbuddy',
          // measured: free = credit is always 0, paid = billed per request
          tier: m.tier,
          // Context and output caps, so a client does not have to hardcode one
          // value for every model. null means "not measured", not "unlimited".
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          // "catalog" marks ids that came from the live upstream list rather than
          // the built-in snapshot, which makes a newly published model visible.
          source: m.source,
        })),
      });
    }

    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      if (!checkAuth(req)) return sendJson(res, 401, openaiError('invalid api key', 'auth_error', 401));
      return await handleChat(req, res);
    }

    sendJson(res, 404, openaiError('no such route: ' + url.pathname, 'invalid_request_error', 404));
  } catch (e) {
    log('uncaught error: ' + (e && e.stack || e));
    if (!res.headersSent) sendJson(res, 500, openaiError(String(e && e.message || e), 'internal_error', 500));
    else res.end();
  }
});

function main() {
  // --detach: re-launch the same command in the background and return at once.
  if (args.detach) {
    const { spawn } = require('child_process');
    const childArgs = process.argv.slice(2).filter(a => a !== '--detach');
    const child = spawn(process.execPath, [__filename, ...childArgs], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
    });
    const pidFile = CONFIG.logFile
      ? path.join(path.dirname(CONFIG.logFile), 'gateway.pid')
      : path.join(os.homedir(), '.workbuddy-gateway', 'gateway.pid');
    try {
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      fs.writeFileSync(pidFile, String(child.pid));
    } catch { /* the PID is printed below either way */ }
    child.unref();
    process.stdout.write('[workbuddy-gateway] detached, pid ' + child.pid
      + ' (pid file: ' + pidFile + ')\n');
    process.stdout.write('[workbuddy-gateway] listening on http://' + CONFIG.host + ':' + CONFIG.port + '\n');
    process.stdout.write('[workbuddy-gateway] stop with: ' + (process.platform === 'win32'
      ? 'taskkill /PID ' + child.pid + ' /T /F'
      : 'kill ' + child.pid) + '\n');
    process.exit(0);
  }

  try {
    credential = new Credential({
      authFile: CONFIG.authFile || undefined,
      upstream: CONFIG.upstream,
      userAgent: CONFIG.userAgent,
      exposeIdentity: CONFIG.exposeIdentity,
      onLog: log,
    });
  } catch (e) {
    log('startup failed: ' + e.message);
    process.exit(1);
  }

  const s = credential.summary();
  log('==== workbuddy-gateway ====');
  log('upstream  : ' + CONFIG.upstream);
  log('auth file : ' + s.file);
  log('account   : domain=' + s.domain
    + (s.token_expired ? ' | token expired (will refresh)' : ' | token valid to ' + s.token_expires_at));
  log('free models : ' + MODELS.filter(m => m.tier === 'free').map(m => m.id).join(', '));
  log('paid models : ' + MODELS.filter(m => m.tier === 'paid').map(m => m.id).join(', '));
  if (MODELS.some(m => m.source === 'catalog')) {
    log('from catalog: ' + MODELS.filter(m => m.source === 'catalog').map(m => m.id).join(', '));
  }
  log('catalog   : ' + (CONFIG.catalogRefreshMs > 0
    ? 'refresh every ' + Math.round(CONFIG.catalogRefreshMs / 60000) + ' min'
    : 'disabled (serving the built-in list)'));
  log('filter    : desensitize=' + (CONFIG.desensitize ? 'on' : 'off') + ' blockRetry=' + (CONFIG.retryOnBlock ? 'on' : 'off'));
  log('auth      : ' + (CONFIG.apiKey ? 'api key required' : 'no api key (local use only)'));
  log('listening : http://' + CONFIG.host + ':' + CONFIG.port);

  // Merge the upstream catalog in the background, started after the banner so
  // startup never blocks on the network: the built-in list already serves
  // requests, and the merge announces itself on its own log line when it lands.
  stopCatalogRefresh = startCatalogRefresh(credential);

  server.listen(CONFIG.port, CONFIG.host, () => log('ready. Ctrl+C to exit.'));
  server.on('error', (e) => { log('listen failed: ' + e.message); process.exit(1); });
  process.on('SIGINT', () => { stopCatalogRefresh(); log('bye'); process.exit(0); });
  process.on('SIGTERM', () => { stopCatalogRefresh(); log('bye'); process.exit(0); });
}

main();
