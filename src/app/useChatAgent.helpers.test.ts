import { describe, expect, it } from 'vitest';
import {
  accumulatorToMessage,
  applyDelta,
  toApiMessage,
  type AssistantAccumulator,
  type ChatMessage,
  type ToolCall,
} from './useChatAgent';

const fresh = (): AssistantAccumulator => ({ content: '', toolCalls: new Map() });

describe('applyDelta', () => {
  it('appends content fragments', () => {
    const acc = fresh();
    applyDelta(acc, { content: 'Hello' });
    applyDelta(acc, { content: ', world!' });
    expect(acc.content).toBe('Hello, world!');
  });

  it('accumulates a single tool call across multiple deltas', () => {
    const acc = fresh();
    applyDelta(acc, {
      tool_calls: [{ index: 0, id: 'call_1', function: { name: 'set_fields' } }],
    });
    applyDelta(acc, {
      tool_calls: [{ index: 0, function: { arguments: '{"updates":' } }],
    });
    applyDelta(acc, {
      tool_calls: [{ index: 0, function: { arguments: '[{"name":"x","value":"y"}]}' } }],
    });
    expect(acc.toolCalls.get(0)).toEqual({
      id: 'call_1',
      name: 'set_fields',
      arguments: '{"updates":[{"name":"x","value":"y"}]}',
    });
  });

  it('handles multiple parallel tool calls keyed by index', () => {
    const acc = fresh();
    applyDelta(acc, {
      tool_calls: [
        { index: 0, id: 'a', function: { name: 'list_unfilled_fields', arguments: '{}' } },
        { index: 1, id: 'b', function: { name: 'get_fields', arguments: '{"names":["x"]}' } },
      ],
    });
    expect(acc.toolCalls.size).toBe(2);
    expect(acc.toolCalls.get(0)?.name).toBe('list_unfilled_fields');
    expect(acc.toolCalls.get(1)?.name).toBe('get_fields');
  });

  it('is a no-op for an empty delta', () => {
    const acc = fresh();
    applyDelta(acc, {});
    expect(acc.content).toBe('');
    expect(acc.toolCalls.size).toBe(0);
  });
});

describe('accumulatorToMessage', () => {
  it('returns an assistant message with content and no tool calls when none accumulated', () => {
    const acc = fresh();
    acc.content = 'hi';
    expect(accumulatorToMessage(acc)).toEqual({ role: 'assistant', content: 'hi' });
  });

  it('includes tool calls sorted by their original index', () => {
    const acc = fresh();
    acc.toolCalls.set(2, { id: 'c', name: 'third', arguments: '' });
    acc.toolCalls.set(0, { id: 'a', name: 'first', arguments: '' });
    acc.toolCalls.set(1, { id: 'b', name: 'second', arguments: '' });
    const msg = accumulatorToMessage(acc);
    expect(msg.tool_calls?.map((tc: ToolCall) => tc.name)).toEqual(['first', 'second', 'third']);
  });
});

describe('toApiMessage', () => {
  it('serializes a user message verbatim', () => {
    const m: ChatMessage = { role: 'user', content: 'Acme' };
    expect(toApiMessage(m)).toEqual({ role: 'user', content: 'Acme' });
  });

  it('shapes assistant tool_calls into the OpenAI function-call format', () => {
    const m: ChatMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', name: 'set_fields', arguments: '{"updates":[]}' }],
    };
    expect(toApiMessage(m)).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'set_fields', arguments: '{"updates":[]}' },
        },
      ],
    });
  });

  it('emits a tool message with tool_call_id and content', () => {
    const m: ChatMessage = {
      role: 'tool',
      tool_call_id: 'call_1',
      name: 'set_fields',
      content: '{"applied":[]}',
    };
    expect(toApiMessage(m)).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"applied":[]}',
    });
  });

  it('omits tool_calls field on assistant messages with no calls', () => {
    const m: ChatMessage = { role: 'assistant', content: 'done' };
    const out = toApiMessage(m);
    expect(out).toEqual({ role: 'assistant', content: 'done' });
    expect('tool_calls' in out).toBe(false);
  });

  it('folds user attachments into the content sent to the model', () => {
    const m: ChatMessage = {
      role: 'user',
      content: 'What is the policy number?',
      attachments: [
        {
          name: 'invoice.pdf',
          mimeType: 'application/pdf',
          text: 'Policy 12345',
        },
        {
          name: 'note.txt',
          mimeType: 'text/plain',
          text: 'see attached',
          truncated: true,
        },
      ],
    };
    expect(toApiMessage(m)).toEqual({
      role: 'user',
      content:
        'What is the policy number?\n\n' +
        '[Attachment: invoice.pdf (application/pdf)]\nPolicy 12345\n[/Attachment]\n\n' +
        '[Attachment: note.txt (text/plain, truncated)]\nsee attached\n[/Attachment]',
    });
  });

  it('serializes attachments alone when user content is empty', () => {
    const m: ChatMessage = {
      role: 'user',
      content: '',
      attachments: [
        { name: 'a.md', mimeType: 'text/markdown', text: '# hello' },
      ],
    };
    expect(toApiMessage(m)).toEqual({
      role: 'user',
      content: '[Attachment: a.md (text/markdown)]\n# hello\n[/Attachment]',
    });
  });
});
