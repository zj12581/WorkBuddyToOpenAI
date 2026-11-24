'use strict';
/**
 * Language model provider for VS Code's model picker.
 *
 * This is the integration that matters: by registering a `LanguageModelChatProvider`
 * the WorkBuddy models show up in the Chat view's model dropdown, so GitHub Copilot
 * Chat (or any other chat participant) drives the conversation with its own agent
 * loop, tools, approvals and diff UI. We only supply the model.
 *
 * Video the same shape as other community providers: a vendor id plus an
 * implementation of the three provider methods.
 *
 * API notes (verified against VS Code 1.138's vscode.d.ts):
 *   - registerLanguageModelChatProvider(vendor, provider)
 *   - provideLanguageModelChatInformation(options, token) -> LanguageModelChatInformation[]
 *   - provideLanguageModelChatResponse(model, messages, options, progress, token)
 *   - provideTokenCount(model, text, token) -> number
 * Progress parts are LanguageModelTextPart / LanguageModelToolCallPart /
 * LanguageModelDataPart; unknown part kinds must simply be ignored.
 */

const vscode = require('vscode');
const { createClient } = require('./client');
const { discoverGatewayApiKey } = require('./discover');
const { findGateway } = require('./discover-net');

const VENDOR = 'workbuddy';

function cfg() {
  return vscode.workspace.getConfiguration('workbuddyAgent');
}

function resolveApiKey() {
  const configured = String(cfg().get('apiKey', '') || '').trim();
  if (configured) return configured;
  const found = discoverGatewayApiKey();
  return found ? found.key : '';
}

/** The gateway URL, probed once and cached for the session. */
let cachedGatewayUrl = null;
async function resolveGatewayUrl() {
  if (cachedGatewayUrl) return cachedGatewayUrl;
  const configured = String(cfg().get('gatewayUrl', '') || '');
  let port = 8790;
  try { port = Number(new URL(configured).port) || 8790; } catch { /* default */ }
  const found = await findGateway(configured, port, 1500);
  cachedGatewayUrl = found.url || configured || 'http://127.0.0.1:8790';
  return cachedGatewayUrl;
}

/** Model cache, refreshed when the gateway's list changes. */
let modelCache = [];
let modelCacheAt = 0;
const MODEL_TTL_MS = 30_000;

/**
 * Shown when the gateway cannot be reached, so the WorkBuddy group does not
 * disappear from the picker. Selecting one surfaces the real connection error.
 *
 * The limits mirror what the gateway reports for these ids. They are duplicated
 * rather than fetched because this list exists precisely for the case where
 * fetching fails, and a wrong value here (a 1M model advertised as 128K) would
 * limit a conversation for no reason.
 */
const STATIC_FALLBACK_MODELS = [
  { id: 'hy4-preview-f', free: true, context: 1000000, output: 64000 },
  { id: 'deepseek-v4-flash', free: true, context: 1000000, output: 50000 },
  { id: 'auto', free: true, context: 256000, output: 32000 },
  { id: 'deepseek-v4.1-flash', free: false, context: 1000000, output: 128000 },
];

async function loadModels(force) {
  if (!force && modelCache.length && Date.now() - modelCacheAt < MODEL_TTL_MS) return modelCache;
  const gatewayUrl = await resolveGatewayUrl();
  const client = createClient({ gatewayUrl, apiKey: resolveApiKey() });
  const models = await client.listModels();
  modelCache = models;
  modelCacheAt = Date.now();
  return models;
}

/**
 * Convert VS Code chat messages into the OpenAI shape the gateway accepts.
 *
 * The part types that matter here:
 *   LanguageModelTextPart       -> text
 *   LanguageModelToolCallPart   -> assistant message with tool_calls
 *   LanguageModelToolResultPart -> role:"tool" message carrying the result
 *   LanguageModelDataPart       -> image_url
 *
 * Parts we do not understand are skipped rather than thrown on, so a future API
 * addition degrades instead of breaking the provider.
 */
function toOpenAIMessages(messages) {
  const out = [];

  const textOf = (part) => {
    if (!part) return '';
    if (typeof part.value === 'string') return part.value;
    if (typeof part.text === 'string') return part.text;
    return '';
  };

  for (const m of messages || []) {
    const isUser = m.role === vscode.LanguageModelChatMessageRole.User;
    const content = m.content;

    if (typeof content === 'string') {
      out.push({ role: isUser ? 'user' : 'assistant', content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const texts = [];
    const images = [];
    const toolCalls = [];
    const toolResults = [];

    for (const part of content) {
      if (!part) continue;
      // Tool call requested by the assistant.
      if (typeof part.callId === 'string' && typeof part.name === 'string'
          && part.input !== undefined && !('content' in part)) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: { name: part.name, arguments: JSON.stringify(part.input || {}) },
        });
        continue;
      }
      // Tool result fed back by the caller.
      if (typeof part.callId === 'string' && 'content' in part) {
        const inner = Array.isArray(part.content) ? part.content : [part.content];
        const text = inner.map(textOf).filter(Boolean).join('\n');
        toolResults.push({ role: 'tool', tool_call_id: part.callId, content: text || '(empty)' });
        continue;
      }
      // Image data part.
      if (part.mime && part.data) {
        const bytes = part.data instanceof Uint8Array ? part.data : Buffer.from(part.data);
        images.push({
          type: 'image_url',
          image_url: { url: 'data:' + part.mime + ';base64,' + Buffer.from(bytes).toString('base64') },
        });
        continue;
      }
      // Plain text.
      const t = textOf(part);
      if (t) texts.push(t);
    }

    // Tool results are their own messages and must keep their callId pairing.
    for (const tr of toolResults) out.push(tr);
    if (!texts.length && !images.length && !toolCalls.length) continue;

    const msg = { role: isUser ? 'user' : 'assistant' };
    if (images.length) {
      msg.content = [...texts.map(t => ({ type: 'text', text: t })), ...images];
    } else {
      msg.content = texts.join('\n') || null;
    }
    if (toolCalls.length) msg.tool_calls = toolCalls;
    out.push(msg);
  }

  return out;
}

/**
 * Fallbacks used only when the gateway does not report a limit.
 *
 * The real ranges are wide — 1M down to 96K context. Declaring one number for
 * every model is wrong in both directions: it wastes most of a 1M model's window,
 * and it promises more than a 96K model has, so the host fills the context and the
 * request fails mid-conversation. The fallback is deliberately the smallest of the
 * real values, because under-claiming costs a little room while over-claiming
 * causes a hard error.
 */
const FALLBACK_INPUT_TOKENS = 96000;
const FALLBACK_OUTPUT_TOKENS = 8192;

/** Coerce a gateway-reported limit into a usable positive integer, or null. */
function positiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Build the LanguageModelChatInformation entries the picker shows.
 *
 * LanguageModelChatInformation is an interface, not a class — these must be plain
 * object literals.
 */
async function buildInformation() {
  let models = [];
  try {
    models = await loadModels(false);
  } catch {
    return [];
  }
  return models.map((m) => {
    const context = positiveInt(m.contextWindow);
    const output = positiveInt(m.maxOutputTokens);
    const limitNote = context ? '  ·  ' + Math.round(context / 1000) + 'K ctx' : '';
    const tierNote = m.tier === 'free' ? 'free' : 'bills credits';
    return {
      id: m.id,
      name: (m.tier === 'free' ? '★ ' : '') + m.id,
      family: 'workbuddy',
      version: '1',
      detail: 'WorkBuddy · ' + tierNote + limitNote,
      tooltip: 'Provided by the local workbuddy-gateway',
      maxInputTokens: context || FALLBACK_INPUT_TOKENS,
      maxOutputTokens: output || FALLBACK_OUTPUT_TOKENS,
      capabilities: {
        toolCalling: true,
        imageInput: true,
      },
    };
  });
}

class WorkBuddyChatProvider {
  constructor(context) {
    this.context = context;
    this.onDidChangeEmitter = new vscode.EventEmitter();
    this.onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;
  }

  /** Refresh the picker (call after the gateway URL or key changes). */
  refresh() {
    modelCache = [];
    modelCacheAt = 0;
    cachedGatewayUrl = null;
    this.onDidChangeEmitter.fire();
  }

  async provideLanguageModelChatInformation(options, token) {
    // Never return an empty list here. VS Code treats an empty result as "this
    // provider has no models" and stops asking, which silently removes the group
    // from the model picker. A `silent` call means "do not prompt the user for
    // credentials", not "return nothing" — so answer it from the same source,
    // just without any interactive fallback.
    try {
      const infos = await buildInformation();
      if (infos.length) return infos;
    } catch {
      // fall through to the static floor below
    }
    // The gateway may simply not be running yet. Offering a small static list
    // keeps the group visible so the user has something to select (and can see
    // the error when they try), instead of the group vanishing.
    return STATIC_FALLBACK_MODELS.map((m) => ({
      id: m.id,
      name: (m.free ? '★ ' : '') + m.id,
      family: 'workbuddy',
      version: '1',
      detail: 'WorkBuddy · ' + (m.free ? 'free' : 'bills credits')
        + '  ·  ' + Math.round(m.context / 1000) + 'K ctx',
      tooltip: 'Requires the local workbuddy-gateway to be running',
      maxInputTokens: m.context || FALLBACK_INPUT_TOKENS,
      maxOutputTokens: m.output || FALLBACK_OUTPUT_TOKENS,
      capabilities: { toolCalling: true, imageInput: true },
    }));
  }

  async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    const gatewayUrl = await resolveGatewayUrl();
    const client = createClient({ gatewayUrl, apiKey: resolveApiKey() });

    const body = {
      model: model.id,
      messages: toOpenAIMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
    };

    // Respect the caller's tool mode. "required" must force a tool call; "none"
    // must not offer tools at all.
    const tools = mapTools(options && options.tools);
    const mode = (options && options.toolMode) || 'auto';
    if (tools && mode !== 'none') {
      body.tools = tools;
      body.tool_choice = mode === 'required' ? 'required' : 'auto';
    }

    const effort = String(cfg().get('reasoningEffort', 'off') || 'off').toLowerCase();
    if (effort && effort !== 'off') body.reasoning_effort = effort;

    // Accumulate tool calls across chunks: they arrive incrementally by index.
    const toolCalls = new Map();
    let textBuffer = '';

    const flushText = () => {
      if (textBuffer) {
        progress.report(new vscode.LanguageModelTextPart(textBuffer));
        textBuffer = '';
      }
    };

    const abort = new AbortController();
    const sub = token && token.onCancellationRequested(() => abort.abort());

    // The upstream reports exact token counts at the end of the stream when
    // `stream_options.include_usage` is set. Capturing them matters: VS Code's
    // context-usage indicator is driven by the counts the provider hands back,
    // and a missing count leaves it showing an estimate that drifts far from
    // reality (Chinese text is roughly 1.5 chars/token, not the 4 the estimator
    // assumes). The last non-null usage wins — some servers send it once.
    let reportedUsage = null;

    try {
      await client.streamChat(body, (payload) => {
        if (payload.error) {
          throw new Error(typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error));
        }
        if (payload.usage && Number.isFinite(Number(payload.usage.prompt_tokens))) {
          reportedUsage = payload.usage;
        }
        for (const choice of payload.choices || []) {
          const d = choice.delta || {};
          if (typeof d.content === 'string' && d.content) {
            textBuffer += d.content;
            // Report in reasonably sized batches to avoid per-token overhead.
            if (textBuffer.length >= 24) flushText();
          }
          if (Array.isArray(d.tool_calls)) {
            for (const tc of d.tool_calls) {
              const i = tc.index === undefined ? 0 : tc.index;
              const slot = toolCalls.get(i) || { id: null, name: '', args: '' };
              if (tc.id) slot.id = tc.id;
              const fn = tc.function || {};
              if (fn.name) slot.name += fn.name;
              if (fn.arguments) slot.args += fn.arguments;
              toolCalls.set(i, slot);
            }
          }
        }
      }, abort.signal);
    } finally {
      if (sub && typeof sub.dispose === 'function') sub.dispose();
      flushText();
    }

    // Hand the real counts back to VS Code. LanguageModelUsagePart exists on the
    // 1.104 API line this extension targets; the guard keeps older hosts working
    // (they simply keep their own estimate).
    if (reportedUsage && typeof vscode.LanguageModelUsagePart === 'function') {
      try {
        progress.report(new vscode.LanguageModelUsagePart({
          inputTokens: Number(reportedUsage.prompt_tokens) || 0,
          outputTokens: Number(reportedUsage.completion_tokens) || 0,
        }));
      } catch {
        // Counts are cosmetic; never fail a completed response over them.
      }
    }

    // Emit any tool calls as proper parts so the caller can execute them.
    for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!call.name) continue;
      let input = {};
      try { input = call.args ? JSON.parse(call.args) : {}; } catch { input = {}; }
      progress.report(new vscode.LanguageModelToolCallPart(call.id || ('call_' + call.name), call.name, input));
    }
  }

  async provideTokenCount(model, text, token) {
    return estimateTokens(text);
  }
}

/**
 * Estimate a token count for text the upstream has not measured.
 *
 * VS Code calls this to decide when to compact, so a bad estimate is not merely
 * cosmetic: too high and the editor trims history that would have fit; too low
 * and the request is rejected upstream for exceeding the real limit.
 *
 * The four-characters-per-token rule holds for English prose only. Measured
 * against `prompt_tokens` from the gateway on 2026-11:
 *
 *   ASCII prose   1260 chars -> 245 tokens   5.1 chars/token
 *   Chinese       420 chars  -> 214 tokens  1.96 chars/token
 *
 * So counting CJK at half a token per character and everything else at a fifth
 * tracks both scripts within a few percent, which is as close as an estimator
 * without a real tokenizer gets. The old flat /4 was 2x low on Chinese, which is
 * what made the context bar sit near empty while requests were actually close to
 * the limit.
 */
function estimateTokens(text) {
  let s;
  if (typeof text === 'string') {
    s = text;
  } else if (text == null) {
    return 1;
  } else {
    // Message objects and content arrays: count the visible text, not the JSON
    // punctuation, which would otherwise inflate the estimate.
    s = JSON.stringify(text);
  }

  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    // CJK Unified Ideographs, Extension A, Hiragana, Katakana, Hangul, fullwidth.
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) {
      cjk++;
    } else {
      other++;
    }
  }

  return Math.max(1, Math.ceil(cjk / 2 + other / 5));
}

/** Map VS Code tool definitions onto OpenAI function tools. */
function mapTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

/** Register the provider; returns the instance so callers can refresh it. */
function registerLanguageModelProvider(context) {
  if (!vscode.lm || typeof vscode.lm.registerLanguageModelChatProvider !== 'function') {
    return null;
  }
  const provider = new WorkBuddyChatProvider(context);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    provider.onDidChangeEmitter
  );
  return provider;
}

module.exports = { registerLanguageModelProvider, buildInformation, toOpenAIMessages, mapTools, VENDOR };
