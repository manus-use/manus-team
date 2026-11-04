import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CRASH_REPORT_CHARS, crashReport, installCrashHandlers, stderrWriter } from '../src/crash.js';
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

  /** No 8-byte run of the secret shows, as written or as inspect escapes it. */
  function leaksNone(report: string, secret: string): void {
    const forms = [secret, inspect(secret).slice(1, -1), JSON.stringify(secret).slice(1, -1)];
    for (const form of forms) {
      for (let i = 0; i + 8 <= form.length; i += 1) {
        if (report.includes(form.slice(i, i + 8))) throw new Error(`a fragment at ${i} of ${form} shows`);
      }
    }
  }

  it('leave no fragment of a secret that a long string would have cut', () => {
    const secret = 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    addSecrets([secret]);
    const long = `${'x'.repeat(9990)}${secret}`;
    const err = Object.assign(new Error(`failed: ${long}`), { log: long, nested: { deeper: [long] } });
    const report = crashReport('uncaught exception', err);
    expect(report).toContain(MASK);
    leaksNone(report, secret);
    const rejected = crashReport('unhandled rejection', { log: long });
    expect(rejected).toContain(MASK);
    leaksNone(rejected, secret);
  });

  it('leave no fragment of a secret that holds a backslash and both kinds of quotes', () => {
    const secret = `sk-li've-"12\\34567890`;
    addSecrets([secret]);
    const inner = new Error(`inner ${secret}`);
    const err = Object.assign(new Error(`outer ${secret}`, { cause: inner }), { key: secret, list: [secret] });
    const report = crashReport('uncaught exception', err);
    expect(report).toContain(MASK);
    leaksNone(report, secret);
    const agg = new AggregateError([new Error(`one ${secret}`)], 'many');
    leaksNone(crashReport('uncaught exception', agg), secret);
    leaksNone(crashReport('unhandled rejection', { key: secret }), secret);
    leaksNone(crashReport('unhandled rejection', secret), secret);
  });

  it('cut a long report after masking it, leaving no start of a secret at the cut', () => {
    // A class's instance is not copied, so only the masking of inspect's text
    // covers it, and inspect writes a backslash as two: the escaped secret does not match.
    class Box {
      constructor(readonly v: string) {}
    }
    const secret = 'sk-live-ABCDEFGH\\IJKLMNOP';
    addSecrets([secret]);
    const before = inspect(new Box('x'.repeat(200))).indexOf("'") + 1;
    // The cut falls 12 characters into the secret, before its backslash.
    const report = crashReport('unhandled rejection', new Box(`${'x'.repeat(CRASH_REPORT_CHARS - before - 12)}${secret}`));
    expect(report.endsWith(' [cut]\n')).toBe(true);
    expect(report.length).toBeLessThanOrEqual('unhandled rejection: '.length + CRASH_REPORT_CHARS + ' [cut]\n'.length);
    expect(report).not.toContain('sk-live');
    // What is short enough is not cut.
    expect(crashReport('unhandled rejection', 'boom')).toBe("unhandled rejection: 'boom'\n");
  });

  it('mask through a cycle and leave a getter that throws alone', () => {
    addSecrets(['sk-live-1234567890']);
    const looped: Record<string, unknown> = { key: `it's "sk-live-1234567890"` };
    looped['self'] = looped;
    Object.defineProperty(looped, 'trap', {
      enumerable: true,
      get() {
        throw new Error('do not call me');
      },
    });
    const report = crashReport('unhandled rejection', looped);
    expect(report).toContain('[Circular *1]');
    expect(report).toContain('[Getter]');
    leaksNone(report, 'sk-live-1234567890');
    const err = new Error('a stack that throws');
    Object.defineProperty(err, 'stack', {
      get() {
        throw new Error('no stack');
      },
    });
    expect(() => crashReport('uncaught exception', err)).not.toThrow();
  });

  it('show an error as Node would, its own fields too', () => {
    const err = Object.assign(new Error('spawn bytesec ENOENT'), { code: 'ENOENT' });
    expect(crashReport('uncaught exception', err)).toContain("code: 'ENOENT'");
  });
});
