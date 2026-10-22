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
      // About two points below the socket-restricted measurement (2026-10-21):
      // lines 84.04%, statements 83.79%, functions 82.51%, branches 78.96%.
      // All source files remain included; CI also runs the socket-dependent tests.
      // Raise floors as coverage improves; never lower them to make a PR pass.
      thresholds: {
        lines: 82,
        statements: 81.5,
        functions: 80.5,
        branches: 76.5
      }
    }
  }
});
