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
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SOCKET_PATH_MAX,
  claimSocketPath,
  listenWorker,
  lockGateway,
  workerSocketPath,
  type WorkerServer,
} from '../src/kanban/socket.js';
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

/** A socket file nothing listens on, as a gateway that died leaves: moved away from its server, which then closes. */
async function deadSocketAt(path: string): Promise<void> {
  const dead = createServer();
  await new Promise<void>((resolve) => dead.listen(join(root, 'dead.sock'), resolve));
  renameSync(join(root, 'dead.sock'), path);
  await new Promise<void>((resolve) => dead.close(() => resolve()));
}

/** A pid no process has: counted down from the largest Linux allows, which no Mac reaches. */
function deadPid(): number {
  for (let pid = 4_194_303; pid > 1; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('no free pid');
}

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

  it('closes a connection that keeps its side open and never reads, so others are served', async () => {
    // One connection at a time: a client left holding one locks every other out.
    const big = 'y'.repeat(4 * 1024 * 1024);
    const server = await listen(sockPath(), (req) => ({ ok: true, big: (req as { big?: boolean }).big === true ? big : '' }), {
      requestTimeoutMs: 100,
      maxConnections: 1,
    });
    // A small answer, which fits the socket's buffer, and one too big to, which only the linger ends.
    const holders: Socket[] = [];
    for (const request of ['{}\n', '{"big":true}\n']) {
      const holder = createConnection(server.path);
      holders.push(holder);
      holder.on('error', () => undefined);
      // Never read, and its write side never ended.
      holder.pause();
      holder.write(request);
      // Well past the 100 ms linger; the holder is still open on its own side.
      await new Promise((resolve) => setTimeout(resolve, 400));
      // Served only once the server has let the holder go: one connection at a time.
      expect(JSON.parse(await send(server.path, '{}\n'))).toEqual({ ok: true, big: '' });
    }
    for (const holder of holders) holder.destroy();
    expect(JSON.parse(await send(server.path, '{}\n'))).toEqual({ ok: true, big: '' });
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

describe('worker socket: closing', () => {
  /** A connection that has sent nothing: whether the server has dropped it. */
  function idle(path: string): Promise<'closed'> {
    return new Promise((resolve) => {
      const socket = createConnection(path);
      socket.on('error', () => undefined);
      socket.on('close', () => resolve('closed'));
    });
  }

  it('answers a request still being handled before it goes: the handler is told the gateway is stopping', async () => {
    let started: () => void = () => undefined;
    const handling = new Promise<void>((resolve) => (started = resolve));
    const server = await listenWorker(sockPath(), async (_req, signal) => {
      started();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      return { ok: false, code: 'gates_cannot_run', message: 'stopping' };
    });
    const reply = send(server.path, '{"command":"complete"}\n');
    await handling;
    const waiting = idle(server.path);
    await server.close();
    expect(JSON.parse(await reply)).toEqual({ ok: false, code: 'gates_cannot_run', message: 'stopping' });
    expect(await waiting).toBe('closed');
    expect(existsSync(server.path)).toBe(false);
  });

  it('drops a request whose handler does not answer within the drain, and says so', async () => {
    const notes: string[] = [];
    let started: () => void = () => undefined;
    const handling = new Promise<void>((resolve) => (started = resolve));
    const server = await listenWorker(
      sockPath(),
      async () => {
        started();
        await new Promise<void>(() => undefined);
      },
      { drainMs: 50, note: (line) => notes.push(line) },
    );
    const reply = send(server.path, '{}\n');
    await handling;
    await server.close();
    expect(await reply).toBe('');
    expect(notes).toEqual(['kanban: the worker socket closed with 1 request(s) unanswered']);
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

  it('probes a refused socket again before it calls it stale: a busy gateway may refuse once', async () => {
    mkdirSync(join(root, 'run'), { mode: 0o700 });
    await deadSocketAt(sockPath());
    // Refused at first, as a full backlog refuses; listening again by the next probe.
    let live: ReturnType<typeof createServer> | undefined;
    const swap = setTimeout(() => {
      unlinkSync(sockPath());
      live = createServer((c) => c.destroy());
      live.listen(sockPath());
    }, 100);
    try {
      await expect(claimSocketPath(sockPath(), { probes: 3, probeIntervalMs: 300 })).rejects.toThrow('another gateway is listening on it');
      expect(lstatSync(sockPath()).isSocket()).toBe(true);
    } finally {
      clearTimeout(swap);
      await new Promise<void>((resolve) => (live === undefined ? resolve() : live.close(() => resolve())));
    }

    // Refused every time: stale, and removed, only after the last probe.
    await deadSocketAt(sockPath());
    const started = Date.now();
    await claimSocketPath(sockPath(), { probes: 3, probeIntervalMs: 100 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(existsSync(sockPath())).toBe(false);
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

describe('the gateway lock', () => {
  const lockPath = () => join(root, 'run', 'gateway.pid');

  it('is $MT_HOME/run/gateway.pid, 0600 in the private directory, holding our pid; removed on release', () => {
    const lock = lockGateway(root);
    expect(lock.path).toBe(lockPath());
    expect(readFileSync(lockPath(), 'utf8')).toBe(`${process.pid}\n`);
    expect(statSync(lockPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'run')).mode & 0o777).toBe(0o700);
    // Nothing but the lock is left beside it.
    expect(readdirSync(join(root, 'run'))).toEqual(['gateway.pid']);
    lock.release();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('refuses a home whose lock names another live process, and leaves the lock alone', () => {
    mkdirSync(join(root, 'run'), { mode: 0o700 });
    // Our parent: alive, and not us.
    writeFileSync(lockPath(), `${process.ppid}\n`);
    expect(() => lockGateway(root)).toThrow(`another gateway (pid ${process.ppid}) is running on ${root}`);
    expect(readFileSync(lockPath(), 'utf8')).toBe(`${process.ppid}\n`);
  });

  it('takes a lock whose process is gone, or that holds no pid, or that is already ours', () => {
    mkdirSync(join(root, 'run'), { mode: 0o700 });
    for (const stale of [`${deadPid()}\n`, '', 'not a pid\n', '0\n', '-1\n', `${process.pid}\n`]) {
      writeFileSync(lockPath(), stale);
      const lock = lockGateway(root);
      expect(readFileSync(lockPath(), 'utf8')).toBe(`${process.pid}\n`);
      lock.release();
    }
  });

  it('leaves the lock to the holder that took it when a second holder in this process releases', () => {
    const first = lockGateway(root);
    const second = lockGateway(root);
    second.release();
    expect(readFileSync(lockPath(), 'utf8')).toBe(`${process.pid}\n`);
    first.release();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('refuses a lock that is not a file of its own, and on release leaves one that is not ours', () => {
    mkdirSync(join(root, 'run'), { mode: 0o700 });
    writeFileSync(join(root, 'elsewhere'), `${deadPid()}\n`);
    symlinkSync(join(root, 'elsewhere'), lockPath());
    expect(() => lockGateway(root)).toThrow('is not a file of its own');
    expect(lstatSync(lockPath()).isSymbolicLink()).toBe(true);
    unlinkSync(lockPath());

    const lock = lockGateway(root);
    // Taken over since, by a gateway that judged ours stale: release leaves its lock.
    unlinkSync(lockPath());
    writeFileSync(lockPath(), `${process.ppid}\n`);
    lock.release();
    expect(readFileSync(lockPath(), 'utf8')).toBe(`${process.ppid}\n`);
  });
});

