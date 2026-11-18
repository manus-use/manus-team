import { defineConfig } from 'vitest/config';

// Two projects, deliberately separate. A global `fileParallelism: false` added for a
// subprocess-heavy suite silently leaks onto every unit file and costs an order of
// magnitude in wall-clock. See docs/specs/2026-08-21-lark-channel-design.md §10.
// Both run tests/helpers/git-setup.ts first, so no git a test causes reads the user's git configuration.
const setupFiles = ['tests/helpers/git-setup.ts'];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          fileParallelism: true,
          setupFiles,
          testTimeout: 10_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/**/*.e2e.ts'],
          fileParallelism: false,
          setupFiles,
          testTimeout: 60_000,
        },
      },
    ],
  },
});
