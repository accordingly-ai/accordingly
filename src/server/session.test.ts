import { describe, expect, it } from 'vitest';
import {
  deleteDraft,
  ensureSession,
  getDrafts,
  parseCookies,
  putDraft,
  serializeSessionCookie,
} from './session';

interface Row {
  [key: string]: unknown;
}

class StubD1 {
  sessions = new Map<string, { id: string; created_at: number; last_seen_at: number }>();
  drafts = new Map<string, { session_id: string; form_id: string; answers: string; updated_at: number }>();

  prepare(sql: string) {
    const self = this;
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        bound = args;
        return stmt;
      },
      async first<T = Row>(): Promise<T | null> {
        return self.exec(sql, bound).first as T | null;
      },
      async run() {
        return self.exec(sql, bound).run;
      },
      async all<T = Row>(): Promise<{ results: T[] }> {
        return { results: self.exec(sql, bound).all as T[] };
      },
    };
    return stmt;
  }

  private exec(sql: string, bound: unknown[]) {
    const trimmed = sql.trim();
    if (trimmed.startsWith('SELECT id, created_at AS createdAt')) {
      const id = bound[0] as string;
      const row = this.sessions.get(id);
      return {
        first: row ? { id: row.id, createdAt: row.created_at, lastSeenAt: row.last_seen_at } : null,
        run: { success: true },
        all: [],
      };
    }
    if (trimmed.startsWith('UPDATE sessions SET last_seen_at')) {
      const ts = bound[0] as number;
      const id = bound[1] as string;
      const row = this.sessions.get(id);
      if (row) row.last_seen_at = ts;
      return { first: null, run: { success: true }, all: [] };
    }
    if (trimmed.startsWith('INSERT INTO sessions')) {
      const id = bound[0] as string;
      const ts = bound[1] as number;
      this.sessions.set(id, { id, created_at: ts, last_seen_at: ts });
      return { first: null, run: { success: true }, all: [] };
    }
    if (trimmed.startsWith('SELECT form_id AS formId')) {
      const sessionId = bound[0] as string;
      const out = [...this.drafts.values()]
        .filter((d) => d.session_id === sessionId)
        .map((d) => ({ formId: d.form_id, answers: d.answers, updatedAt: d.updated_at }));
      return { first: null, run: { success: true }, all: out };
    }
    if (trimmed.startsWith('INSERT INTO form_drafts')) {
      const [sessionId, formId, answers, updatedAt] = bound as [string, string, string, number];
      this.drafts.set(`${sessionId}:${formId}`, {
        session_id: sessionId,
        form_id: formId,
        answers,
        updated_at: updatedAt,
      });
      return { first: null, run: { success: true }, all: [] };
    }
    if (trimmed.startsWith('DELETE FROM form_drafts')) {
      const [sessionId, formId] = bound as [string, string];
      this.drafts.delete(`${sessionId}:${formId}`);
      return { first: null, run: { success: true }, all: [] };
    }
    throw new Error(`unhandled SQL in stub: ${sql}`);
  }
}

const asDb = (s: StubD1) => s as unknown as D1Database;

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
    const db = new StubD1();
    const req = new Request('http://localhost/api/session');
    const result = await ensureSession(req, asDb(db));
    expect(result.isNew).toBe(true);
    expect(result.session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.setCookie).toContain(`sid=${result.session.id}`);
    expect(db.sessions.size).toBe(1);
  });

  it('reuses the session from the cookie and bumps last_seen_at', async () => {
    const db = new StubD1();
    const req1 = new Request('http://localhost/api/session');
    const r1 = await ensureSession(req1, asDb(db));
    const initialLastSeen = db.sessions.get(r1.session.id)!.last_seen_at;

    await new Promise((r) => setTimeout(r, 5));
    const req2 = new Request('http://localhost/api/session', {
      headers: { cookie: `sid=${r1.session.id}` },
    });
    const r2 = await ensureSession(req2, asDb(db));
    expect(r2.isNew).toBe(false);
    expect(r2.session.id).toBe(r1.session.id);
    expect(r2.session.lastSeenAt).toBeGreaterThanOrEqual(initialLastSeen);
    expect(db.sessions.size).toBe(1);
  });

  it('mints a new session when the cookie points at an unknown id', async () => {
    const db = new StubD1();
    const req = new Request('http://localhost/api/session', {
      headers: { cookie: 'sid=ghost' },
    });
    const result = await ensureSession(req, asDb(db));
    expect(result.isNew).toBe(true);
    expect(result.session.id).not.toBe('ghost');
  });

  it('marks the cookie Secure for https requests', async () => {
    const db = new StubD1();
    const req = new Request('https://example.com/api/session');
    const result = await ensureSession(req, asDb(db));
    expect(result.setCookie).toContain('Secure');
  });
});

describe('drafts', () => {
  it('round-trips a draft through put/get', async () => {
    const db = new StubD1();
    const req = new Request('http://localhost/api/session');
    const { session } = await ensureSession(req, asDb(db));

    const updatedAt = await putDraft(asDb(db), session.id, 'acord-125', { foo: 'bar', flag: true });
    const drafts = await getDrafts(asDb(db), session.id);
    expect(drafts['acord-125']).toEqual({
      answers: { foo: 'bar', flag: true },
      updatedAt,
    });
  });

  it('upserts on conflict', async () => {
    const db = new StubD1();
    const req = new Request('http://localhost/api/session');
    const { session } = await ensureSession(req, asDb(db));

    await putDraft(asDb(db), session.id, 'acord-125', { foo: 'a' });
    await putDraft(asDb(db), session.id, 'acord-125', { foo: 'b' });
    const drafts = await getDrafts(asDb(db), session.id);
    expect(drafts['acord-125'].answers).toEqual({ foo: 'b' });
    expect(db.drafts.size).toBe(1);
  });

  it('deletes the draft', async () => {
    const db = new StubD1();
    const req = new Request('http://localhost/api/session');
    const { session } = await ensureSession(req, asDb(db));

    await putDraft(asDb(db), session.id, 'acord-125', { foo: 'a' });
    await deleteDraft(asDb(db), session.id, 'acord-125');
    const drafts = await getDrafts(asDb(db), session.id);
    expect(drafts['acord-125']).toBeUndefined();
  });
});
