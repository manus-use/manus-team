import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SOCKET_PATH_MAX, claimSocketPath, listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';

/** The worker socket against real connections, in a fresh directory per test. */

let root: string;
const servers: WorkerServer[] = [];

beforeEach(() => {
  clearSecrets();
  // Short and realpath'd: a socket path has a length limit, and macOS's /tmp is a symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-sock-')));
});
afterEach(async () => {
  clearSecrets();
  while (servers.length > 0) await servers.pop()?.close();
  rmSync(root, { recursive: true, force: true });
});

async function listen(...args: Parameters<typeof listenWorker>): Promise<WorkerServer> {
  const server = await listenWorker(...args);
  servers.push(server);
  return server;
}

/** Send raw text, and read everything the server sends back until it closes. */
function send(path: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let got = '';
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => (got += d));
    socket.on('error', reject);
    socket.on('close', () => resolve(got));
    socket.write(text);
  });
}

const sockPath = () => join(root, 'run', 'kanban.sock');

describe('worker socket', () => {
  it('listens on a 0600 socket in a 0700 directory, and removes it on close', async () => {
    const server = await listen(sockPath(), () => ({ ok: true }));
    expect(lstatSync(server.path).isSocket()).toBe(true);
    expect(statSync(server.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'run')).mode & 0o777).toBe(0o700);
    await server.close();
    expect(existsSync(server.path)).toBe(false);
  });

  it('answers one line of JSON with one, and masks what it answers', async () => {
    addSecrets(['sk-live-1234567890']);
    const seen: unknown[] = [];
    const server = await listen(sockPath(), (req) => {
      seen.push(req);
      return { ok: true, echo: 'got sk-live-1234567890', nested: { 'sk-live-1234567890': ['sk-live-1234567890'] } };
    });
    const reply = await send(server.path, '{"command":"show"}\n');
    expect(seen).toEqual([{ command: 'show' }]);
    expect(JSON.parse(reply)).toEqual({ ok: true, echo: `got ${MASK}`, nested: { [MASK]: [MASK] } });
    expect(reply.endsWith('\n')).toBe(true);
  });

  it('serves many connections at once', async () => {
    const n = 20;
    let waiting = 0;
    let release: () => void = () => undefined;
    const all = new Promise<void>((resolve) => (release = resolve));
    // Each answer waits until every request has arrived: only concurrent handling finishes.
    const server = await listen(sockPath(), async (req) => {
      waiting += 1;
      if (waiting === n) release();
      await all;
      return { ok: true, req };
    });
    const replies = await Promise.all(Array.from({ length: n }, (_, i) => send(server.path, `{"i":${i}}\n`)));
    expect(replies.map((r) => (JSON.parse(r) as { req: { i: number } }).req.i)).toEqual(Array.from({ length: n }, (_, i) => i));
  });

  it('refuses a request over its size, one that is not JSON, and one cut off before its newline', async () => {
    const server = await listen(sockPath(), () => ({ ok: true }), { maxRequestBytes: 64 });
    expect(JSON.parse(await send(server.path, `${'x'.repeat(100)}\n`))).toEqual({
      ok: false,
      code: 'too_large',
      message: 'a request is at most 64 bytes',
    });
    expect(JSON.parse(await send(server.path, 'nope\n'))).toMatchObject({ ok: false, code: 'bad_request' });
    const cut = await new Promise<string>((resolve) => {
      const socket = createConnection(server.path);
      let got = '';
      socket.on('data', (d) => (got += String(d)));
      socket.on('close', () => resolve(got));
      socket.end('{"half":');
    });
    expect(JSON.parse(cut)).toEqual({ ok: false, code: 'bad_request', message: 'the request ended before its newline' });
  });

  it('drops a connection that sends no request in time, however slowly it trickles in', async () => {
    const server = await listen(sockPath(), () => ({ ok: true }), { requestTimeoutMs: 100 });
    const got = await new Promise<string>((resolve) => {
      const socket = createConnection(server.path);
      let text = '';
      // A byte every 20 ms: never idle for the 100 ms, and never a whole request.
      const drip = setInterval(() => socket.write('x'), 20);
      socket.on('error', () => undefined);
      socket.on('data', (d) => (text += String(d)));
      socket.on('close', () => {
        clearInterval(drip);
        resolve(text);
      });
    });
    expect(got).toBe('');
  });

  it('answers internal when the handler throws, without quoting it', async () => {
    const server = await listen(sockPath(), () => {
      throw new Error('secret detail');
    });
    expect(JSON.parse(await send(server.path, '{}\n'))).toEqual({
      ok: false,
      code: 'internal',
      message: 'the gateway failed to handle the request',
    });
  });
});

describe('worker socket: its path', () => {
  it('removes a stale socket of its own, and refuses a live one, a file, or a directory that is a symlink', async () => {
    mkdirSync(join(root, 'run'), { mode: 0o700 });
    // A gateway that died: its socket file is left, and nothing answers it. Made
    // here by moving a socket away from its server, which then closes without it.
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(join(root, 'dead.sock'), resolve));
    renameSync(join(root, 'dead.sock'), sockPath());
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    expect(lstatSync(sockPath()).isSocket()).toBe(true);
    const server = await listen(sockPath(), () => ({ ok: true }));
    expect(JSON.parse(await send(server.path, '{}\n'))).toEqual({ ok: true });

    await expect(listenWorker(sockPath(), () => ({}))).rejects.toThrow(`${sockPath()}: another gateway is listening on it`);
    // Claimed alone, as the gateway does before its boot: refused, and the live socket left alone.
    await expect(claimSocketPath(sockPath())).rejects.toThrow('another gateway is listening on it');
    expect(JSON.parse(await send(server.path, '{}\n'))).toEqual({ ok: true });
    await server.close();

    writeFileSync(sockPath(), 'not a socket');
    await expect(listenWorker(sockPath(), () => ({}))).rejects.toThrow('exists and is not a socket; refusing to remove it');
    expect(existsSync(sockPath())).toBe(true);

    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'link'));
    await expect(listenWorker(join(root, 'link', 'kanban.sock'), () => ({}))).rejects.toThrow('is not a directory of its own');
  });

  it('claims a path ahead of listening: a stale socket removed, a fresh directory made private', async () => {
    mkdirSync(join(root, 'run'), { mode: 0o755 });
    chmodSync(join(root, 'run'), 0o755);
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(join(root, 'dead.sock'), resolve));
    renameSync(join(root, 'dead.sock'), sockPath());
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    await claimSocketPath(sockPath());
    expect(existsSync(sockPath())).toBe(false);
    expect(statSync(join(root, 'run')).mode & 0o777).toBe(0o700);
  });

  it('tightens a directory of its own that others could enter', async () => {
    mkdirSync(join(root, 'run'), { mode: 0o755 });
    chmodSync(join(root, 'run'), 0o755);
    await listen(sockPath(), () => ({ ok: true }));
    expect(statSync(join(root, 'run')).mode & 0o777).toBe(0o700);
  });

  it('is under the home when that is short enough, else in a private directory of the temporary directory', () => {
    expect(workerSocketPath('/home/mt')).toBe('/home/mt/run/kanban.sock');
    const long = `/Users/${'x'.repeat(100)}/.manus-team`;
    const path = workerSocketPath(long, { tmp: '/tmp', uid: 501 });
    expect(path).toMatch(/^\/tmp\/mt-501-[0-9a-f]{12}\/kanban\.sock$/);
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(SOCKET_PATH_MAX);
    // Another home gets another directory.
    expect(workerSocketPath(`${long}2`, { tmp: '/tmp', uid: 501 })).not.toBe(path);
    expect(() => workerSocketPath(long, { tmp: `/${'t'.repeat(100)}`, uid: 501 })).toThrow('set MT_HOME, or TMPDIR, to a shorter path');
  });
});
