import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crashReport, installCrashHandlers, stderrWriter } from '../src/crash.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';

/** The crash handlers (spec §10.1), on a stand-in for the process: nothing exits here. */

beforeEach(() => clearSecrets());
afterEach(() => clearSecrets());

function installed() {
  const source = new EventEmitter();
  const written: string[] = [];
  const exits: number[] = [];
  installCrashHandlers(source, (text) => written.push(text), (code) => exits.push(code));
  return { source, written, exits };
}

describe('crash handlers', () => {
  it('print an uncaught exception, its stack included, masked, and exit 1', () => {
    addSecrets(['sk-live-1234567890']);
    const { source, written, exits } = installed();
    source.emit('uncaughtException', new Error('request failed with key sk-live-1234567890'));
    expect(exits).toEqual([1]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(new RegExp(`^uncaught exception: Error: request failed with key ${MASK}\\n    at `));
    expect(written[0]).not.toContain('sk-live');
    expect(written[0]?.endsWith('\n')).toBe(true);
  });

  it('print an unhandled rejection of anything, masked, and exit 1', () => {
    addSecrets(['sk-live-1234567890']);
    const { source, written, exits } = installed();
    source.emit('unhandledRejection', { status: 401, key: 'sk-live-1234567890' });
    source.emit('unhandledRejection', 'just sk-live-1234567890');
    expect(exits).toEqual([1, 1]);
    expect(written).toEqual([
      `unhandled rejection: { status: 401, key: '${MASK}' }\n`,
      `unhandled rejection: 'just ${MASK}'\n`,
    ]);
  });

  it('exit even when the report cannot be written', () => {
    const source = new EventEmitter();
    const exits: number[] = [];
    installCrashHandlers(
      source,
      () => {
        throw new Error('stderr is gone');
      },
      (code) => exits.push(code),
    );
    source.emit('uncaughtException', new Error('boom'));
    expect(exits).toEqual([1]);
  });

  it('still say what happened when the error cannot be shown, and exit 1', () => {
    const { source, written, exits } = installed();
    const unshowable = {
      [inspect.custom]() {
        throw new Error('cannot inspect this');
      },
    };
    source.emit('uncaughtException', unshowable);
    expect(exits).toEqual([1]);
    expect(written).toEqual(['uncaught exception: (the error could not be shown)\n']);
  });

  it('write the report to stderr synchronously, all of it, before the exit', () => {
    const fds: number[] = [];
    let got = '';
    // A write that takes 5 bytes at a time, as a full pipe might.
    const write = stderrWriter(
      (fd, buf) => {
        fds.push(fd);
        got += buf.subarray(0, 5).toString('utf8');
        return Math.min(5, buf.length);
      },
      () => {
        throw new Error('the fallback is not needed');
      },
    );
    write('uncaught exception: boom\n');
    expect(got).toBe('uncaught exception: boom\n');
    expect(new Set(fds)).toEqual(new Set([2]));
  });

  it('fall back to process.stderr for what a synchronous write could not take', () => {
    const fallback: string[] = [];
    let calls = 0;
    const write = stderrWriter(
      (_fd, buf) => {
        calls += 1;
        if (calls > 1) throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
        return Math.min(10, buf.length);
      },
      (text) => fallback.push(text),
    );
    write('uncaught exception: boom\n');
    // The first 10 bytes went; the rest goes the other way.
    expect(fallback).toEqual(['xception: boom\n']);
  });

  it('show an error as Node would, its own fields too', () => {
    const err = Object.assign(new Error('spawn bytesec ENOENT'), { code: 'ENOENT' });
    expect(crashReport('uncaught exception', err)).toContain("code: 'ENOENT'");
  });
});
