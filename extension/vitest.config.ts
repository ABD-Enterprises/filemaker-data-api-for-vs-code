import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: true,
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/webviews/*/ui/**'],
      // Floors about three points under the measured baseline (2026-10-20: lines 77.8%,
      // statements 77.7%, functions 77.9%, branches 73.0%), allowing for platform
      // differences. Raise them as coverage improves; never lower them to make a PR pass.
      thresholds: {
        lines: 74,
        statements: 74,
        functions: 74,
        branches: 69
      }
    }
  }
});
