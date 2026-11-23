import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest } from '../bridge/translate.mjs';
import { sanitizeResponsesBody } from '../bridge/request-sanitize.mjs';
for (const model of ['gemini-3-pro', 'mycodex/codex-gemini/gemini-3-pro', 'copilot/gemini-3-pro']) test(`Gemini commentary continues without assistant prefill: ${model}`, () => {
  const request = { model, input: [{ role: 'user', content: 'Work' }, { role: 'assistant', phase: 'commentary', content: 'Checking' }] };
  const before = structuredClone(request);
  const { body } = buildChatRequest(request, {});
  assert.deepEqual(body.messages.slice(-2), [{ role: 'assistant', content: 'Checking' }, { role: 'user', content: 'Continue.' }]);
  assert.deepEqual(request, before);
  assert.equal(buildChatRequest({ ...request, model: 'gpt-model' }, {}).body.messages.at(-1).role, 'assistant');
});
test('Gemini pending calls and completed tool returns retain protocol order', () => {
  const request = { model: 'gemini-3-pro', input: [{ type: 'function_call', call_id: 'c', name: 'read', arguments: '{}' }] };
  assert.equal(buildChatRequest(request, {}).body.messages.at(-1).role, 'assistant');
  request.input.push({ type: 'function_call_output', call_id: 'c', output: 'ok' });
  assert.equal(buildChatRequest(request, {}).body.messages.at(-1).role, 'tool');
  request.input.push({ role: 'assistant', content: 'Checked' });
  assert.equal(buildChatRequest(request, {}).body.messages.at(-1).role, 'user');
});
test('Gemini Responses sanitization appends continuation only after settled assistant commentary', () => {
  const commentary = { model: 'api-source--gemini-fixture-pro', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Work' }] }, { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking' }] }] };
  const sanitized = sanitizeResponsesBody(commentary);
  assert.deepEqual(sanitized.input.at(-1), { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] });
  const withCall = { model: 'api-source--gemini-fixture-pro', input: [...commentary.input, { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' }] };
  assert.equal(sanitizeResponsesBody(withCall).input.at(-1).type, 'function_call');
  assert.equal(sanitizeResponsesBody({ ...commentary, model: 'fixture-codex-a' }).input.at(-1).role, 'assistant');
});
