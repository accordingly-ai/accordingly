import { Router, type IRequest } from 'itty-router';
import { forms } from './forms';
import { FORM_TOOLS } from './forms/tools';
import { DRIVE_TOOLS } from './forms/drive-tools';
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
router.post('/api/transcribe', async (request, env) => handleTranscribe(request, env));
router.post('/api/speak', async (request, env) => handleSpeak(request, env));

router.post('/api/extract-document', async (request, env) =>
  handleExtractDocument(request, env),
);

router.all('/api/*', () =>
  Response.json({ error: { code: 'not_found', message: 'Unknown route' } }, { status: 404 })
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const res = (await router.fetch(request, env, ctx)) as Response;
    try {
      res.headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
      return res;
    } catch {
      const cloned = new Response(res.body, res);
      cloned.headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
      return cloned;
    }
  },
};

interface ChatRequestBody {
  formId?: string;
  messages?: unknown[];
  driveConnected?: boolean;
}

function buildSystemPrompt(manifest: FormManifest, driveConnected: boolean): string {
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
    `You are a friendly and competent insurance assistant, filling out an application form while making conversation with the customer. You're focused on moving the process forward — offer the user the option to upload or provide files to speed things up. Read everything you get in detail and fill in the form. Then clarify any remaining questions and complete the form. If the client is hesitant, be understanding and move the process along professionally. Once done, ask the client to look over the form and then submit it.`,
    ``,
    `Current form: ${manifest.title} (id: ${manifest.id}).`,
    `Your job: ask focused, one-topic-at-a-time follow-up questions, then write answers to the form using the set_fields tool.`,
    `Guidelines:`,
    `- Prefer set_fields with batched updates when the user gives multiple values in one message.`,
    `- Never invent field names; only use names from the manifest below.`,
    `- For checkboxes, value must be boolean; for dropdown/radio, value must be one of the listed option strings.`,
    `- Use list_unfilled_fields to see what's still missing; use get_fields to inspect current values.`,
    `- Before overwriting a field that already has a non-empty value, confirm with the user.`,
    `- Be concise. Don't dump field lists at the user — summarize.`,
    ...(driveConnected
      ? [
          `- The user has connected Google Drive files. Use list_drive_files to see them and read_drive_file to read their contents. Prefer reading connected files over asking the user for information that's likely in them (prior policies, leases, IDs, business records).`,
        ]
      : []),
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

  const { formId, messages, driveConnected } = body;
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
    { role: 'system', content: buildSystemPrompt(manifest, Boolean(driveConnected)) },
    ...messages,
  ];

  const tools = driveConnected ? [...FORM_TOOLS, ...DRIVE_TOOLS] : FORM_TOOLS;

  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.4',
      stream: true,
      tools,
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

const MAX_TRANSCRIBE_BYTES = 10 * 1024 * 1024;

async function handleTranscribe(request: Request, env: Env): Promise<Response> {
  if (!env.OPENAI_API_KEY) {
    return Response.json(
      { error: { code: 'misconfigured', message: 'OPENAI_API_KEY is not set' } },
      { status: 500 },
    );
  }

  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength && contentLength > MAX_TRANSCRIBE_BYTES) {
    return Response.json(
      { error: { code: 'payload_too_large', message: 'Audio exceeds 10 MB limit' } },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: { code: 'bad_request', message: 'Expected multipart/form-data' } },
      { status: 400 },
    );
  }

  const file = form.get('file');
  if (!file || typeof file === 'string' || !(file instanceof Blob)) {
    return Response.json(
      { error: { code: 'bad_request', message: 'Missing file field' } },
      { status: 400 },
    );
  }
  if (file.size > MAX_TRANSCRIBE_BYTES) {
    return Response.json(
      { error: { code: 'payload_too_large', message: 'Audio exceeds 10 MB limit' } },
      { status: 413 },
    );
  }

  const filename =
    typeof (file as { name?: unknown }).name === 'string' && (file as { name: string }).name
      ? (file as { name: string }).name
      : 'audio.webm';
  const upstreamForm = new FormData();
  upstreamForm.append('file', file, filename);
  upstreamForm.append('model', 'whisper-1');

  const upstream = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: upstreamForm,
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    console.error('transcribe upstream', upstream.status, text);
    return Response.json(
      {
        error: {
          code: 'upstream_error',
          message: `OpenAI transcription failed (${upstream.status}): ${text.slice(0, 500)}`,
        },
      },
      { status: 502 },
    );
  }

  const data = (await upstream.json().catch(() => null)) as { text?: string } | null;
  if (!data || typeof data.text !== 'string') {
    return Response.json(
      { error: { code: 'upstream_error', message: 'OpenAI transcription returned unexpected payload' } },
      { status: 502 },
    );
  }
  return Response.json({ text: data.text });
}

const MAX_TTS_INPUT = 4000;

async function handleSpeak(request: Request, env: Env): Promise<Response> {
  if (!env.OPENAI_API_KEY) {
    return Response.json(
      { error: { code: 'misconfigured', message: 'OPENAI_API_KEY is not set' } },
      { status: 500 },
    );
  }

  let body: { text?: unknown; voice?: unknown };
  try {
    body = (await request.json()) as { text?: unknown; voice?: unknown };
  } catch {
    return Response.json(
      { error: { code: 'bad_request', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const text = typeof body.text === 'string' ? body.text.slice(0, MAX_TTS_INPUT) : '';
  if (!text) {
    return Response.json(
      { error: { code: 'bad_request', message: 'Missing text' } },
      { status: 400 },
    );
  }
  const voice = typeof body.voice === 'string' && body.voice ? body.voice : 'alloy';

  const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice,
      response_format: 'mp3',
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return Response.json(
      {
        error: {
          code: 'upstream_error',
          message: `OpenAI TTS failed (${upstream.status}): ${detail.slice(0, 500)}`,
        },
      },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store',
    },
  });
}

interface ExtractRequestBody {
  data?: string;
  mimeType?: string;
  filename?: string;
}

const EXTRACT_PROMPT =
  'Extract all text and structured data from this document. Preserve labels and values verbatim. Return only the extracted content — no commentary, headings, or formatting beyond what reflects the source.';

async function handleExtractDocument(request: Request, env: Env): Promise<Response> {
  if (!env.OPENAI_API_KEY) {
    return Response.json(
      { error: { code: 'misconfigured', message: 'OPENAI_API_KEY is not set' } },
      { status: 500 },
    );
  }

  let body: ExtractRequestBody;
  try {
    body = (await request.json()) as ExtractRequestBody;
  } catch {
    return Response.json(
      { error: { code: 'bad_request', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const { data, mimeType, filename } = body;
  if (!data || typeof data !== 'string') {
    return Response.json(
      { error: { code: 'bad_request', message: 'Missing data (base64)' } },
      { status: 400 },
    );
  }
  if (!mimeType || typeof mimeType !== 'string') {
    return Response.json(
      { error: { code: 'bad_request', message: 'Missing mimeType' } },
      { status: 400 },
    );
  }

  const isPdf = mimeType === 'application/pdf';
  const isImage = mimeType.startsWith('image/');
  if (!isPdf && !isImage) {
    return Response.json(
      { error: { code: 'bad_request', message: `Unsupported mimeType: ${mimeType}` } },
      { status: 400 },
    );
  }

  const dataUrl = `data:${mimeType};base64,${data}`;
  const userContent: unknown[] = [{ type: 'text', text: EXTRACT_PROMPT }];
  if (isPdf) {
    userContent.push({
      type: 'file',
      file: { filename: filename || 'document.pdf', file_data: dataUrl },
    });
  } else {
    userContent.push({ type: 'image_url', image_url: { url: dataUrl } });
  }

  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return Response.json(
      {
        error: {
          code: 'upstream_error',
          message: `OpenAI extract failed (${upstream.status}): ${text.slice(0, 500)}`,
        },
      },
      { status: 502 },
    );
  }

  const json = (await upstream.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content ?? '';
  return Response.json({ text });
}
