import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Each workspace package has its own vitest.config.ts (defineProject).
    projects: ['apps/*', 'packages/*', 'data/*'],
    // Coverage can only be configured at the root.
    coverage: {
      provider: 'v8',
      include: ['{apps,packages,data}/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', '**/*.d.ts', '**/*.gen.ts', '**/test/**', '**/main.tsx'],
      thresholds: {
        // The transform engine is the heart of the project: keep it thoroughly tested.
        'packages/theory/src/**': {
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90,
        },
      },
    },
  },
})
