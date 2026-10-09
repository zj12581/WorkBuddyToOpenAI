'use strict';
/**
 * Live model catalog.
 *
 * The curated lists in this repository (FREE_MODELS, PAID_MODELS, MODEL_LIMITS)
 * are a snapshot: the upstream adds and retires model ids without notice, and a
 * gateway that only knows the snapshot keeps serving yesterday's list forever.
 * This module asks the upstream what it currently offers and merges that with the
 * curated knowledge, so a newly published model shows up without a code change.
 *
 * Merge rules, in order:
 *
 *   1. Curated ids are always kept, even when the catalog omits them.
 *      `hy4-preview-f`, for instance, is what the official client sends but the
 *      catalog lists only `hy4-preview`. Dropping it would break the documented
 *      default.
 *
 *   2. A catalog id is added only when it looks like a chat model. The catalog
 *      mixes in completion and image backends (`codewise-*`,
 *      `hunyuan-image-alpha*`) that answer a chat request with 11103 or produce
 *      something that is not a conversation. Those are filtered by id shape, and
 *      by the `supportsToolCall` / `supportsReasoning` flags when present.
 *
 *   3. Verified-dead ids are never added. The catalog advertises 18 ids the
 *      backend answers with `11102 service info not found`; their catalog entries
 *      are indistinguishable from working ones (same flags, same metadata), so
 *      the only reliable filter is a list of ids that were actually tried. See
 *      KNOWN_DEAD below.
 *
 *   4. Metadata comes from the catalog when present: maxInputTokens and
 *      maxOutputTokens. When absent, the context defaults to the configured
 *      default (1M), matching the ids added most recently.
 *
 * The catalog request needs the official client's user agent and the `x-product`
 * header; a plain request is rejected.
 */

const fs = require('fs');
const path = require('path');

const CATALOG_PATH = '/v3/config';
const CATALOG_TIMEOUT_MS = 15_000;
const DEFAULT_CONTEXT_TOKENS = 1_000_000;
const DEFAULT_OUTPUT_TOKENS = 32_000;

/** The user agent the upstream expects for catalog reads. */
const CATALOG_USER_AGENT = 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1';

/**
 * Ids the catalog advertises but the backend does not serve.
 *
 * Measured 2026-09: each answers `11102 service info not found`. Their catalog
 * entries carry the same capability flags and metadata as working models, so
 * there is no structural way to filter them — this list is empirical.
 *
 * Ids already excluded by NON_CHAT_PATTERNS are deliberately absent: listing them
 * here as well would hide a pattern that stopped working.
 */
const KNOWN_DEAD = new Set([
  'hy4-preview-x',
  'minimax-m2.5',
  'glm-4.6v',
  'glm-4.6',
  'deepseek-v3-1-volc',
  'deepseek-v3-1',
  'kimi-k2-instruct-taiji',
  'kimi-k2-thinking',
  'hunyuan-3b',
  'hunyuan-7b-dense',
  'deepseek-r1-0528',
]);

/**
 * Id patterns that are not conversation models even though they answer.
 *
 * `codewise-*` and the image backends return HTTP 200 with a few hundred tokens
 * of completion or an image reference. They are not selectable as chat models and
 * would confuse a client's model picker.
 */
const NON_CHAT_PATTERNS = [
  /^codewise-/,
  /^completion-/,
  /-completion$/,
  /^hunyuan-image/,
  /^default-\d/,
];

/** Whether an id looks like a chat model worth exposing. */
function isChatModelId(id, entry) {
  if (KNOWN_DEAD.has(id)) return false;
  for (const re of NON_CHAT_PATTERNS) if (re.test(id)) return false;
  // When the catalog states capabilities, require at least one of them.
  if (entry) {
    const flags = ['supportsToolCall', 'supportsReasoning', 'supportsImages'];
    const stated = flags.filter((f) => typeof entry[f] === 'boolean');
    if (stated.length && !stated.some((f) => entry[f] === true)) return false;
  }
  return true;
}

/** Find the model array anywhere in the catalog payload. */
function extractModels(payload) {
  let found = null;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6 || found) return;
    if (Array.isArray(node.models) && node.models.length && node.models[0] && node.models[0].id) {
      found = node.models;
      return;
    }
    for (const key of Object.keys(node)) {
      walk(node[key], depth + 1);
      if (found) return;
    }
  };
  walk(payload, 0);
  return found;
}

/**
 * Fetch the upstream catalog.
 * @returns {Promise<Map<string, object>>} id -> catalog entry, empty on failure.
 */
async function fetchCatalog(options) {
  const opts = options || {};
  const headers = {
    Accept: 'application/json',
    Authorization: 'Bearer ' + opts.token,
    'X-User-Id': String(opts.uid || ''),
    'X-Domain': opts.domain || 'www.workbuddy.cn',
    'X-Product': 'SaaS',
    'User-Agent': CATALOG_USER_AGENT,
  };
  const base = opts.upstream || 'https://copilot.tencent.com';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  try {
    const res = await fetch(base + CATALOG_PATH, { headers, signal: controller.signal });
    if (!res.ok) return { models: new Map(), error: 'HTTP ' + res.status };
    const payload = await res.json();
    const arr = extractModels(payload);
    if (!arr) return { models: new Map(), error: 'no models array in the catalog response' };
    const models = new Map();
    for (const entry of arr) {
      if (entry && typeof entry.id === 'string' && entry.id) models.set(entry.id, entry);
    }
    return { models, error: null };
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timed out' : e.message;
    return { models: new Map(), error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge the curated list with a fetched catalog.
 *
 * @param params {
 *   curated:   readonly string[]  ids that are always kept
 *   catalog:   Map<string, object>
 *   limits:    (id) => { contextWindow, maxOutputTokens }  curated metadata
 *   tierOf:    (id) => 'free' | 'paid' | 'unknown'
 *   defaultContext, defaultOutput
 * }
 * @returns {Array<{id, tier, contextWindow, maxOutputTokens, source}>}
 */
function mergeCatalog(params) {
  const curated = params.curated || [];
  const catalog = params.catalog || new Map();
  const limitsOf = params.limits || (() => ({ contextWindow: null, maxOutputTokens: null }));
  const tierOf = params.tierOf || (() => 'unknown');
  const defaultContext = params.defaultContext || DEFAULT_CONTEXT_TOKENS;
  const defaultOutput = params.defaultOutput || DEFAULT_OUTPUT_TOKENS;

  const out = [];
  const seen = new Set();

  const add = (id, source) => {
    if (seen.has(id)) return;
    seen.add(id);
    const meta = limitsOf(id) || {};
    const entry = catalog.get(id);
    // Prefer curated limits (measured), then the catalog, then the default.
    const context = meta.contextWindow
      || positiveInt(entry && entry.maxInputTokens)
      || defaultContext;
    const output = meta.maxOutputTokens
      || positiveInt(entry && entry.maxOutputTokens)
      || defaultOutput;
    out.push({
      id,
      tier: tierOf(id),
      contextWindow: context,
      maxOutputTokens: output,
      source,
    });
  };

  // 1. curated first, in their declared order
  for (const id of curated) add(id, 'curated');

  // 2. then anything new the catalog offers, in catalog order
  for (const [id, entry] of catalog) {
    if (seen.has(id)) continue;
    if (!isChatModelId(id, entry)) continue;
    add(id, 'catalog');
  }

  return out;
}

function positiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * A small on-disk cache so a restart does not depend on the network being up.
 * Best-effort: any failure is ignored, the caller falls back to the curated list.
 */
function readCache(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    if (!json || !Array.isArray(json.models)) return null;
    return json.models;
  } catch {
    return null;
  }
}

function writeCache(file, models) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), models }, null, 2));
  } catch { /* best effort */ }
}

module.exports = {
  fetchCatalog,
  mergeCatalog,
  extractModels,
  isChatModelId,
  readCache,
  writeCache,
  KNOWN_DEAD,
  NON_CHAT_PATTERNS,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
  CATALOG_USER_AGENT,
  CATALOG_PATH,
};
