import { SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTables, setupSchema } from './test-helpers';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      OPENAI_API_KEY: string;
      ENVIRONMENT: string;
    }
  }
}

beforeAll(setupSchema);
beforeEach(clearTables);
afterEach(() => {
  vi.unstubAllGlobals();
});

interface ChatCompletionRequest {
  messages: { role: string; content: string }[];
}

function captureOpenAIBody(): { read: () => ChatCompletionRequest } {
  let captured: ChatCompletionRequest | null = null;
  const sseBody = ['data: {"choices":[{"delta":{"content":"ok"}}]}', '', 'data: [DONE]', ''].join('\n');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.startsWith('https://api.openai.com/')) {
        if (init?.body && typeof init.body === 'string') {
          captured = JSON.parse(init.body) as ChatCompletionRequest;
        }
        return new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return {
    read() {
      if (!captured) throw new Error('OpenAI fetch was never called');
      return captured;
    },
  };
}

describe('buildSystemPrompt (via /api/chat)', () => {
  it('includes the friendly opener and the form id', async () => {
    const cap = captureOpenAIBody();
    const res = await SELF.fetch('https://test.local/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        formId: 'acord-125',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const body = cap.read();
    const sys = body.messages.find((m) => m.role === 'system');
    expect(sys).toBeDefined();
    expect(sys!.content).toContain('friendly and competent insurance assistant');
    expect(sys!.content).toContain('acord-125');
  });

  it('omits Drive guidance when driveConnected is false', async () => {
    const cap = captureOpenAIBody();
    await SELF.fetch('https://test.local/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        formId: 'acord-125',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }).then((r) => r.text());

    const sys = cap.read().messages.find((m) => m.role === 'system')!;
    expect(sys.content).not.toContain('list_drive_files');
    expect(sys.content).not.toContain('Google Drive');
  });

  it('includes Drive guidance when driveConnected is true', async () => {
    const cap = captureOpenAIBody();
    await SELF.fetch('https://test.local/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        formId: 'acord-125',
        messages: [{ role: 'user', content: 'hi' }],
        driveConnected: true,
      }),
    }).then((r) => r.text());

    const sys = cap.read().messages.find((m) => m.role === 'system')!;
    expect(sys.content).toContain('list_drive_files');
    expect(sys.content).toContain('read_drive_file');
    expect(sys.content).toContain('Google Drive');
  });
});

describe('Cross-Origin-Opener-Policy header', () => {
  it('is set on /api/health success responses', async () => {
    const res = await SELF.fetch('https://test.local/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
  });

  it('is set on the /api/* 404 fallback', async () => {
    const res = await SELF.fetch('https://test.local/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
  });
});
