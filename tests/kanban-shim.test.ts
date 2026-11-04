import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mtCommand, shimScript, writeMtShim } from '../src/kanban/shim.js';

/**
 * The `mt` on a run's PATH: a script under a made-up home. Running it by name is
 * the end-to-end test's (tests/kanban-worker.e2e.ts): unit tests start no process.
 */

let home: string;

beforeEach(() => {
  home = join(realpathSync(mkdtempSync(join(tmpdir(), 'mt-shim-'))), 'home');
  mkdirSync(home);
});
afterEach(() => rmSync(join(home, '..'), { recursive: true, force: true }));

const SRC = fileURLToPath(new URL('../src', import.meta.url));

describe('the mt shim', () => {
  it("runs this build's mt with the gateway's node: in a checkout, the source through tsx's loader", () => {
    const command = mtCommand();
    expect(command[0]).toBe(process.execPath);
    expect(command[1]).toBe('--import');
    expect(command[2]).toMatch(/^file:\/\/.*\/tsx\/dist\/loader\.mjs$/);
    expect(command[3]).toBe(join(SRC, 'mt.ts'));
  });

  it('is written as $MT_HOME/bin/mt, 0700 in a 0700 directory, and replaced at each start', () => {
    const dir = writeMtShim(home, ['/usr/bin/node', '/opt/mt/dist/mt.js']);
    expect(dir).toBe(join(home, 'bin'));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'mt')).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, 'mt'), 'utf8')).toContain("exec '/usr/bin/node' '/opt/mt/dist/mt.js' \"$@\"\n");
    writeMtShim(home, ['/usr/bin/node', '/opt/mt2/dist/mt.js']);
    expect(readFileSync(join(dir, 'mt'), 'utf8')).toContain("'/opt/mt2/dist/mt.js'");
    // Only mt: no staging file is left beside it.
    expect(readdirSync(dir)).toEqual(['mt']);
  });

  it('quotes every word, so a path with a space or a quote stays one argument', () => {
    expect(shimScript(['/a b/node', "/it's/mt.js"])).toContain(`exec '/a b/node' '/it'\\''s/mt.js' "$@"`);
  });
});
