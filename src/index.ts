import { Router } from 'itty-router';

export interface Env {
  ENVIRONMENT: string;
  ASSETS: Fetcher;
}

const router = Router();

router.get('/api/health', () => Response.json({ status: 'ok' }));

router.all('/api/*', () =>
  Response.json({ error: { code: 'not_found', message: 'Unknown route' } }, { status: 404 })
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return router.fetch(request, env, ctx);
  },
};
