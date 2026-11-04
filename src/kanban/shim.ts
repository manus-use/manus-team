import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { privateDir } from './socket.js';

/**
 * The `mt` a run finds on its PATH (spec §7.2): a two-line script the gateway
 * writes at `$MT_HOME/bin/mt` at each start, whose directory is prepended to every
 * run's PATH. It runs **this build's** `mt` with **the gateway's own node**:
 *
 * - in an install, `node dist/mt.js`, the file package.json's `bin` names;
 * - in a checkout run through tsx, `node --import <tsx's loader> src/mt.ts`, with
 *   the loader found from this module, so it works from any directory.
 *
 * Why a script the gateway writes, rather than an existing directory on PATH:
 * - the build directory holds `mt.js`, not an `mt` an agent can run by name, and
 *   a checkout has no built `mt` at all;
 * - an npm prefix's `bin`, where an install links `mt`, holds every other global
 *   command too, and putting it first would change what all of them resolve to;
 * - the shim's directory holds `mt` and nothing else, so prepending it changes
 *   one name, and the agent always gets the gateway's `mt`, never the tape-drive
 *   one some systems have (spec §13);
 * - and it pins the node and the build to the gateway's, so a run never reports
 *   through a different version of the CLI than the gateway serving it.
 *
 * It is in the gateway's home, which no workspace may be or contain (spec §2.3),
 * so nothing is ever written into a workspace.
 */

/** The command this build's `mt` runs as: the gateway's node, and the entry beside this module's build. */
export function mtCommand(): readonly string[] {
  const here = fileURLToPath(import.meta.url);
  const root = dirname(dirname(here));
  if (here.endsWith('.ts')) {
    // A checkout, run through tsx: its loader, found from here, not from the agent's directory.
    const loader = createRequire(import.meta.url).resolve('tsx');
    return [process.execPath, '--import', pathToFileURL(loader).href, join(root, 'mt.ts')];
  }
  return [process.execPath, join(root, 'mt.js')];
}

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The script: every word quoted, so a path with a space or a quote stays one argument. */
export function shimScript(command: readonly string[]): string {
  return [
    '#!/bin/sh',
    "# Written by the gateway at each start: this build's mt, run by the gateway's node.",
    `exec ${command.map(shellQuote).join(' ')} "$@"`,
    '',
  ].join('\n');
}

/**
 * Write `$MT_HOME/bin/mt`, `0700` in a `0700` directory, and return the
 * directory a run's PATH starts with. Written whole beside it and renamed into
 * place, so an agent running `mt` meanwhile never runs half a script.
 */
export function writeMtShim(home: string, command: readonly string[] = mtCommand()): string {
  const dir = join(home, 'bin');
  privateDir(dir, 'the mt shim');
  const target = join(dir, 'mt');
  // Said plainly: a rename onto it would fail with a bare EISDIR.
  if (lstatSync(target, { throwIfNoEntry: false })?.isDirectory() === true) {
    throw new Error(`${target} is a directory; remove it`);
  }
  const staging = join(dir, `.mt-${randomUUID()}`);
  try {
    writeFileSync(staging, shimScript(command), { mode: 0o700, flag: 'wx' });
    // The mode a file is created with passes through the umask, which may take the execute bit.
    chmodSync(staging, 0o700);
    renameSync(staging, target);
  } catch (err) {
    rmSync(staging, { force: true });
    throw err;
  }
  return dir;
}
