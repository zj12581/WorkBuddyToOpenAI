/**
 * Keep the DSH workbuddy provider's model list in step with the gateway.
 *
 * Registers `/sync-models`, which reads the gateway's `/v1/models` and rewrites
 * the `workbuddy` provider's model list in `settings.yaml`.
 *
 * Why a plugin rather than only the CLI script
 * --------------------------------------------
 * The gateway now tracks the upstream catalog on its own, so the model list
 * changes without anyone editing a file. DSH, by contrast, requires every model
 * to be declared explicitly with a context window and a reasoning-effort map, so
 * it cannot follow along by itself. A slash command makes catching up a single
 * step inside the session where the missing model was noticed, instead of a
 * context switch to a terminal.
 *
 * The sync logic lives in one file, vendored next to this plugin at install time
 * (`lib/sync-models.js`, copied from `integrations/dsh/sync-models.js`). The
 * plugin does not reimplement it: a second copy of the merge rules would drift
 * from the first.
 *
 * @module dsh-plugin-workbuddy-models
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Cordis plugin name. */
const name = 'workbuddy-models';

/** The command registry is the plugin's whole purpose. */
const inject = ['commands'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

/**
 * Load the vendored sync module.
 *
 * The file is `.cjs` on purpose. This plugin's package.json declares
 * `"type": "module"`, and that applies to every `.js` file in the package — a
 * `sync-models.js` beside it would be parsed as ESM and its `require` calls
 * would fail. The `.cjs` extension opts it out.
 *
 * Fails with an actionable message rather than a stack trace: the usual cause is
 * a plugin copied by hand without the script beside it.
 */
function loadSync() {
  const candidates = [
    path.join(HERE, 'sync-models.cjs'),
    path.join(HERE, '..', 'sync-models.cjs'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      return require_(file);
    } catch (e) {
      throw new Error('could not load ' + file + ': ' + (e && e.message ? e.message : e));
    }
  }
  throw new Error('sync-models.cjs is missing next to the plugin (looked in '
    + candidates.join(', ') + '). Re-run integrations/dsh/install-models-plugin.sh.');
}

const USAGE = 'Usage: /sync-models [--dry-run] [--probe]';

/**
 * Run one invocation.
 *
 * `--dry-run` prints the lines that would be written and changes nothing.
 * `--probe` re-measures the reasoning channel of every model, not just new ones.
 */
async function execute(invocation) {
  const args = String(invocation?.rawInput || '').trim().split(/\s+/).filter(Boolean);
  const unknown = args.filter((a) => a !== '--dry-run' && a !== '--probe');
  if (unknown.length) {
    return { kind: 'error', text: 'Unknown option: ' + unknown.join(' ') + '\n' + USAGE };
  }

  let sync;
  try {
    ({ sync } = loadSync());
  } catch (e) {
    return { kind: 'error', text: String(e && e.message ? e.message : e) };
  }

  const lines = [];
  try {
    const result = await sync({
      dryRun: args.includes('--dry-run'),
      probe: args.includes('--probe'),
      onLine: (l) => lines.push(l),
    });

    if (args.includes('--dry-run')) {
      return { kind: 'success', text: lines.join('\n') };
    }

    const summary = [];
    summary.push('Synced ' + result.models.length + ' models from the gateway.');
    if (result.added.length) summary.push('  added:   ' + result.added.join(', '));
    if (result.removed.length) summary.push('  removed: ' + result.removed.join(', '));
    if (!result.added.length && !result.removed.length) summary.push('  no change');
    summary.push('');
    summary.push('Backup: ' + path.basename(result.backup));
    if (result.unknownReasoning && result.unknownReasoning.length) {
      summary.push('Reasoning channel unknown for: ' + result.unknownReasoning.join(', '));
      summary.push('  (no reasoningEfforts written for those)');
    }
    summary.push('');
    summary.push('Restart DSH for the new list to take effect.');
    return { kind: 'success', text: summary.join('\n') };
  } catch (e) {
    const detail = String(e && e.message ? e.message : e);
    return { kind: 'error', text: 'Sync failed: ' + detail + (lines.length ? '\n\n' + lines.join('\n') : '') };
  }
}

/**
 * Register `/sync-models`.
 * @param ctx - context carrying the command registry.
 */
function apply(ctx) {
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'sync-models',
      description: 'Sync the WorkBuddy model list with the gateway',
      input: { hint: '--dry-run | --probe' },
      handler: (invocation) => execute(invocation),
    });
  }, 'workbuddy-models lifecycle');
}

export { apply, inject, name };
