import { GIT_ISOLATION } from './git.js';

/**
 * Run before every test file, unit and e2e (vitest.config.ts's setupFiles):
 * git's isolation set on the process itself, so git that source code starts
 * with the process's environment never reads the user's global or system
 * configuration. A test that starts git, or names a global file of its own,
 * still passes its own environment through tests/helpers/git.ts.
 */
for (const [key, value] of Object.entries(GIT_ISOLATION)) process.env[key] = value;
