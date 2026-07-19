import { defineConfig } from 'vitest/config';

// Coverage-enforced: `npm run test:coverage` (wired into CI) fails the
// build on any regression below 100%. Genuinely-unreachable defensive
// branches are excluded inline with `/* v8 ignore next */`. The bare
// `npm test` stays coverage-free for fast local iteration.
export default defineConfig({
  test: {
    // The suite runs in ~5s locally but ~170s on the shared Gitea runner
    // (coverage instrumentation + loaded host); the 5s default trips there.
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts', // stdio entry point — not unit-testable
        'src/http.ts',  // Streamable-HTTP entry point — exercised by the deploy smoke test
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
