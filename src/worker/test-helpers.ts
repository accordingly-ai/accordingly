import { applyD1Migrations, env } from 'cloudflare:test';

export const MIGRATIONS = [
  {
    name: '0001_session_state',
    queries: [
      `CREATE TABLE sessions (
        id           TEXT PRIMARY KEY,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )`,
      `CREATE TABLE form_drafts (
        session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        form_id    TEXT    NOT NULL,
        answers    TEXT    NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, form_id)
      )`,
      `CREATE INDEX idx_form_drafts_session ON form_drafts (session_id)`,
    ],
  },
];

export async function setupSchema(): Promise<void> {
  await applyD1Migrations(env.DB, MIGRATIONS);
}

export async function clearTables(): Promise<void> {
  await env.DB.exec('DELETE FROM form_drafts');
  await env.DB.exec('DELETE FROM sessions');
}
