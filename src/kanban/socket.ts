import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { redactKnownSecrets } from '../secrets.js';

/**
 * The gateway's local socket (spec §7.2, §10): how `mt kanban` reaches the worker
 * API. A Unix socket, `0600`, in a directory only the gateway's user can enter,
 * so only that user can connect at all: that, not the token, is the boundary
 * between users. Every agent runs as that user, so the token is what scopes one
 * run from another.
 *
 * **One request per connection**: one line of JSON in, one line of JSON out, then
 * the connection is closed. Many connections are served at once. A request is
 * capped in size and must arrive within a timeout, and an answered connection is
 * closed within that timeout too, read or not; what is answered is masked
 * value by value (spec §10.1), so neither a live token nor a known secret leaves
 * in a response, whatever the handler put in it.
 */

/**
 * The longest socket path, in bytes, that binds everywhere the gateway runs:
 * macOS keeps 104 bytes for it, the terminating NUL included (Linux 108).
 */
export const SOCKET_PATH_MAX = 103;

export interface WorkerServerOptions {
  /** The most a request line may be, in bytes. */
  maxRequestBytes?: number;
  /** How long a connection may take to send its request, and may stay open once answered. */
  requestTimeoutMs?: number;
  /** Connections served at once; more wait in the kernel's backlog. */
  maxConnections?: number;
  /** Metadata only. */
  note?: (line: string) => void;
}

export interface WorkerServer {
  readonly path: string;
  /** Stop listening, drop every open connection, and remove the socket. */
  close(): Promise<void>;
}

export const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONNECTIONS = 64;

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function uid(): number | undefined {
  return process.getuid?.();
}

/**
 * Where the socket goes: `$MT_HOME/run/kanban.sock`, unless that is too long to
 * bind. Then a directory of the gateway's own in the temporary directory, named
 * by the user and the home, so two gateways' homes never share one.
 */
export function workerSocketPath(home: string, opts: { tmp?: string; uid?: number } = {}): string {
  const primary = join(home, 'run', 'kanban.sock');
  if (bytes(primary) <= SOCKET_PATH_MAX) return primary;
  const tag = createHash('sha256').update(home, 'utf8').digest('hex').slice(0, 12);
  const fallback = join(opts.tmp ?? tmpdir(), `mt-${opts.uid ?? uid() ?? 0}-${tag}`, 'kanban.sock');
  if (bytes(fallback) > SOCKET_PATH_MAX) {
    throw new Error(
      `the worker socket cannot be placed: ${primary} and ${fallback} are both over ${SOCKET_PATH_MAX} bytes; ` +
        'set MT_HOME, or TMPDIR, to a shorter path',
    );
  }
  return fallback;
}

/**
 * A directory of the gateway's own: made `0700` if it is missing; if it exists, it
 * must be a real directory of the gateway's user, and is made `0700` if it is
 * anything else. A symlink, or another user's directory, is refused rather than followed or
 * used. `purpose` says what was to go there, for the refusal.
 */
export function privateDir(dir: string, purpose: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`${dir} is not a directory of its own (a symlink or a file); refusing to put ${purpose} there`);
  }
  const me = uid();
  if (me !== undefined && st.uid !== me) {
    throw new Error(`${dir} belongs to another user; refusing to put ${purpose} there`);
  }
  // Exactly 0700: looser lets others in, and a umask may have taken the owner's bits.
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

export interface GatewayLock {
  readonly path: string;
  /** Remove the lock, if it is still this process's. */
  release(): void;
}

/** The pid a lock file names, or undefined for one that names none. Refuses what is not a file of its own. */
function lockHolder(path: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') throw new Error(`${path} is not a file of its own (a symlink); refusing to use it as the gateway lock`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a file of its own; refusing to use it as the gateway lock`);
    const me = uid();
    if (me !== undefined && st.uid !== me) throw new Error(`${path} belongs to another user; refusing to use it as the gateway lock`);
    const buf = Buffer.alloc(32);
    const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8').trim();
    const pid = /^[0-9]{1,10}$/.test(text) ? Number(text) : 0;
    // 0 and below would signal a process group, not a process.
    return pid > 0 ? pid : undefined;
  } finally {
    closeSync(fd);
  }
}

/** Whether a process has this pid. One of another user's (EPERM) is alive too. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take the home for this gateway: `$MT_HOME/run/gateway.pid`, `0600` in the
 * private directory, holding this process's pid. It is what keeps a second
 * gateway off a home, since a socket probe alone cannot tell a busy gateway,
 * whose full backlog refuses connections, from a dead one. A lock naming another
 * live process is refused; one whose process is gone, or that names none, is
 * stale and taken over; one naming this process is already ours, and only the
 * holder that created it removes it on release.
 *
 * The lock is in the home even when the socket is under the temporary directory:
 * it has no length limit. It is written whole beside its place and linked in, so
 * no gateway ever reads a lock half written.
 */
export function lockGateway(home: string): GatewayLock {
  const dir = join(home, 'run');
  privateDir(dir, 'the gateway lock');
  const path = join(dir, 'gateway.pid');
  // Only the call that created the file removes it: a second holder in this
  // process, which found the lock naming us already, must not take it from the first.
  const held = (created: boolean): GatewayLock => ({
    path,
    release() {
      if (!created) return;
      try {
        if (lockHolder(path) === process.pid) unlinkSync(path);
      } catch {
        // Not ours to remove, or gone already; either way, nothing of ours is left.
      }
    },
  });
  // Twice at most: a stale lock removed, then ours linked in. A third means another gateway is starting too.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const staging = join(dir, `.gateway.pid-${randomUUID()}`);
    try {
      writeFileSync(staging, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
      linkSync(staging, path);
      return held(true);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    } finally {
      rmSync(staging, { force: true });
    }
    const holder = lockHolder(path);
    if (holder === process.pid) return held(false);
    if (holder !== undefined && alive(holder)) {
      throw new Error(`another gateway (pid ${holder}) is running on ${home}: stop it first, or give this one another MT_HOME (${path})`);
    }
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  throw new Error(`${path}: the gateway lock keeps being taken; another gateway may be starting on ${home}`);
}

/**
 * Take the socket's path for this gateway, before it changes anything: the
 * directory made private, a stale socket removed, and a live one refused. A
 * second gateway on the same home fails here, before its boot would end the
 * first gateway's runs. listenWorker does it again, which is then a no-op.
 */
export async function claimSocketPath(path: string, opts: ProbeOptions = {}): Promise<void> {
  privateDir(dirname(path), 'the socket');
  await clearStale(path, opts);
}

export interface ProbeOptions {
  /** Connections tried before a socket that refuses each is called stale. */
  probes?: number;
  /** The wait between two of them. */
  probeIntervalMs?: number;
}

const DEFAULT_PROBES = 5;
const DEFAULT_PROBE_INTERVAL_MS = 100;

/** One connection: true if it is accepted, or fails any way but a refusal. */
function probe(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const conn = createConnection(path);
    conn.once('connect', () => {
      conn.destroy();
      resolve(true);
    });
    // Only a refusal says nothing listens: any other failure cannot be told from a live gateway.
    conn.once('error', (err: NodeJS.ErrnoException) => resolve(err.code !== 'ECONNREFUSED'));
  });
}

/**
 * A socket left by a gateway that died is removed. Anything else at the path is
 * refused: a file that is not a socket, another user's socket, and a socket a
 * live gateway is still listening on.
 */
async function clearStale(path: string, opts: ProbeOptions): Promise<void> {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!st.isSocket()) throw new Error(`${path} exists and is not a socket; refusing to remove it`);
  const me = uid();
  if (me !== undefined && st.uid !== me) throw new Error(`${path} belongs to another user; refusing to remove it`);
  // A live gateway whose backlog is full refuses too (macOS says ECONNREFUSED):
  // stale only if it refuses every probe, a little apart. The gateway lock is
  // what keeps a second gateway off a home; this is the socket's own check.
  const probes = Math.max(1, opts.probes ?? DEFAULT_PROBES);
  const interval = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  for (let i = 0; i < probes; i += 1) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, interval));
    if (await probe(path)) {
      throw new Error(`${path}: another gateway is listening on it, or it cannot be told apart from one`);
    }
  }
  unlinkSync(path);
}

/** Every string in a response, keys too, masked: JSON escaping would hide a secret holding `"` or `\`. */
function maskAll(value: unknown): unknown {
  if (typeof value === 'string') return redactKnownSecrets(value);
  if (Array.isArray(value)) return value.map(maskAll);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactKnownSecrets(k), maskAll(v)]));
  }
  return value;
}

/**
 * Send the one answer and let the connection go. Half-open, the server's end
 * alone would leave it open for as long as the client keeps its side, so it is
 * destroyed once the answer is written, or after `lingerMs` if the client never
 * reads it: a client that does neither cannot hold a connection for ever.
 */
function answer(socket: Socket, response: unknown, lingerMs: number): void {
  if (socket.destroyed || socket.writableEnded) return;
  let line: string;
  try {
    line = `${JSON.stringify(maskAll(response))}\n`;
  } catch {
    // An answer that cannot be serialized ends the connection, not the process.
    socket.destroy();
    return;
  }
  socket.end(line, () => socket.destroy());
  const linger = setTimeout(() => socket.destroy(), lingerMs);
  socket.once('close', () => clearTimeout(linger));
}

/** Listen at `path` and answer each request with what `handle` returns. */
export async function listenWorker(
  path: string,
  handle: (request: unknown) => unknown,
  opts: WorkerServerOptions = {},
): Promise<WorkerServer> {
  const maxBytes = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const note = opts.note ?? (() => undefined);
  await claimSocketPath(path);

  const sockets = new Set<Socket>();
  // Half-open, so a client that ends its side after the request still gets the answer.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // A client that goes away is its own business; an error must not reach the process.
    socket.on('error', () => undefined);
    // Within timeoutMs of connecting, however slowly it trickles in: an idle
    // timeout would let a byte every few seconds hold the connection for ever.
    const deadline = setTimeout(() => socket.destroy(), timeoutMs);
    socket.once('close', () => clearTimeout(deadline));
    const chunks: Buffer[] = [];
    let size = 0;
    let read = false;
    const reply = (response: unknown): void => answer(socket, response, timeoutMs);
    const done = (response: unknown): void => {
      read = true;
      reply(response);
    };
    socket.on('data', (chunk: Buffer) => {
      if (read) return;
      const nl = chunk.indexOf(0x0a);
      const part = nl === -1 ? chunk : chunk.subarray(0, nl);
      size += part.length;
      if (size > maxBytes) {
        done({ ok: false, code: 'too_large', message: `a request is at most ${maxBytes} bytes` });
        return;
      }
      chunks.push(part);
      if (nl === -1) return;
      read = true;
      // Read; what is left is the handler's, however long it takes. Once it has
      // answered, the linger bounds the connection again.
      clearTimeout(deadline);
      let request: unknown;
      try {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reply({ ok: false, code: 'bad_request', message: 'a request is one line of JSON' });
        return;
      }
      Promise.resolve()
        .then(() => handle(request))
        .then(
          (response) => reply(response),
          () => reply({ ok: false, code: 'internal', message: 'the gateway failed to handle the request' }),
        );
    });
    socket.on('end', () => {
      if (!read) done({ ok: false, code: 'bad_request', message: 'the request ended before its newline' });
    });
  });
  server.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // The directory already keeps everyone else out; the socket says so itself too.
  chmodSync(path, 0o600);
  server.on('error', (err) => note(`kanban: the worker socket failed: ${err.message}`));

  let closing: Promise<void> | undefined;
  return {
    path,
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        // Node removes the socket file when it stops listening.
        server.close(() => resolve());
      });
      return closing;
    },
  };
}
