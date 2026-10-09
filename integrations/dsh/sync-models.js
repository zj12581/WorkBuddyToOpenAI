#!/usr/bin/env node
'use strict';
/**
 * Sync the DeepSeek Harness provider block with the gateway's live model list.
 *
 *   node integrations/dsh/sync-models.js                 # write settings.yaml
 *   node integrations/dsh/sync-models.js --dry-run       # print, change nothing
 *   node integrations/dsh/sync-models.js --probe         # re-measure reasoning first
 *   node integrations/dsh/sync-models.js --gateway URL   # non-default gateway
 *
 * Why this exists
 * ---------------
 * DSH does not discover models: `llm-pi-ai` providers list every model explicitly,
 * each with a `contextWindow` and a `reasoningEfforts` map. The gateway, by
 * contrast, now tracks the upstream catalog automatically and serves whatever it
 * currently offers. Without something to bridge them, DSH keeps a frozen list and
 * a model added upstream never appears in it.
 *
 * This reads the gateway's `/v1/models` — the single source of truth for ids,
 * tiers and context windows — and rewrites only the `workbuddy` provider's model
 * list in `~/.dsh/settings.yaml`. Everything else in the file is preserved
 * byte-for-byte, including comments, because the edit is a line-level splice
 * rather than a YAML round-trip (a round-trip would drop every comment).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SETTINGS = path.join(DSH_HOME, 'settings.yaml');
const PROVIDER = 'workbuddy';

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
function valueOf(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const DRY_RUN = has('--dry-run');
const DO_PROBE = has('--probe');
const GATEWAY = valueOf('--gateway', process.env.WORKBUDDY_GATEWAY_URL || 'http://127.0.0.1:8790');
const API_KEY = valueOf('--api-key', process.env.WORKBUDDY_GATEWAY_API_KEY || 'workbuddy-local');

function say(msg) { process.stdout.write(msg + '\n'); }
function die(msg) { process.stderr.write('[sync-models] ' + msg + '\n'); process.exit(1); }

// ---------------------------------------------------------------------------
// gateway
// ---------------------------------------------------------------------------

async function fetchModels() {
  let res;
  try {
    res = await fetch(GATEWAY + '/v1/models', { headers: { Authorization: 'Bearer ' + API_KEY } });
  } catch (e) {
    die('cannot reach the gateway at ' + GATEWAY + ': ' + e.message
      + '\n  Start it with scripts/setup.ps1 (Windows) or scripts/setup.sh,');
  }
  if (res.status === 401) die('the gateway rejected the API key (HTTP 401). Pass --api-key.');
  if (!res.ok) die('the gateway answered HTTP ' + res.status);
  const json = await res.json();
  const data = Array.isArray(json.data) ? json.data : [];
  if (!data.length) die('the gateway returned no models');
  return data;
}

/**
 * Ask the gateway whether a model emits a reasoning channel.
 *
 * DSH needs to know this per model. Declaring levels for a model with no
 * reasoning channel makes DSH send a `reasoning_effort` the model ignores, and
 * declaring `false` for one that does reason hides the capability. So it is
 * measured rather than guessed.
 */
async function probeReasoning(gatewayUrl, apiKey, model) {
  try {
    const res = await fetch((gatewayUrl || GATEWAY).replace(/\/+$/, '') + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (apiKey || API_KEY) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Think step by step: what is 17 * 23?' }],
        stream: false,
        max_tokens: 512,
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const msg = (json.choices || [{}])[0].message || {};
    const text = String(msg.reasoning_content || '');
    const tokens = json.usage && json.usage.completion_tokens_details
      ? Number(json.usage.completion_tokens_details.reasoning_tokens || 0)
      : 0;
    return text.length > 0 || tokens > 0;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/**
 * The thinking levels DSH will offer.
 *
 * `off` maps to null rather than to the string "off": DSH sends the mapped value
 * as `reasoning_effort`, and the DeepSeek V4 family rejects the literal "off"
 * with HTTP 400 / 11150. An empty value means "send nothing".
 *
 * `xhigh` maps to `high` because the upstream accepts no level above high.
 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

const ANCHOR_NAME = 'wbThinking';

/**
 * The reasoning block for one model.
 *
 * The first reasoning model in the list defines the anchor (`&wbThinking`) and
 * carries the levels; every later one aliases it (`*wbThinking`) with nothing
 * beneath — an alias followed by indented keys is not valid YAML.
 */
function renderThinkingBlock(indent, defineAnchor) {
  const pad = ' '.repeat(indent);
  if (!defineAnchor) return [pad + 'reasoningEfforts: *' + ANCHOR_NAME];
  return [
    pad + 'reasoningEfforts: &' + ANCHOR_NAME,
    pad + '  off:',
    pad + '  minimal: minimal',
    pad + '  low: low',
    pad + '  medium: medium',
    pad + '  high: high',
    pad + '  xhigh: high',
  ];
}

/** Display name for a model: tier marker, then a readable label. */
function displayName(entry, reasoning) {
  const tier = entry.tier === 'free' ? '★免费' : '⚠计费';
  const label = entry.id;
  return tier + ' ' + label;
}

/**
 * Render the `models:` list for the provider.
 * @param entries   gateway entries, in served order
 * @param reasoning Map<id, boolean|null> - null means "not measured"
 */
function renderModels(entries, reasoning) {
  const out = [];
  out.push('        # 由 integrations/dsh/sync-models.js 生成 —— 手动改动会在下次同步时丢失。');
  out.push('        # 模型清单、上下文长度来自网关 /v1/models;思考链能力为实测结果。');
  let anchorUsed = false;
  for (const entry of entries) {
    const thinks = reasoning.get(entry.id);
    out.push('        - id: ' + entry.id);
    out.push('          name: ' + displayName(entry, thinks));
    out.push('          contextWindow: ' + entry.contextWindow);
    if (thinks === true) {
      // First reasoning model defines the anchor; the rest alias it.
      out.push(...renderThinkingBlock(10, !anchorUsed));
      anchorUsed = true;
    } else if (thinks === false) {
      out.push('          reasoningEfforts: false');
    }
    // thinks === null: capability unknown, so declare nothing rather than guess.
  }
  return out;
}

// ---------------------------------------------------------------------------
// settings.yaml splice
// ---------------------------------------------------------------------------

/**
 * Replace the `models:` block of the workbuddy provider, preserving every other
 * line of the file.
 *
 * A YAML round-trip would be simpler but would delete all comments, including the
 * ones documenting the reasoning-effort trap and the compaction settings.
 * Splicing by line keeps the user's file theirs.
 *
 * Two details that are easy to get wrong and were:
 *
 *  - The file may have CRLF endings. Splitting on '\n' alone leaves a trailing
 *    '\r' on every line, which breaks the anchored patterns below and made an
 *    earlier version of this function swallow the rest of the file.
 *  - The block ends at the next line whose indentation is *less than* the models
 *    key's own. Looking for a fixed indent misses top-level keys like
 *    `agent-default-model:` (zero indent), which is how the previous version ran
 *    to EOF.
 */
function spliceSettings(text, modelLines, settingsFile) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  const indentOf = (line) => (line.match(/^[ \t]*/) || [''])[0].length;
  const isBlank = (line) => line.trim() === '';

  const where = settingsFile || SETTINGS;

  // `    workbuddy:` — a provider key under `  providers:`
  let providerLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{4}workbuddy:\s*$/.test(lines[i])) { providerLine = i; break; }
  }
  if (providerLine < 0) die('could not find a workbuddy provider in ' + where);
  const providerIndent = indentOf(lines[providerLine]);

  // Its `models:` key, which must be indented deeper than the provider.
  let modelsLine = -1;
  for (let i = providerLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;
    if (indentOf(line) <= providerIndent) break;         // left the provider
    if (/^\s*models:\s*$/.test(line)) { modelsLine = i; break; }
  }
  if (modelsLine < 0) die('the workbuddy provider has no models: key in ' + where);
  const modelsIndent = indentOf(lines[modelsLine]);

  // The block is every following line indented deeper than `models:`, plus blank
  // lines in between. The first non-blank line at or below its indent ends it.
  let blockEnd = lines.length;
  for (let i = modelsLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;
    if (indentOf(line) <= modelsIndent) { blockEnd = i; break; }
  }
  // Do not absorb the blank lines that separate the block from what follows.
  while (blockEnd > modelsLine + 1 && isBlank(lines[blockEnd - 1])) blockEnd--;

  const before = lines.slice(0, modelsLine + 1);
  const after = lines.slice(blockEnd);
  return {
    text: before.concat(modelLines, after).join(eol),
    replacedFrom: modelsLine + 2,
    replacedTo: blockEnd,
  };
}

// ---------------------------------------------------------------------------
// reusable entry point
// ---------------------------------------------------------------------------

/**
 * Run a sync.
 *
 * Exported so the DSH plugin (`plugin-workbuddy-models`) can call it from a
 * slash command; the CLI below is a thin wrapper. Every step reports through
 * `onLine` so both callers see the same narration.
 *
 * @param options {
 *   gateway?, apiKey?, settings?, dshHome?,
 *   dryRun?, probe?, onLine?
 * }
 * @returns {Promise<{models, added, removed, wrote, backup, replacedFrom, replacedTo}>}
 */
async function sync(options) {
  const opts = options || {};
  const gatewayUrl = (opts.gateway || GATEWAY).replace(/\/+$/, '');
  const apiKey = opts.apiKey || API_KEY;
  const settingsFile = opts.settings || SETTINGS;
  const dshHome = opts.dshHome || DSH_HOME;
  const dryRun = !!opts.dryRun;
  const forceProbe = !!opts.probe;
  const emit = typeof opts.onLine === 'function' ? opts.onLine : () => {};

  const loadYaml = () => {
    const candidates = [
      path.join(dshHome, 'profiles', 'node_modules', 'js-yaml'),
      'js-yaml',
    ];
    for (const c of candidates) {
      try { return require(c); } catch { /* try next */ }
    }
    throw new Error('js-yaml not found; expected it under ' + path.join(dshHome, 'profiles', 'node_modules'));
  };

  emit('gateway : ' + gatewayUrl);

  // --- fetch the gateway's list ---
  let res;
  try {
    res = await fetch(gatewayUrl + '/v1/models', { headers: { Authorization: 'Bearer ' + apiKey } });
  } catch (e) {
    throw new Error('cannot reach the gateway at ' + gatewayUrl + ': ' + e.message);
  }
  if (res.status === 401) throw new Error('the gateway rejected the API key (HTTP 401)');
  if (!res.ok) throw new Error('the gateway answered HTTP ' + res.status);
  const json = await res.json();
  const models = Array.isArray(json.data) ? json.data : [];
  if (!models.length) throw new Error('the gateway returned no models');
  for (const m of models) {
    // A model without a context window would produce an invalid DSH entry.
    if (!Number.isFinite(Number(m.contextWindow)) || Number(m.contextWindow) <= 0) {
      m.contextWindow = 1000000;
    }
  }
  emit('models  : ' + models.length + ' from the gateway');

  // --- read the previous settings, for reasoning capability and the old id set ---
  const yaml = loadYaml();
  const previous = new Map();
  let previousIds = [];
  try {
    const doc = yaml.load(fs.readFileSync(settingsFile, 'utf8'));
    const wb = doc && doc['llm-pi-ai'] && doc['llm-pi-ai'].providers && doc['llm-pi-ai'].providers[PROVIDER];
    for (const m of (wb && wb.models) || []) {
      previousIds.push(m.id);
      if (m.reasoningEfforts === false) previous.set(m.id, false);
      else if (m.reasoningEfforts && typeof m.reasoningEfforts === 'object') previous.set(m.id, true);
    }
  } catch { /* no readable previous file: everything is probed or unknown */ }

  const added = models.map(m => m.id).filter(id => !previousIds.includes(id));
  const removed = previousIds.filter(id => !models.some(m => m.id === id));

  // --- reasoning capability ---
  const reasoning = new Map();
  const needProbe = models.map(m => m.id).filter(id => forceProbe || !previous.has(id));
  if (needProbe.length) {
    emit('probing : ' + needProbe.length + ' model(s) for a reasoning channel');
    let done = 0;
    for (const id of needProbe) {
      const thinks = await probeReasoning(gatewayUrl, apiKey, id);
      reasoning.set(id, thinks);
      done++;
      emit('          [' + done + '/' + needProbe.length + '] ' + id.padEnd(22)
        + (thinks === true ? 'thinks' : thinks === false ? 'no reasoning' : 'unmeasurable'));
    }
  }
  for (const m of models) if (!reasoning.has(m.id)) reasoning.set(m.id, previous.get(m.id) ?? null);

  const modelLines = renderModels(models, reasoning);

  if (dryRun) {
    emit('');
    emit('--- would write these lines to ' + settingsFile + ' ---');
    modelLines.forEach(l => emit(l));
    emit('');
    emit('(dry run: nothing changed)');
    return { models, added, removed, wrote: false, backup: null, modelLines };
  }

  // --- write, with a backup and a parse check ---
  const original = fs.readFileSync(settingsFile, 'utf8');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = settingsFile + '.bak-sync-' + stamp;
  fs.writeFileSync(backup, original);
  emit('backup  : ' + path.basename(backup));

  const spliced = spliceSettings(original, modelLines, settingsFile);
  fs.writeFileSync(settingsFile, spliced.text);
  emit('wrote   : ' + settingsFile + ' (replaced lines ' + spliced.replacedFrom + '-' + spliced.replacedTo + ')');

  try {
    const doc = yaml.load(fs.readFileSync(settingsFile, 'utf8'));
    const wb = doc['llm-pi-ai'].providers[PROVIDER];
    if (!wb || !wb.models) throw new Error('the workbuddy provider lost its models');
    emit('verify  : parses, ' + wb.models.length + ' models');
  } catch (e) {
    fs.writeFileSync(settingsFile, original);
    throw new Error('the result did not parse (' + e.message + '); restored the original file');
  }

  const unknown = [...reasoning.entries()].filter(([, v]) => v === null).map(([k]) => k);
  if (unknown.length) {
    emit('');
    emit('note    : reasoning capability unknown for: ' + unknown.join(', '));
    emit('          no reasoningEfforts written for those, so DSH will not send one.');
  }

  return {
    models, added, removed, wrote: true, backup,
    replacedFrom: spliced.replacedFrom,
    replacedTo: spliced.replacedTo,
    unknownReasoning: unknown,
  };
}

module.exports = { sync, renderModels, spliceSettings, probeReasoning, renderThinkingBlock };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const result = await sync({
      gateway: GATEWAY,
      apiKey: API_KEY,
      dryRun: DRY_RUN,
      probe: DO_PROBE,
      onLine: say,
    });
    if (!DRY_RUN) {
      if (result.added.length) say('added   : ' + result.added.join(', '));
      if (result.removed.length) say('removed : ' + result.removed.join(', '));
      say('');
      say('Restart DSH for the change to take effect.');
    }
  })().catch((e) => die(e && e.message ? e.message : String(e)));
}
