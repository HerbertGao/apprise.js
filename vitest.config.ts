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
      // Ratchet floor, pinned just under the measured level (92.09 / 81.35 /
      // 96.37 / 92.05). CI fails if coverage REGRESSES; raise these as gaps
      // close. Deliberately not 100%: chasing it invites vacuous assertions,
      // and the golden-differential fixtures — not this number — are the
      // correctness oracle. Coverage only answers "what is untested".
      thresholds: {
        statements: 92,
        branches: 81,
        functions: 96,
        lines: 92,
      },
    },
  },
})
