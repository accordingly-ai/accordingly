import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  test: {
    name: 'client',
    root: resolve(import.meta.dirname, '..'),
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        // Without a real URL, jsdom's origin is opaque and disables
        // localStorage / sessionStorage with a SecurityError.
        url: 'http://localhost/',
      },
    },
    include: ['src/app/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup/jsdom.ts'],
  },
});
