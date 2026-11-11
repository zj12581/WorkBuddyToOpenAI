'use strict';
/**
 * The right-hand agent panel.
 *
 * Modelled on Copilot Chat / Claude Code: a persistent conversation column in the
 * secondary side bar where each tool call renders as its own collapsible step, and
 * permission requests appear inline as buttons instead of stealing focus with a
 * modal dialog.
 */

const vscode = require('vscode');
const { createClient, GatewayUnreachable } = require('./client');
const { runTurn, EFFORT_LEVELS, normalizeEffort } = require('./agent');
const { PermissionBroker, KIND_WRITE, KIND_EXEC } = require('./permissions');
const { isWsl, findGateway, WSL_LOCAL_PORT } = require('./discover-net');
const { discoverGatewayApiKey } = require('./discover');
const { buildHtml } = require('./agentview-html');
const { SessionStore } = require('./sessions');

const VIEW_ID = 'workbuddyAgent.agentView';

function cfg() {
  return vscode.workspace.getConfiguration('workbuddyAgent');
}

class AgentViewProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.store = new SessionStore(context.workspaceState);
    this.session = null;              // active session record
    this.abort = null;
    this.resolvedUrl = null;
    this.probeLog = [];
    this.pending = new Map();         // permission requestId -> resolve
    this.nextRequestId = 1;
    this.stats = { turns: 0, credit: 0 };
  }

  /** The active session's message array (creating one on first use). */
  get messages() {
    if (!this.session) {
      this.session = this.store.get(this.store.activeId()) || this.store.create();
    }
    return this.session.messages;
  }

  async ensureSession() {
    if (!this.session) {
      this.session = this.store.get(this.store.activeId()) || this.store.create();
    }
    return this.session;
  }

  async saveSession() {
    if (this.session) await this.store.save(this.session);
  }

  resolveApiKey() {
    const configured = String(cfg().get('apiKey', '') || '').trim();
    if (configured) return configured;
    const found = discoverGatewayApiKey();
    return found ? found.key : '';
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  log(text, kind) {
    this.post({ type: 'log', text, kind: kind || 'info' });
  }

  async resolveGateway() {
    if (this.resolvedUrl) return this.resolvedUrl;
    const configured = String(cfg().get('gatewayUrl', '') || '');
    let port = 8790;
    try { port = Number(new URL(configured).port) || 8790; } catch { /* keep default */ }
    const found = await findGateway(configured, port, 1500);
    this.probeLog = found.probed || [];
    if (found.url) this.resolvedUrl = found.url;
    return this.resolvedUrl || configured || 'http://127.0.0.1:8790';
  }

  /**
   * Ask the webview for permission and wait for the answer.
   * This is what keeps the run uninterrupted: the question renders inside the
   * conversation instead of as a focus-stealing modal.
   */
  askPermission(kind, detail) {
    if (!this.view) return Promise.resolve('deny');
    const id = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.post({ type: 'permission', id, kind, detail });
    });
  }

  makeBroker() {
    return new PermissionBroker({
      onRequest: (kind, detail) => this.askPermission(kind, detail),
      grants: {
        write: cfg().get('autoApproveFileWrites', false),
        exec: cfg().get('autoApproveTerminal', false),
      },
    });
  }

  /** Replay the stored transcript into a freshly opened panel. */
  postHistory() {
    const session = this.session;
    this.post({ type: 'cleared' });
    if (!session) return;
    for (const m of session.messages || []) {
      if (m.role === 'user') {
        this.post({ type: 'userMessage', text: typeof m.content === 'string' ? m.content : '' });
      } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content) {
        this.post({ type: 'replayAssistant', text: m.content });
      }
      // tool messages are not replayed individually: the transcript is what the
      // model needs, and the UI only needs the human-readable turns back.
    }
    this.post({ type: 'historyEnd', title: session.title || 'New chat' });
  }

  postSessions() {
    this.post({ type: 'sessions', sessions: this.store.list(), active: this.session ? this.session.id : null });
  }

  /** Load the model list and hand it to the picker. */
  async postModels() {
    try {
      const gatewayUrl = await this.resolveGateway();
      const client = createClient({ gatewayUrl, apiKey: this.resolveApiKey() });
      const models = await client.listModels();
      this.post({
        type: 'models',
        current: cfg().get('model', 'hy4-preview-f'),
        models: models.map(m => ({
          id: m.id,
          label: (m.tier === 'free' ? '★ ' : '') + m.id,
        })),
      });
    } catch (err) {
      this.post({ type: 'models', current: null, models: [] });
      this.post({ type: 'error', text: 'Could not list models: ' + String(err && err.message || err) });
    }
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = buildHtml();

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready': {
          await this.ensureSession();
          this.post({
            type: 'init',
            model: cfg().get('model', 'hy4-preview-f'),
            effort: normalizeEffort(cfg().get('reasoningEffort', 'off')) || 'off',
            efforts: EFFORT_LEVELS,
            autoWrite: cfg().get('autoApproveFileWrites', false),
            autoExec: cfg().get('autoApproveTerminal', false),
          });
          this.postHistory();
          this.postSessions();
          break;
        }

        case 'newChat': {
          const created = this.store.create();
          await this.store.save(created);
          this.session = created;
          this.stats = { turns: 0, credit: 0 };
          this.post({ type: 'cleared' });
          this.postSessions();
          break;
        }

        case 'selectSession': {
          const target = this.store.get(msg.id);
          if (target) {
            this.session = target;
            await this.store.setActive(target.id);
            this.stats = { turns: 0, credit: 0 };
            this.postHistory();
            this.postSessions();
          }
          break;
        }

        case 'deleteSession': {
          await this.store.remove(msg.id);
          if (!this.session || this.session.id === msg.id) {
            this.session = this.store.get(this.store.activeId());
            if (!this.session) {
              this.session = this.store.create();
              await this.store.save(this.session);
            }
            this.postHistory();
          }
          this.postSessions();
          break;
        }

        case 'setEffort':
          await cfg().update('reasoningEffort', msg.effort, vscode.ConfigurationTarget.Global);
          break;

        case 'needModels':
          await this.postModels();
          break;

        case 'send':
          await this.run(msg.text);
          break;

        case 'stop':
          if (this.abort) this.abort.abort();
          break;

        case 'permissionAnswer': {
          const resolve = this.pending.get(msg.id);
          if (resolve) {
            this.pending.delete(msg.id);
            resolve(msg.answer);
          }
          break;
        }

        case 'setModel':
          await cfg().update('model', msg.model, vscode.ConfigurationTarget.Global);
          break;

        case 'setAuto':
          await cfg().update(
            msg.kind === 'write' ? 'autoApproveFileWrites' : 'autoApproveTerminal',
            !!msg.value,
            vscode.ConfigurationTarget.Global
          );
          break;

        case 'openFile':
          try {
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, msg.path)
            );
            await vscode.window.showTextDocument(doc, { preview: true });
          } catch { /* ignore */ }
          break;
      }
    });
  }

  async run(text) {
    const prompt = String(text || '').trim();
    if (!prompt) return;

    await this.ensureSession();
    this.messages.push({ role: 'user', content: prompt });
    this.post({ type: 'userMessage', text: prompt });

    const model = cfg().get('model', 'hy4-preview-f');
    this.post({ type: 'assistantStart', model });

    this.abort = new AbortController();
    const started = Date.now();
    let stepCounter = 0;
    let assistantText = '';
    const stepsByTool = new Map();

    try {
      const gatewayUrl = await this.resolveGateway();
      const outcome = await runTurn({
        gatewayUrl,
        apiKey: this.resolveApiKey(),
        model,
        messages: this.messages,
        maxSteps: cfg().get('maxToolSteps', 50),
        signal: this.abort.signal,
        broker: this.makeBroker(),
        reasoningEffort: cfg().get('reasoningEffort', 'off'),

        onText: (chunk) => {
          assistantText += chunk;
          this.post({ type: 'text', text: chunk });
        },
        onReasoning: (chunk) => this.post({ type: 'reasoning', text: chunk }),

        onToolCall: (name, args) => {
          const id = 'step-' + (++stepCounter);
          stepsByTool.set(name + ':' + JSON.stringify(args), id);
          this.post({ type: 'toolStart', id, name, args });
        },
        onToolResult: (name, result) => {
          // Best-effort pairing: the executor is sequential, so the oldest
          // unmatched call for this name is the one that just finished.
          let id = null;
          for (const [key, value] of stepsByTool) {
            if (key.startsWith(name + ':')) { id = value; stepsByTool.delete(key); break; }
          }
          this.post({ type: 'toolEnd', id, name, result: String(result).slice(0, 4000) });
        },
        onDiff: (file, before, after) => {
          this.post({
            type: 'diff',
            path: vscode.workspace.asRelativePath(file),
            added: after.split('\n').length,
            removed: before ? before.split('\n').length : 0,
            isNew: !before,
          });
        },
        onUsage: (usage) => {
          if (usage && typeof usage.credit === 'number') this.stats.credit += usage.credit;
          this.post({
            type: 'usage',
            credit: usage && usage.credit,
            tokens: usage && usage.total_tokens,
            sessionCredit: Number(this.stats.credit.toFixed(3)),
            cacheHit: usage && usage.prompt_cache_hit_tokens,
          });
        },
        onError: (err) => this.post({ type: 'error', text: String(err && err.message || err) }),
      });

      // Record what the model actually said so the transcript survives a reload.
      if (assistantText.trim()) {
        this.messages.push({ role: 'assistant', content: assistantText.trim() });
      }
      await this.saveSession();
      if (outcome && outcome.limitReached) {
        this.post({
          type: 'notice',
          text: 'Stopped after ' + outcome.steps + ' tool calls (the per-turn limit). '
            + 'Raise workbuddyAgent.maxToolSteps, or send "continue" to carry on from here.',
        });
      }
      this.post({ type: 'assistantEnd', ms: Date.now() - started, steps: stepCounter });
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      let message = String(err && err.message ? err.message : err);
      if (err instanceof GatewayUnreachable) {
        message = isWsl()
          ? 'No gateway answered from WSL. Start one inside WSL:\n'
            + 'bash /path/to/WorkBuddyToDeepSeekHarness/wsl/start-gateway.sh\n'
            + '(it listens on 127.0.0.1:' + WSL_LOCAL_PORT + ')'
          : message;
      }
      // Keep the user turn even when the reply failed, so the prompt is not lost.
      if (assistantText.trim()) {
        this.messages.push({ role: 'assistant', content: assistantText.trim() });
      }
      await this.saveSession();
      this.post({ type: 'error', text: aborted ? 'stopped' : message });
      this.post({ type: 'assistantEnd', ms: Date.now() - started, steps: stepCounter, failed: !aborted });
      this.postSessions();
    } finally {
      this.abort = null;
      this.postSessions();
    }
  }
}

module.exports = { AgentViewProvider, VIEW_ID };
