import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure logic only — these tests never touch the VS Code API, so the default
    // node environment is enough (and fast). Scope to *.test.ts under src/.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
