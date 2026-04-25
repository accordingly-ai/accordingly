import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      './vitest.projects/vitest.config.unit.ts',
      './vitest.projects/vitest.config.client.ts',
      './vitest.projects/vitest.config.worker.ts',
    ],
  },
});
