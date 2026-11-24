'use strict';
/**
 * Responses API ⇄ Chat Completions translation.
 *
 * Codex CLI (v0.171+) only speaks the Responses API — its binary carries the
 * message "`wire_api = \"chat\"` is no longer supported" — while the upstream
 * here exposes only `/v2/chat/completions`. This module is the adapter.
 *
 * Everything here is a pure function over plain objects: no network, no globals,
 * no request state. That keeps the mapping testable without an account, which
 * matters because the two protocols differ in ways that are easy to get subtly
 * wrong (tool-call items are top-level entries in Responses but nested inside an
 * assistant message in chat; instructions is a separate field, not a message).
 */

const crypto = require('crypto');

function newId(prefix) {
  return prefix + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

// ---------------------------------------------------------------------------
// Request: Responses → chat
// ---------------------------------------------------------------------------

/**
 * Flatten a Responses `input` into chat `messages`.
 *
 * `input` is either a string (one user turn) or an array of items. The array
 * mixes several item kinds:
 *
 *   message               → a chat message
 *   function_call         → assistant tool_calls entry
 *   function_call_output  → role:"tool" message
 *   reasoning             → dropped; chat has no equivalent and the field is
 *                           the model's own prior thinking, not something to
 *                           feed back
 *
 * `instructions` becomes a system message, since chat has no separate field.
 */
function toChatMessages(input, instructions) {
  const out = [];

  if (typeof instructions === 'string' && instructions.trim()) {
    out.push({ role: 'system', content: instructions });
  }

  if (typeof input === 'string') {
    if (input) out.push({ role: 'user', content: input });
    return out;
  }
  if (!Array.isArray(input)) return out;

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;

    // --- message (Responses items carry type:"message", or just a role) ---
    if (item.type === 'message' || (item.role && item.type === undefined)) {
      const role = item.role === 'assistant' ? 'assistant'
        : item.role === 'system' || item.role === 'developer' ? 'system'
          : 'user';
      const content = item.content;

      if (typeof content === 'string') {
        if (content) out.push({ role, content });
        continue;
      }
      if (!Array.isArray(content)) continue;

      const parts = [];
      for (const c of content) {
        if (typeof c === 'string') { parts.push({ type: 'text', text: c }); continue; }
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') {
          parts.push({ type: 'text', text: c.text || '' });
        } else if (c.type === 'input_image') {
          // Responses puts the URL in a string; chat wants an object.
          const url = typeof c.image_url === 'string' ? c.image_url : c.image_url && c.image_url.url;
          if (url) parts.push({ type: 'image_url', image_url: { url } });
        }
      }
      if (!parts.length) continue;
      // Collapse to a plain string when there are no images: some upstream
      // decoders are stricter about parts arrays than the spec requires.
      out.push(parts.every((p) => p.type === 'text')
        ? { role, content: parts.map((p) => p.text).join('') }
        : { role, content: parts });
      continue;
    }

    // --- function_call: must live on an assistant message's tool_calls ---
    if (item.type === 'function_call') {
      const call = {
        id: item.call_id || item.id || newId('call'),
        type: 'function',
        function: { name: item.name || '', arguments: item.arguments || '{}' },
      };
      const last = out[out.length - 1];
      if (last && last.role === 'assistant') {
        (last.tool_calls || (last.tool_calls = [])).push(call);
      } else {
        out.push({ role: 'assistant', content: '', tool_calls: [call] });
      }
      continue;
    }

    // --- function_call_output: a tool message ---
    if (item.type === 'function_call_output') {
      let output = item.output;
      if (Array.isArray(output)) {
        output = output.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
      } else if (output && typeof output === 'object') {
        output = output.content !== undefined ? output.content
          : output.text !== undefined ? output.text
            : JSON.stringify(output);
      }
      out.push({
        role: 'tool',
        tool_call_id: item.call_id || '',
        content: String(output === undefined || output === null ? '' : output),
      });
      continue;
    }

    // reasoning and anything unknown: nothing sensible to send.
  }

  return out;
}

/**
 * Responses tool definitions are flat ({type:"function", name, parameters});
 * chat nests them under `function`.
 *
 * Codex also sends built-in tools (local_shell, web_search, computer_use) that
 * carry no JSON Schema. Those cannot be expressed as chat functions, so they are
 * skipped — the model simply does not see them, which degrades rather than fails.
 * `onSkip` is called for each so the caller can log the loss.
 */
function toChatTools(tools, onSkip) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.function && t.function.name) { out.push(t); continue; }
    if (t.type === 'function' && t.name) {
      out.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} },
        },
      });
      continue;
    }
    if (typeof onSkip === 'function') onSkip(t.type || '(unknown)');
  }
  return out.length ? out : undefined;
}

/** tool_choice: Responses names the function flat, chat nests it. */
function toChatToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === 'string') {
    return choice === 'auto' || choice === 'none' || choice === 'required' ? choice : undefined;
  }
  if (choice.type === 'function' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

/**
 * Build the chat request body from a Responses request.
 * @param req Responses request object
 * @param onSkip called for each tool that cannot be translated
 */
function toChatBody(req, onSkip) {
  const messages = toChatMessages(req.input, req.instructions);
  const body = {
    model: req.model,
    messages,
    stream: req.stream !== false,
  };

  const tools = toChatTools(req.tools, onSkip);
  if (tools) {
    body.tools = tools;
    const tc = toChatToolChoice(req.tool_choice);
    if (tc) body.tool_choice = tc;
  }

  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.parallel_tool_calls !== undefined) body.parallel_tool_calls = req.parallel_tool_calls;

  // max_output_tokens (Responses) and max_tokens (chat) are the same thing.
  const maxOut = req.max_output_tokens !== undefined ? req.max_output_tokens : req.max_tokens;
  if (maxOut !== undefined) body.max_tokens = maxOut;

  // reasoning.effort → reasoning_effort. The upstream rejects the literal "off"
  // on the DeepSeek V4 family (HTTP 400 / 11150), so that value is dropped
  // rather than forwarded; see normalizeReasoningEffort in lib/core.js.
  if (req.reasoning && req.reasoning.effort) {
    const effort = String(req.reasoning.effort).toLowerCase();
    if (effort !== 'off' && effort !== 'none') body.reasoning_effort = effort;
  }

  if (body.stream) body.stream_options = { include_usage: true };

  return body;
}

// ---------------------------------------------------------------------------
// Response: chat → Responses
// ---------------------------------------------------------------------------

function toResponsesUsage(u) {
  if (!u) {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  }
  const details = u.prompt_tokens_details || {};
  const cDetails = u.completion_tokens_details || {};
  return {
    input_tokens: Number(u.prompt_tokens) || 0,
    output_tokens: Number(u.completion_tokens) || 0,
    total_tokens: Number(u.total_tokens) || 0,
    input_tokens_details: { cached_tokens: Number(details.cached_tokens) || 0 },
    output_tokens_details: { reasoning_tokens: Number(cDetails.reasoning_tokens) || 0 },
  };
}

/**
 * Collect a chat message (or accumulated stream) into Responses `output` items.
 * Text becomes one message item; each tool call becomes its own function_call
 * item at the top level, which is where Responses puts them.
 */
function toOutputItems(text, toolCalls) {
  const output = [];
  if (text) {
    output.push({
      type: 'message',
      id: newId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const call of toolCalls || []) {
    output.push({
      type: 'function_call',
      id: newId('fc'),
      status: 'completed',
      call_id: call.id || newId('call'),
      name: call.name || '',
      arguments: call.arguments || '{}',
    });
  }
  return output;
}

/** Wrap a completed chat result as a Responses object. */
function toResponse(chat, fallbackModel) {
  const choice = (chat.choices || [])[0] || {};
  const msg = choice.message || {};
  const text = typeof msg.content === 'string' ? msg.content : '';
  const calls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function && tc.function.name,
    arguments: tc.function && tc.function.arguments,
  }));
  const output = toOutputItems(text, calls);

  return {
    id: newId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: chat.model || fallbackModel,
    output,
    output_text: text,
    usage: toResponsesUsage(chat.usage),
    parallel_tool_calls: true,
  };
}

// ---------------------------------------------------------------------------
// SSE events for a streamed response
// ---------------------------------------------------------------------------

/**
 * Write a Responses event. The format is `event: <name>` plus a `data:` line
 * whose body repeats the type; clients read whichever they prefer.
 */
function sseEvent(res, name, payload) {
  res.write('event: ' + name + '\n');
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

module.exports = {
  newId,
  toChatMessages,
  toChatTools,
  toChatToolChoice,
  toChatBody,
  toResponsesUsage,
  toOutputItems,
  toResponse,
  sseEvent,
};
