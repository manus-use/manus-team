import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The update lock made durable (spec §20.10): after the link that takes it and
 * the rename that rewrites it, its directory is synced, so a power cut never
 * leaves a lock that vanished, or a step older than what was done.
 */

const opened = new Map<number, string>();
const synced: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      opened.set(fd, String(args[0]));
      return fd;
    },
    fsyncSync: (fd: number) => {
      synced.push(opened.get(fd) ?? `fd ${fd}`);
      fs.fsyncSync(fd);
    },
  };
});

const { UpdateLock } = await import('../src/cli/update-lock.js');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-update-lock-sync-'));
  synced.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('UpdateLock', () => {
  it('syncs its directory after the link that takes it, and after each rename that rewrites it', () => {
    const lock = UpdateLock.take(join(dir, 'update.pid'), { pid: 4321, home: '/h', checkout: '/c', step: 'check' });
    if (!(lock instanceof UpdateLock)) throw new Error('not taken');
    expect(synced.filter((p) => p === dir)).toHaveLength(1);
    lock.write({ pid: 4321, home: '/h', checkout: '/c', step: 'build' });
    expect(synced.filter((p) => p === dir)).toHaveLength(2);
    lock.release();
  });
});
