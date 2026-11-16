import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAll } from '../src/cli/kanban.js';
import { runMt } from '../src/cli/mt.js';
import { listenWorker, type WorkerServer } from '../src/kanban/socket.js';
import { decodeUtf8 } from '../src/text.js';

/**
 * Text read strictly as UTF-8 (spec §21.5): every worker command's stdin, the
 * operator's body from a file or stdin, and a request to the worker socket.
 * Bytes that are not UTF-8 are refused, never read with U+FFFD in their place,
 * and a byte order mark is kept, so JSON with one is not JSON.
 */

/** Two bytes that are no UTF-8: a lone continuation byte, and one that never starts a character. */
const BROKEN = Buffer.from([0x7b, 0x22, 0x62, 0x6f, 0x64, 0x79, 0x22, 0x3a, 0x22, 0x80, 0xff, 0x22, 0x7d]);
const BOM = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"body": "x"}')]);

let root: string;
let server: WorkerServer | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-utf8-')));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** `mt` as a run's shell or the operator's runs it, with these bytes on stdin. */
async function mt(argv: string[], stdin: Uint8Array, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(argv, {
    env: { MT_HOME: join(root, 'home'), PATH: process.env['PATH'], HOME: root, ...env },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdinIsTTY: false,
    stdin: async (max) => (stdin.length > max ? undefined : stdin),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const RUN = { MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 'tok', MT_KANBAN_SOCKET: '/nonexistent/kanban.sock' };

describe('decodeUtf8', () => {
  it('reads UTF-8, refuses a broken byte, and keeps a byte order mark', () => {
    expect(decodeUtf8(Buffer.from('Évaluer 🙂'))).toBe('Évaluer 🙂');
    expect(decodeUtf8(BROKEN)).toBeUndefined();
    expect(decodeUtf8(Buffer.from([0xed, 0xa0, 0x80]))).toBeUndefined();
    expect(decodeUtf8(BOM)?.charCodeAt(0)).toBe(0xfeff);
  });
});

describe('readAll', () => {
  it('answers the bytes the stream gave, or undefined past its cap', async () => {
    const bytes = await readAll(Readable.from([Buffer.from([0x61, 0x80]), Buffer.from([0x62])]), 16);
    expect(bytes === undefined ? undefined : [...bytes]).toEqual([0x61, 0x80, 0x62]);
    expect(await readAll(Readable.from([Buffer.alloc(17)]), 16)).toBeUndefined();
  });
});

describe('a worker command', () => {
  it('refuses input that is not UTF-8, before the gateway is asked', async () => {
    for (const command of ['comment', 'complete', 'create']) {
      const r = await mt(['kanban', command], BROKEN, RUN);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out)).toEqual({
        ok: false,
        code: 'invalid',
        message: `mt kanban ${command} reads one JSON object on stdin, in UTF-8, and this is not UTF-8`,
      });
    }
  });

  it('refuses input with a byte order mark as not JSON', async () => {
    const r = await mt(['kanban', 'comment'], BOM, RUN);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({
      ok: false,
      code: 'invalid',
      message: 'mt kanban comment reads one JSON object on stdin, and this is not JSON',
    });
  });
});

describe("the operator's body", () => {
  it('refuses a body file, or a body on stdin, that is not UTF-8', async () => {
    const file = join(root, 'body.md');
    writeFileSync(file, BROKEN);
    expect(await mt(['kanban', 'task', 'new', 'A title', '--body-file', file], new Uint8Array())).toEqual({
      code: 1,
      out: '',
      err: `mt: the body in ${file} is not UTF-8`,
    });
    expect(await mt(['kanban', 'task', 'new', 'A title', '--body-file', '-'], BROKEN)).toEqual({
      code: 1,
      out: '',
      err: 'mt: the body on stdin is not UTF-8',
    });
  });
});

describe('the worker socket', () => {
  /** Send bytes, and read everything the server sends back until it closes. */
  function send(path: string, bytes: Uint8Array): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      let got = '';
      socket.setEncoding('utf8');
      socket.on('data', (d: string) => (got += d));
      socket.on('error', reject);
      socket.on('close', () => resolve(got));
      socket.write(bytes);
    });
  }

  it('refuses a request that is not UTF-8 as bad_request, and reads one that is', async () => {
    const seen: unknown[] = [];
    server = await listenWorker(join(root, 'run', 'kanban.sock'), (request) => {
      seen.push(request);
      return { ok: true };
    });
    expect(JSON.parse(await send(server.path, Buffer.concat([BROKEN, Buffer.from('\n')])))).toEqual({
      ok: false,
      code: 'bad_request',
      message: 'a request is one line of JSON, in UTF-8',
    });
    expect(JSON.parse(await send(server.path, Buffer.from('{"body": "Évaluer 🙂"}\n')))).toEqual({ ok: true });
    expect(seen).toEqual([{ body: 'Évaluer 🙂' }]);
  });
});
