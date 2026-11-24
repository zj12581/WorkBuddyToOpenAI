/**
 * Unit tests for the Responses ⇄ chat translation.
 *
 * These matter more than usual: the two protocols disagree on where tool calls
 * live (top-level items vs nested on the assistant message), on how instructions
 * are carried (separate field vs system message), and on tool definition shape.
 * A mistake in any of those produces a request that is structurally valid but
 * silently loses the tools — the model then "ignores" a tool that never reached
 * it. No network, no account.
 *
 *   node --test tests/unit
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const r = require('../../lib/responses');

// ---------------------------------------------------------------------------
// input → messages
// ---------------------------------------------------------------------------

test('toChatMessages: a plain string becomes one user message', () => {
  assert.deepStrictEqual(r.toChatMessages('hello'), [{ role: 'user', content: 'hello' }]);
});

test('toChatMessages: instructions become a leading system message', () => {
  const out = r.toChatMessages('hi', 'be terse');
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[0], { role: 'system', content: 'be terse' });
  assert.deepStrictEqual(out[1], { role: 'user', content: 'hi' });
});

test('toChatMessages: empty instructions are not emitted', () => {
  assert.strictEqual(r.toChatMessages('hi', '   ').length, 1);
  assert.strictEqual(r.toChatMessages('hi', '').length, 1);
});

test('toChatMessages: input_text parts collapse to a plain string', () => {
  const out = r.toChatMessages([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] },
  ]);
  assert.deepStrictEqual(out, [{ role: 'user', content: 'ab' }]);
});

test('toChatMessages: input_image becomes a chat image_url object', () => {
  const out = r.toChatMessages([
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'what is this' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
      ],
    },
  ]);
  assert.strictEqual(out.length, 1);
  assert.ok(Array.isArray(out[0].content));
  assert.deepStrictEqual(out[0].content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,AAA' },
  });
});

test('toChatMessages: function_call attaches to a preceding assistant message', () => {
  const out = r.toChatMessages([
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'calling' }] },
    { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"a":1}' },
  ]);
  assert.strictEqual(out.length, 1, 'one message, not two');
  assert.strictEqual(out[0].role, 'assistant');
  assert.strictEqual(out[0].tool_calls.length, 1);
  assert.deepStrictEqual(out[0].tool_calls[0], {
    id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' },
  });
});

test('toChatMessages: a function_call with no preceding assistant gets its own message', () => {
  const out = r.toChatMessages([
    { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].role, 'assistant');
  assert.strictEqual(out[0].tool_calls.length, 1);
});

test('toChatMessages: function_call_output becomes a tool message', () => {
  const out = r.toChatMessages([
    { type: 'function_call_output', call_id: 'c1', output: 'result text' },
  ]);
  assert.deepStrictEqual(out, [{ role: 'tool', tool_call_id: 'c1', content: 'result text' }]);
});

test('toChatMessages: function_call_output with a parts array is joined', () => {
  const out = r.toChatMessages([
    { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'x' }, { type: 'input_text', text: 'y' }] },
  ]);
  assert.strictEqual(out[0].content, 'xy');
});

test('toChatMessages: reasoning items are dropped', () => {
  const out = r.toChatMessages([
    { type: 'reasoning', summary: [] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].role, 'user');
});

test('toChatMessages: a full tool round-trip keeps order', () => {
  const out = r.toChatMessages([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
    { type: 'function_call', call_id: 'c1', name: 'w', arguments: '{"city":"bj"}' },
    { type: 'function_call_output', call_id: 'c1', output: 'sunny' },
  ]);
  assert.deepStrictEqual(out.map((m) => m.role), ['user', 'assistant', 'tool']);
});

test('toChatMessages: null or missing input yields no messages', () => {
  assert.deepStrictEqual(r.toChatMessages(null), []);
  assert.deepStrictEqual(r.toChatMessages(undefined), []);
  assert.deepStrictEqual(r.toChatMessages(42), []);
});

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

test('toChatTools: flat Responses tools are nested under function', () => {
  const out = r.toChatTools([
    { type: 'function', name: 'f', description: 'd', parameters: { type: 'object', properties: {} } },
  ]);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0], {
    type: 'function',
    function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } },
  });
});

test('toChatTools: already-nested chat tools pass through', () => {
  const already = { type: 'function', function: { name: 'f', parameters: {} } };
  assert.deepStrictEqual(r.toChatTools([already]), [already]);
});

test('toChatTools: built-in tools without a schema are skipped and reported', () => {
  const skipped = [];
  const out = r.toChatTools(
    [{ type: 'local_shell' }, { type: 'web_search' }, { type: 'function', name: 'f', parameters: {} }],
    (t) => skipped.push(t)
  );
  assert.strictEqual(out.length, 1, 'only the function tool survives');
  assert.deepStrictEqual(skipped, ['local_shell', 'web_search']);
});

test('toChatTools: no tools yields undefined, not an empty array', () => {
  assert.strictEqual(r.toChatTools([]), undefined);
  assert.strictEqual(r.toChatTools(undefined), undefined);
  assert.strictEqual(r.toChatTools([{ type: 'local_shell' }]), undefined);
});

test('toChatToolChoice: flat name is nested', () => {
  assert.deepStrictEqual(r.toChatToolChoice({ type: 'function', name: 'f' }),
    { type: 'function', function: { name: 'f' } });
});

test('toChatToolChoice: string modes pass through', () => {
  assert.strictEqual(r.toChatToolChoice('auto'), 'auto');
  assert.strictEqual(r.toChatToolChoice('required'), 'required');
  assert.strictEqual(r.toChatToolChoice('none'), 'none');
});

// ---------------------------------------------------------------------------
// full body
// ---------------------------------------------------------------------------

test('toChatBody: max_output_tokens maps to max_tokens', () => {
  const b = r.toChatBody({ model: 'm', input: 'x', max_output_tokens: 100 });
  assert.strictEqual(b.max_tokens, 100);
});

test('toChatBody: reasoning.effort maps to reasoning_effort', () => {
  const b = r.toChatBody({ model: 'm', input: 'x', reasoning: { effort: 'high' } });
  assert.strictEqual(b.reasoning_effort, 'high');
});

test('toChatBody: reasoning.effort "off" is dropped, not forwarded', () => {
  // The upstream rejects the literal "off" on the DeepSeek V4 family with
  // HTTP 400 / 11150, so sending it would break those models.
  const b = r.toChatBody({ model: 'm', input: 'x', reasoning: { effort: 'off' } });
  assert.strictEqual(b.reasoning_effort, undefined);
  assert.ok(!('reasoning_effort' in b));
});

test('toChatBody: stream defaults to true and asks for usage', () => {
  const b = r.toChatBody({ model: 'm', input: 'x' });
  assert.strictEqual(b.stream, true);
  assert.deepStrictEqual(b.stream_options, { include_usage: true });
});

test('toChatBody: stream can be turned off', () => {
  const b = r.toChatBody({ model: 'm', input: 'x', stream: false });
  assert.strictEqual(b.stream, false);
  assert.strictEqual(b.stream_options, undefined);
});

// ---------------------------------------------------------------------------
// chat → Responses
// ---------------------------------------------------------------------------

test('toResponse: text becomes a message output item', () => {
  const resp = r.toResponse({
    model: 'mm',
    choices: [{ message: { content: 'hello' } }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }, 'fallback');

  assert.strictEqual(resp.object, 'response');
  assert.strictEqual(resp.status, 'completed');
  assert.strictEqual(resp.output_text, 'hello');
  assert.strictEqual(resp.output.length, 1);
  assert.strictEqual(resp.output[0].type, 'message');
  assert.strictEqual(resp.output[0].content[0].text, 'hello');
  assert.strictEqual(resp.usage.input_tokens, 5);
  assert.strictEqual(resp.usage.output_tokens, 2);
});

test('toResponse: tool calls become top-level function_call items', () => {
  const resp = r.toResponse({
    choices: [{
      message: {
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }],
      },
    }],
  }, 'm');

  assert.strictEqual(resp.output.length, 1);
  assert.strictEqual(resp.output[0].type, 'function_call');
  assert.strictEqual(resp.output[0].call_id, 'c1');
  assert.strictEqual(resp.output[0].name, 'f');
  assert.strictEqual(resp.output[0].arguments, '{"a":1}');
});

test('toResponse: text and tool calls produce two items, message first', () => {
  const resp = r.toResponse({
    choices: [{
      message: {
        content: 'let me check',
        tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }],
      },
    }],
  }, 'm');
  assert.deepStrictEqual(resp.output.map((o) => o.type), ['message', 'function_call']);
});

test('toResponse: missing usage yields zeroed counts, not undefined', () => {
  const resp = r.toResponse({ choices: [{ message: { content: 'x' } }] }, 'm');
  assert.strictEqual(resp.usage.input_tokens, 0);
  assert.strictEqual(resp.usage.output_tokens, 0);
});

test('toResponse: falls back to the request model when the reply omits it', () => {
  const resp = r.toResponse({ choices: [{ message: { content: 'x' } }] }, 'requested-model');
  assert.strictEqual(resp.model, 'requested-model');
});

test('toResponse: cached and reasoning token details are surfaced', () => {
  const resp = r.toResponse({
    choices: [{ message: { content: 'x' } }],
    usage: {
      prompt_tokens: 10, completion_tokens: 3, total_tokens: 13,
      prompt_tokens_details: { cached_tokens: 8 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  }, 'm');
  assert.strictEqual(resp.usage.input_tokens_details.cached_tokens, 8);
  assert.strictEqual(resp.usage.output_tokens_details.reasoning_tokens, 2);
});

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

test('newId: prefixed and unique', () => {
  const a = r.newId('resp');
  const b = r.newId('resp');
  assert.ok(a.startsWith('resp_'));
  assert.notStrictEqual(a, b);
});
