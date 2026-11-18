import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLE_MD_UNREADABLE, roleMdFirstLine } from '../src/roles.js';

/**
 * `roleMdFirstLine` against a FIFO swapped in for `role.md` after its lstat
 * (the tier grants spec §13.2): the open must not wait for a writer, and the
 * fstat then refuses it. The lstat is made to see a regular file, as it would
 * have before the swap.
 */

const swapped = new Set<string>();
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  const lstatSync = ((path: fs.PathLike, ...rest: unknown[]) =>
    swapped.has(String(path)) ? { ...real.statSync(import.meta.filename), isFile: () => true } : (real.lstatSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof real.lstatSync;
  return { ...real, lstatSync };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-roles-fifo-'));
});
afterEach(() => {
  swapped.clear();
  rmSync(dir, { recursive: true, force: true });
});

const hasMkfifo = process.platform !== 'win32' && spawnSync('mkfifo', ['--version']).error === undefined;

describe('roleMdFirstLine and a FIFO', () => {
  it.skipIf(!hasMkfifo)('does not wait for a writer, and calls it unreadable', () => {
    const fifo = join(dir, 'role.md');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    swapped.add(fifo);
    // Should the open block, a writer comes after a while and lets it go, so the test fails on its time rather than hanging.
    const writer = spawn('sh', ['-c', 'sleep 2; exec 3<>"$0"; sleep 1', fifo], { stdio: 'ignore' });
    try {
      const start = Date.now();
      expect(roleMdFirstLine(fifo)).toBe(ROLE_MD_UNREADABLE);
      expect(Date.now() - start).toBeLessThan(1000);
    } finally {
      writer.kill('SIGKILL');
    }
  });
});
