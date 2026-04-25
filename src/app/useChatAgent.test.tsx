import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationAnswers, FormManifest } from '../forms/types';
import { useChatAgent } from './useChatAgent';

const manifest: FormManifest = {
  id: 'test-form',
  title: 'Test Form',
  fields: [
    {
      name: 'business-name',
      pdfName: 'BusinessName',
      type: 'text',
      label: 'Business Name',
      page: 0,
      rect: [0, 0, 10, 10],
    },
  ],
};

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(enc.encode(`data: ${evt}\n\n`));
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function sseResponse(events: string[]): Response {
  return new Response(sseStream(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function setup(answers: ApplicationAnswers = {}, formId = 'test-form') {
  const updates: Record<string, string | boolean | null>[] = [];
  const applyUpdates = vi.fn((u: Record<string, string | boolean | null>) => {
    updates.push(u);
  });
  const hook = renderHook((props: { answers: ApplicationAnswers }) =>
    useChatAgent({ formId, manifest, answers: props.answers, applyUpdates }),
    { initialProps: { answers } },
  );
  return { hook, applyUpdates, updates };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useChatAgent', () => {
  it('streams content deltas into a single assistant message', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        '{"choices":[{"delta":{"content":"Hello "}}]}',
        '{"choices":[{"delta":{"content":"there"}}]}',
        '{"choices":[{"delta":{"content":"!"}}]}',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));

    await act(async () => {
      await hook.result.current.sendMessage('hi');
    });

    const msgs = hook.result.current.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'user', content: 'hi' });
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toBe('Hello there!');
    expect(msgs[1].tool_calls).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('executes tool calls and feeds results back into a follow-up round', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return sseResponse([
          // tool call delta split across two chunks
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"set_fields","arguments":"{\\"updates\\":"}}]}}]}',
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"[{\\"name\\":\\"business-name\\",\\"value\\":\\"Acme\\"}]}"}}]}}]}',
        ]);
      }
      return sseResponse([
        '{"choices":[{"delta":{"content":"All set."}}]}',
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { hook, applyUpdates, updates } = setup();
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));

    await act(async () => {
      await hook.result.current.sendMessage('save my name');
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(applyUpdates).toHaveBeenCalledTimes(1);
    expect(updates[0]).toEqual({ 'business-name': 'Acme' });

    const msgs = hook.result.current.messages;
    // user, assistant(with tool_call), tool, assistant(final)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(msgs[3].content).toBe('All set.');
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.streaming).toBe(false);
  });

  it('caps the agent loop at MAX_TOOL_ROUNDS rounds', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"list_unfilled_fields","arguments":"{}"}}]}}]}',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));

    await act(async () => {
      await hook.result.current.sendMessage('loop forever');
    });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(hook.result.current.error).toBe('Stopped after maximum tool-call rounds.');
  });

  it('persists messages to localStorage across success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(['{"choices":[{"delta":{"content":"hi back"}}]}']),
      ),
    );
    const { hook } = setup({}, 'storage-form');
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));

    await act(async () => {
      await hook.result.current.sendMessage('hi');
    });

    const raw = localStorage.getItem('accordingly:chat:storage-form');
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!) as { role: string; content: string }[];
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(stored[1].content).toBe('hi back');
  });

  it('records an error and persists the user message when the network fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const { hook } = setup({}, 'failure-form');
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));

    await act(async () => {
      await hook.result.current.sendMessage('hello');
    });

    expect(hook.result.current.error).toBeTruthy();
    expect(hook.result.current.streaming).toBe(false);
    // the user's message stays in history even after failure
    const stored = JSON.parse(
      localStorage.getItem('accordingly:chat:failure-form') ?? '[]',
    ) as { role: string }[];
    expect(stored[0]?.role).toBe('user');
  });
});
