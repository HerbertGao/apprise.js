import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Only the shipped source is measured (tests / harness / configs are not).
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      // Ratchet floor, pinned just under the measured level (91.24 / 79.32 /
      // 95.65 / 91.20). CI fails if coverage REGRESSES; raise these as gaps
      // close. Deliberately not 100%: chasing it invites vacuous assertions,
      // and the golden-differential fixtures — not this number — are the
      // correctness oracle. Coverage only answers "what is untested".
      thresholds: {
        statements: 91,
        branches: 79,
        functions: 95,
        lines: 91,
      },
    },
  },
})
