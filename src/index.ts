import { Router } from 'itty-router';
import { forms } from './forms';
import type { ApplicationAnswers, SessionState } from './forms/types';
import {
  deleteDraft,
  ensureSession,
  getDrafts,
  putDraft,
} from './server/session';

export interface Env {
  ENVIRONMENT: string;
  ASSETS: Fetcher;
  DB: D1Database;
}

const router = Router();

router.get('/api/health', () => Response.json({ status: 'ok' }));

router.get('/api/forms', () =>
  Response.json(
    Object.values(forms).map((f) => ({
      id: f.id,
      title: f.title,
      fieldCount: f.fields.length,
    })),
  ),
);

router.get('/api/forms/:id', ({ params }) => {
  const manifest = forms[params.id];
  if (!manifest) {
    return Response.json(
      { error: { code: 'not_found', message: `Unknown form: ${params.id}` } },
      { status: 404 },
    );
  }
  return Response.json(manifest);
});

router.get('/api/session', async (request, env: Env) => {
  const { session, isNew, setCookie } = await ensureSession(request, env.DB);
  const drafts = await getDrafts(env.DB, session.id);
  const body: SessionState = {
    sessionId: session.id,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    isNew,
    drafts,
  };
  return Response.json(body, { headers: { 'Set-Cookie': setCookie } });
});

router.put('/api/session/forms/:formId', async (request, env: Env) => {
  const formId = (request as unknown as { params: { formId: string } }).params.formId;
  if (!forms[formId]) {
    return Response.json(
      { error: { code: 'not_found', message: `Unknown form: ${formId}` } },
      { status: 404 },
    );
  }

  let payload: { answers?: unknown };
  try {
    payload = (await request.json()) as { answers?: unknown };
  } catch {
    return Response.json(
      { error: { code: 'bad_request', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }
  if (!payload || typeof payload.answers !== 'object' || payload.answers === null) {
    return Response.json(
      { error: { code: 'bad_request', message: 'Missing answers object' } },
      { status: 400 },
    );
  }

  const { session, setCookie } = await ensureSession(request, env.DB);
  const updatedAt = await putDraft(
    env.DB,
    session.id,
    formId,
    payload.answers as ApplicationAnswers,
  );
  return Response.json({ updatedAt }, { headers: { 'Set-Cookie': setCookie } });
});

router.delete('/api/session/forms/:formId', async (request, env: Env) => {
  const formId = (request as unknown as { params: { formId: string } }).params.formId;
  const { session, setCookie } = await ensureSession(request, env.DB);
  await deleteDraft(env.DB, session.id, formId);
  return new Response(null, { status: 204, headers: { 'Set-Cookie': setCookie } });
});

router.all('/api/*', () =>
  Response.json({ error: { code: 'not_found', message: 'Unknown route' } }, { status: 404 })
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return router.fetch(request, env, ctx);
  },
};
