import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test-fixtures.ts'],
      thresholds: {
        statements: 98,
        branches: 90,
        functions: 100,
        lines: 98,
      },
    },
  },
});
