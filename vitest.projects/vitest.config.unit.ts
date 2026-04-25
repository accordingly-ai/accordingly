import { resolve } from 'node:path';
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'unit',
    root: resolve(import.meta.dirname, '..'),
    environment: 'node',
    include: [
      'src/forms/**/*.test.ts',
      'src/server/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
  },
});
