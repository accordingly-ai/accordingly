import { Router } from 'itty-router';
import { forms } from './forms';

export interface Env {
  ENVIRONMENT: string;
  ASSETS: Fetcher;
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

router.all('/api/*', () =>
  Response.json({ error: { code: 'not_found', message: 'Unknown route' } }, { status: 404 })
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return router.fetch(request, env, ctx);
  },
};
