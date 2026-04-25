import { Router, type IRequest } from 'itty-router';
import { forms } from './forms';
import { FORM_TOOLS } from './forms/tools';
import type { ApplicationAnswers, FormManifest, SessionState } from './forms/types';
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
  OPENAI_API_KEY: string;
}

const router = Router<IRequest, [Env]>();

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

router.get('/api/session', async (request, env) => {
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

router.put('/api/session/forms/:formId', async (request, env) => {
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

router.delete('/api/session/forms/:formId', async (request, env) => {
  const formId = (request as unknown as { params: { formId: string } }).params.formId;
  const { session, setCookie } = await ensureSession(request, env.DB);
  await deleteDraft(env.DB, session.id, formId);
  return new Response(null, { status: 204, headers: { 'Set-Cookie': setCookie } });
});

router.post('/api/chat', async (request, env) => handleChat(request, env));

router.all('/api/*', () =>
  Response.json({ error: { code: 'not_found', message: 'Unknown route' } }, { status: 404 })
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return router.fetch(request, env, ctx);
  },
};

interface ChatRequestBody {
  formId?: string;
  messages?: unknown[];
}

function buildSystemPrompt(manifest: FormManifest): string {
  const compact = manifest.fields
    .reduce<{ name: string; type: string; label: string; options?: string[] }[]>((acc, f) => {
      if (acc.find((x) => x.name === f.name)) return acc;
      acc.push({
        name: f.name,
        type: f.type,
        label: f.label,
        ...(f.options ? { options: f.options } : {}),
      });
      return acc;
    }, []);

  return [
    `You are Accordingly, an iterative form-filling agent helping a business owner complete a commercial insurance application.`,
    `Current form: ${manifest.title} (id: ${manifest.id}).`,
    `Your job: ask focused, one-topic-at-a-time follow-up questions, then write answers to the form using the set_fields tool.`,
    `Guidelines:`,
    `- Prefer set_fields with batched updates when the user gives multiple values in one message.`,
    `- Never invent field names; only use names from the manifest below.`,
    `- For checkboxes, value must be boolean; for dropdown/radio, value must be one of the listed option strings.`,
    `- Use list_unfilled_fields to see what's still missing; use get_fields to inspect current values.`,
    `- Before overwriting a field that already has a non-empty value, confirm with the user.`,
    `- Be concise. Don't dump field lists at the user — summarize.`,
    ``,
    `Form fields (JSON):`,
    JSON.stringify(compact),
  ].join('\n');
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  if (!env.OPENAI_API_KEY) {
    return Response.json(
      { error: { code: 'misconfigured', message: 'OPENAI_API_KEY is not set' } },
      { status: 500 },
    );
  }

  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return Response.json(
      { error: { code: 'bad_request', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const { formId, messages } = body;
  if (!formId || typeof formId !== 'string') {
    return Response.json(
      { error: { code: 'bad_request', message: 'Missing formId' } },
      { status: 400 },
    );
  }
  if (!Array.isArray(messages)) {
    return Response.json(
      { error: { code: 'bad_request', message: 'messages must be an array' } },
      { status: 400 },
    );
  }
  const manifest = forms[formId];
  if (!manifest) {
    return Response.json(
      { error: { code: 'not_found', message: `Unknown form: ${formId}` } },
      { status: 404 },
    );
  }

  const fullMessages = [
    { role: 'system', content: buildSystemPrompt(manifest) },
    ...messages,
  ];

  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.4',
      stream: true,
      tools: FORM_TOOLS,
      tool_choice: 'auto',
      messages: fullMessages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return Response.json(
      {
        error: {
          code: 'upstream_error',
          message: `OpenAI request failed (${upstream.status}): ${text.slice(0, 500)}`,
        },
      },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
