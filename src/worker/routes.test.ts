import { SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { forms } from '../forms';
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

function setCookieToCookie(setCookie: string | null): string {
  if (!setCookie) return '';
  return setCookie.split(';')[0];
}

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await SELF.fetch('https://test.local/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /api/forms', () => {
  it('lists every loaded form with metadata', async () => {
    const res = await SELF.fetch('https://test.local/api/forms');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; title: string; fieldCount: number }[];
    const ids = body.map((f) => f.id).sort();
    expect(ids).toEqual(Object.keys(forms).sort());
    for (const f of body) {
      expect(f.fieldCount).toBeGreaterThan(0);
    }
  });
});

describe('GET /api/forms/:id', () => {
  it('returns the manifest for a known form', async () => {
    const res = await SELF.fetch('https://test.local/api/forms/acord-125');
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as { id: string };
    expect(manifest.id).toBe('acord-125');
  });

  it('404s on unknown id', async () => {
    const res = await SELF.fetch('https://test.local/api/forms/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

describe('GET /api/session', () => {
  it('mints a sid cookie on first visit and reuses it on the second', async () => {
    const r1 = await SELF.fetch('https://test.local/api/session');
    expect(r1.status).toBe(200);
    const cookie1 = r1.headers.get('set-cookie');
    expect(cookie1).toMatch(/^sid=/);
    const body1 = (await r1.json()) as { sessionId: string; isNew: boolean; drafts: object };
    expect(body1.isNew).toBe(true);
    expect(body1.drafts).toEqual({});

    const r2 = await SELF.fetch('https://test.local/api/session', {
      headers: { cookie: setCookieToCookie(cookie1) },
    });
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as { sessionId: string; isNew: boolean };
    expect(body2.isNew).toBe(false);
    expect(body2.sessionId).toBe(body1.sessionId);
  });

  it('reflects drafts written via PUT', async () => {
    const r1 = await SELF.fetch('https://test.local/api/session');
    const cookie = setCookieToCookie(r1.headers.get('set-cookie'));

    const put = await SELF.fetch('https://test.local/api/session/forms/acord-125', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ answers: { 'business-name': 'Acme' } }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { updatedAt: number };
    expect(putBody.updatedAt).toBeGreaterThan(0);

    const r2 = await SELF.fetch('https://test.local/api/session', { headers: { cookie } });
    const body2 = (await r2.json()) as {
      drafts: Record<string, { answers: Record<string, unknown>; updatedAt: number }>;
    };
    expect(body2.drafts['acord-125'].answers).toEqual({ 'business-name': 'Acme' });
    expect(body2.drafts['acord-125'].updatedAt).toBe(putBody.updatedAt);
  });
});

describe('PUT /api/session/forms/:formId', () => {
  it('404s on unknown formId', async () => {
    const res = await SELF.fetch('https://test.local/api/session/forms/nope', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: {} }),
    });
    expect(res.status).toBe(404);
  });

  it('400s on malformed JSON', async () => {
    const res = await SELF.fetch('https://test.local/api/session/forms/acord-125', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });

  it('400s when answers is missing', async () => {
    const res = await SELF.fetch('https://test.local/api/session/forms/acord-125', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/session/forms/:formId', () => {
  it('round-trips a draft delete', async () => {
    const r1 = await SELF.fetch('https://test.local/api/session');
    const cookie = setCookieToCookie(r1.headers.get('set-cookie'));

    await SELF.fetch('https://test.local/api/session/forms/acord-125', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ answers: { foo: 'bar' } }),
    });

    const del = await SELF.fetch('https://test.local/api/session/forms/acord-125', {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(del.status).toBe(204);

    const after = await SELF.fetch('https://test.local/api/session', { headers: { cookie } });
    const body = (await after.json()) as { drafts: Record<string, unknown> };
    expect(body.drafts['acord-125']).toBeUndefined();
  });
});

describe('POST /api/chat', () => {
  it('400s when formId is missing', async () => {
    const res = await SELF.fetch('https://test.local/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('400s when messages is not an array', async () => {
    const res = await SELF.fetch('https://test.local/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'acord-125', messages: 'no' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s when formId is unknown', async () => {
    const res = await SELF.fetch('https://test.local/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'nope', messages: [] }),
    });
    expect(res.status).toBe(404);
  });

  it('proxies an SSE response from upstream OpenAI', async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://api.openai.com/')) {
        // Construct the Response inside the mock so its body stream lives
        // in the worker's request context, not the test runner's.
        return new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await SELF.fetch('https://test.local/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        formId: 'acord-125',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await res.text();
    expect(text).toContain('Hello');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns 502 when upstream errors out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith('https://api.openai.com/')) {
          return new Response('boom', { status: 500 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const res = await SELF.fetch('https://test.local/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'acord-125', messages: [] }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('upstream_error');
  });
});

describe('unknown /api/* route', () => {
  it('returns 404 with the standard error shape', async () => {
    const res = await SELF.fetch('https://test.local/api/does-not-exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});
