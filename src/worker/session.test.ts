import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteDraft,
  ensureSession,
  getDrafts,
  parseCookies,
  putDraft,
  serializeSessionCookie,
} from '../server/session';
import { clearTables, setupSchema } from './test-helpers';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
    }
  }
}

beforeAll(setupSchema);
beforeEach(clearTables);

describe('parseCookies', () => {
  it('parses a single cookie', () => {
    expect(parseCookies('sid=abc')).toEqual({ sid: 'abc' });
  });

  it('parses multiple cookies and trims whitespace', () => {
    expect(parseCookies('sid=abc; foo=bar; baz=qux')).toEqual({
      sid: 'abc',
      foo: 'bar',
      baz: 'qux',
    });
  });

  it('decodes percent-encoded values', () => {
    expect(parseCookies('sid=hello%20world')).toEqual({ sid: 'hello world' });
  });

  it('returns empty object for null/empty header', () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  it('ignores parts without =', () => {
    expect(parseCookies('foo; bar=baz')).toEqual({ bar: 'baz' });
  });
});

describe('serializeSessionCookie', () => {
  it('omits Secure on http', () => {
    const c = serializeSessionCookie('abc', false);
    expect(c).toContain('sid=abc');
    expect(c).toContain('Path=/');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Max-Age=');
    expect(c).not.toContain('Secure');
  });

  it('adds Secure on https', () => {
    const c = serializeSessionCookie('abc', true);
    expect(c).toContain('Secure');
  });

  it('encodes the session id', () => {
    expect(serializeSessionCookie('a/b c', false)).toContain('sid=a%2Fb%20c');
  });
});

describe('ensureSession', () => {
  it('mints a new session when no cookie is present', async () => {
    const req = new Request('http://localhost/api/session');
    const result = await ensureSession(req, env.DB);
    expect(result.isNew).toBe(true);
    expect(result.session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.setCookie).toContain(`sid=${result.session.id}`);
  });

  it('reuses the session from the cookie and bumps last_seen_at', async () => {
    const req1 = new Request('http://localhost/api/session');
    const r1 = await ensureSession(req1, env.DB);

    await new Promise((r) => setTimeout(r, 5));
    const req2 = new Request('http://localhost/api/session', {
      headers: { cookie: `sid=${r1.session.id}` },
    });
    const r2 = await ensureSession(req2, env.DB);
    expect(r2.isNew).toBe(false);
    expect(r2.session.id).toBe(r1.session.id);
    expect(r2.session.lastSeenAt).toBeGreaterThanOrEqual(r1.session.lastSeenAt);
  });

  it('mints a new session when the cookie points at an unknown id', async () => {
    const req = new Request('http://localhost/api/session', {
      headers: { cookie: 'sid=ghost' },
    });
    const result = await ensureSession(req, env.DB);
    expect(result.isNew).toBe(true);
    expect(result.session.id).not.toBe('ghost');
  });

  it('marks the cookie Secure for https requests', async () => {
    const req = new Request('https://example.com/api/session');
    const result = await ensureSession(req, env.DB);
    expect(result.setCookie).toContain('Secure');
  });
});

describe('drafts', () => {
  it('round-trips a draft through put/get', async () => {
    const req = new Request('http://localhost/api/session');
    const { session } = await ensureSession(req, env.DB);

    const updatedAt = await putDraft(env.DB, session.id, 'acord-125', {
      foo: 'bar',
      flag: true,
    });
    const drafts = await getDrafts(env.DB, session.id);
    expect(drafts['acord-125']).toEqual({
      answers: { foo: 'bar', flag: true },
      updatedAt,
    });
  });

  it('upserts on conflict', async () => {
    const req = new Request('http://localhost/api/session');
    const { session } = await ensureSession(req, env.DB);

    await putDraft(env.DB, session.id, 'acord-125', { foo: 'a' });
    await putDraft(env.DB, session.id, 'acord-125', { foo: 'b' });
    const drafts = await getDrafts(env.DB, session.id);
    expect(drafts['acord-125'].answers).toEqual({ foo: 'b' });
  });

  it('deletes the draft', async () => {
    const req = new Request('http://localhost/api/session');
    const { session } = await ensureSession(req, env.DB);

    await putDraft(env.DB, session.id, 'acord-125', { foo: 'a' });
    await deleteDraft(env.DB, session.id, 'acord-125');
    const drafts = await getDrafts(env.DB, session.id);
    expect(drafts['acord-125']).toBeUndefined();
  });
});
