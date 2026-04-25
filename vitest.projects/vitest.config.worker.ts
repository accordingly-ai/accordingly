import { resolve } from 'node:path';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const repoRoot = resolve(import.meta.dirname, '..');

// We don't load wrangler.toml here because its `[assets]` directory points at
// ./dist (the SPA build output), which won't exist in CI without first
// running `pnpm build`. Configure the bindings the worker needs directly.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: resolve(repoRoot, 'src/index.ts'),
      miniflare: {
        compatibilityDate: '2024-11-27',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          ENVIRONMENT: 'test',
          OPENAI_API_KEY: 'test-key',
        },
        d1Databases: ['DB'],
      },
    }),
  ],
  test: {
    name: 'worker',
    root: repoRoot,
    include: ['src/worker/**/*.test.ts'],
  },
});
