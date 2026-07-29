import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // NanoClaw fork glue — needs host session-manager/db; covered via CLI install + conformance.
        'src/sessionio-boot.ts',
        // Compile-time stubs for tsc against NanoClaw imports; not runtime package code.
        'type-fixtures/**',
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
