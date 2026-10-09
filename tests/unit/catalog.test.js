/**
 * Unit tests for the live model catalog. No network, no account required.
 *
 *   node --test tests/unit
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const catalog = require('../../lib/catalog');

// ---------------------------------------------------------------------------
// filtering
// ---------------------------------------------------------------------------

test('isChatModelId: known-dead ids are rejected despite plausible metadata', () => {
  // The upstream advertises these with the same flags as working models; each
  // answers 11102 when called. Only the measured list distinguishes them.
  for (const id of ['minimax-m2.5', 'glm-4.6', 'glm-4.6v', 'kimi-k2-thinking',
    'deepseek-v3-1', 'deepseek-v3-1-volc', 'hy4-preview-x']) {
    assert.strictEqual(
      catalog.isChatModelId(id, { supportsToolCall: true, supportsReasoning: true }),
      false,
      id + ' must be filtered'
    );
  }
});

test('isChatModelId: completion and image backends are rejected by id shape', () => {
  for (const id of ['codewise-rewrite', 'codewise-jump', 'completion-gf',
    'deepseek-v3-0324-taco-completion', 'hunyuan-image-alpha', 'default-1.1']) {
    assert.strictEqual(catalog.isChatModelId(id, {}), false, id + ' must be filtered');
  }
});

test('isChatModelId: real chat models pass', () => {
  for (const id of ['auto', 'hy4-preview-f', 'space-bunny', 'hy3-b', 'deepseek-v4-flash']) {
    assert.strictEqual(catalog.isChatModelId(id, { supportsToolCall: true }), true, id + ' must pass');
  }
});

test('isChatModelId: an id with no catalog entry still passes when not known-dead', () => {
  // hy4-preview-f is absent from the catalog entirely — it is the id the official
  // client sends. Curated ids must never be dropped for lack of catalog metadata.
  assert.strictEqual(catalog.isChatModelId('hy4-preview-f', undefined), true);
  assert.strictEqual(catalog.isChatModelId('brand-new-model', undefined), true);
});

test('isChatModelId: explicit all-false capabilities are respected', () => {
  assert.strictEqual(
    catalog.isChatModelId('some-model', { supportsToolCall: false, supportsReasoning: false, supportsImages: false }),
    false
  );
});

// ---------------------------------------------------------------------------
// merging
// ---------------------------------------------------------------------------

function merge(overrides) {
  return catalog.mergeCatalog(Object.assign({
    curated: ['auto', 'hy4-preview-f'],
    catalog: new Map(),
    limits: () => ({ contextWindow: null, maxOutputTokens: null }),
    tierOf: () => 'unknown',
  }, overrides || {}));
}

test('mergeCatalog: curated ids come first, in their declared order', () => {
  const out = merge({
    catalog: new Map([['zzz-new', { supportsToolCall: true }]]),
  });
  assert.deepStrictEqual(out.map(m => m.id), ['auto', 'hy4-preview-f', 'zzz-new']);
  assert.strictEqual(out[0].source, 'curated');
  assert.strictEqual(out[2].source, 'catalog');
});

test('mergeCatalog: new catalog ids are appended', () => {
  const out = merge({
    catalog: new Map([
      ['space-bunny', { maxInputTokens: 1000000, maxOutputTokens: 128000, supportsToolCall: true }],
    ]),
  });
  const added = out.find(m => m.id === 'space-bunny');
  assert.ok(added, 'the new id must be present');
  assert.strictEqual(added.contextWindow, 1000000);
  assert.strictEqual(added.maxOutputTokens, 128000);
  assert.strictEqual(added.source, 'catalog');
});

test('mergeCatalog: a model missing maxInputTokens defaults to the configured context', () => {
  const out = merge({
    catalog: new Map([['no-meta-model', { supportsToolCall: true }]]),
    defaultContext: 1000000,
    defaultOutput: 32000,
  });
  const m = out.find(x => x.id === 'no-meta-model');
  assert.strictEqual(m.contextWindow, 1000000, 'context must default to 1M');
  assert.strictEqual(m.maxOutputTokens, 32000);
});

test('mergeCatalog: curated limits win over catalog metadata', () => {
  // Measured values beat the catalog because the catalog has been wrong before
  // (glm-5.3-flash was listed at 32000 output where the catalog says 131072).
  const out = merge({
    catalog: new Map([['auto', { maxInputTokens: 999, maxOutputTokens: 999, supportsToolCall: true }]]),
    limits: (id) => (id === 'auto' ? { contextWindow: 256000, maxOutputTokens: 32000 } : { contextWindow: null, maxOutputTokens: null }),
  });
  const auto = out.find(m => m.id === 'auto');
  assert.strictEqual(auto.contextWindow, 256000);
  assert.strictEqual(auto.maxOutputTokens, 32000);
});

test('mergeCatalog: catalog metadata fills a gap the curated table leaves', () => {
  const out = merge({
    curated: ['mystery-model'],
    catalog: new Map([['mystery-model', { maxInputTokens: 512000, maxOutputTokens: 64000, supportsToolCall: true }]]),
  });
  const m = out.find(x => x.id === 'mystery-model');
  assert.strictEqual(m.contextWindow, 512000, 'catalog metadata should be used when curated has none');
  assert.strictEqual(m.source, 'curated', 'but it is still a curated id');
});

test('mergeCatalog: dead and non-chat ids never enter the list', () => {
  const out = merge({
    catalog: new Map([
      ['glm-4.6', { supportsToolCall: true, supportsReasoning: true }],
      ['codewise-jump', {}],
      ['hunyuan-image-alpha', {}],
      ['good-model', { supportsToolCall: true }],
    ]),
  });
  const ids = out.map(m => m.id);
  assert.ok(!ids.includes('glm-4.6'), 'known-dead must be filtered');
  assert.ok(!ids.includes('codewise-jump'), 'completion model must be filtered');
  assert.ok(!ids.includes('hunyuan-image-alpha'), 'image backend must be filtered');
  assert.ok(ids.includes('good-model'), 'a real new model must be added');
});

test('mergeCatalog: duplicate ids are not emitted twice', () => {
  const out = merge({
    catalog: new Map([['auto', { supportsToolCall: true, maxInputTokens: 256000 }]]),
  });
  assert.strictEqual(out.filter(m => m.id === 'auto').length, 1);
});

// ---------------------------------------------------------------------------
// catalog payload parsing
// ---------------------------------------------------------------------------

test('extractModels: finds the models array at any depth', () => {
  const payload = { data: { config: { chat: { models: [{ id: 'a' }, { id: 'b' }] } } } };
  const found = catalog.extractModels(payload);
  assert.strictEqual(found.length, 2);
  assert.strictEqual(found[0].id, 'a');
});

test('extractModels: returns null when there is no models array', () => {
  assert.strictEqual(catalog.extractModels({ data: {} }), null);
  assert.strictEqual(catalog.extractModels(null), null);
});

test('extractModels: ignores an empty models array', () => {
  // An empty array is not a usable catalog; treating it as one would wipe the list.
  assert.strictEqual(catalog.extractModels({ models: [] }), null);
});

// ---------------------------------------------------------------------------
// known-dead list integrity
// ---------------------------------------------------------------------------

test('KNOWN_DEAD: every entry would otherwise look like a chat model', () => {
  // If an id were already excluded by pattern, listing it here would be
  // redundant — and a sign the pattern list drifted.
  for (const id of catalog.KNOWN_DEAD) {
    const matchesPattern = catalog.NON_CHAT_PATTERNS.some(re => re.test(id));
    assert.strictEqual(matchesPattern, false, id + ' is already covered by a pattern; remove it from KNOWN_DEAD');
  }
});
