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
      // Floors a couple of points under the measured baseline (2026-10-17: lines 62%,
      // statements 62%, functions 65%, branches 52%) so a real drop fails CI. Raise
      // them as coverage improves; never lower them to make a PR pass.
      thresholds: {
        lines: 60,
        statements: 60,
        functions: 63,
        branches: 50
      }
    }
  }
});
