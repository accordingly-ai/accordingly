import type { ApplicationAnswers, FormDraft } from '../forms/types';

const COOKIE_NAME = 'sid';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2; // 2 years

export interface SessionRow {
  id: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface EnsureSessionResult {
  session: SessionRow;
  isNew: boolean;
  setCookie: string;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function serializeSessionCookie(sessionId: string, isHttps: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

export async function ensureSession(
  request: Request,
  db: D1Database,
): Promise<EnsureSessionResult> {
  const cookies = parseCookies(request.headers.get('cookie'));
  const provided = cookies[COOKIE_NAME];
  const now = Date.now();
  const isHttps = new URL(request.url).protocol === 'https:';

  if (provided) {
    const existing = await db
      .prepare('SELECT id, created_at AS createdAt, last_seen_at AS lastSeenAt FROM sessions WHERE id = ?1')
      .bind(provided)
      .first<SessionRow>();
    if (existing) {
      await db
        .prepare('UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2')
        .bind(now, existing.id)
        .run();
      return {
        session: { ...existing, lastSeenAt: now },
        isNew: false,
        setCookie: serializeSessionCookie(existing.id, isHttps),
      };
    }
  }

  const id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO sessions (id, created_at, last_seen_at) VALUES (?1, ?2, ?2)')
    .bind(id, now)
    .run();
  return {
    session: { id, createdAt: now, lastSeenAt: now },
    isNew: true,
    setCookie: serializeSessionCookie(id, isHttps),
  };
}

interface DraftRow {
  formId: string;
  answers: string;
  updatedAt: number;
}

export async function getDrafts(
  db: D1Database,
  sessionId: string,
): Promise<Record<string, FormDraft>> {
  const result = await db
    .prepare(
      'SELECT form_id AS formId, answers, updated_at AS updatedAt FROM form_drafts WHERE session_id = ?1',
    )
    .bind(sessionId)
    .all<DraftRow>();
  const out: Record<string, FormDraft> = {};
  for (const row of result.results ?? []) {
    let parsed: ApplicationAnswers = {};
    try {
      parsed = JSON.parse(row.answers) as ApplicationAnswers;
    } catch {
      parsed = {};
    }
    out[row.formId] = { answers: parsed, updatedAt: row.updatedAt };
  }
  return out;
}

export async function putDraft(
  db: D1Database,
  sessionId: string,
  formId: string,
  answers: ApplicationAnswers,
): Promise<number> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO form_drafts (session_id, form_id, answers, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(session_id, form_id) DO UPDATE SET
         answers = excluded.answers,
         updated_at = excluded.updated_at`,
    )
    .bind(sessionId, formId, JSON.stringify(answers), now)
    .run();
  return now;
}

export async function deleteDraft(
  db: D1Database,
  sessionId: string,
  formId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM form_drafts WHERE session_id = ?1 AND form_id = ?2')
    .bind(sessionId, formId)
    .run();
}
