import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
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
 * capped in size and must arrive within a timeout; what is answered is masked
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
  /** How long a connection may take to send its request. */
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
 * The socket's directory: made `0700` if it is missing; if it exists, it must be
 * a real directory of the gateway's user, and is made `0700` if it was not. A
 * symlink, or another user's directory, is refused rather than followed or used.
 */
export function privateDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`${dir} is not a directory of its own (a symlink or a file); refusing to put the socket there`);
  }
  const me = uid();
  if (me !== undefined && st.uid !== me) {
    throw new Error(`${dir} belongs to another user; refusing to put the socket there`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/**
 * Take the socket's path for this gateway, before it changes anything: the
 * directory made private, a stale socket removed, and a live one refused. A
 * second gateway on the same home fails here, before its boot would end the
 * first gateway's runs. listenWorker does it again, which is then a no-op.
 */
export async function claimSocketPath(path: string): Promise<void> {
  privateDir(dirname(path));
  await clearStale(path);
}

/**
 * A socket left by a gateway that died is removed. Anything else at the path is
 * refused: a file that is not a socket, another user's socket, and a socket a
 * live gateway is still listening on.
 */
async function clearStale(path: string): Promise<void> {
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
  const live = await new Promise<boolean>((resolve) => {
    const probe = createConnection(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    // Only a refusal says nothing listens: any other failure cannot be told from a live gateway.
    probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'ECONNREFUSED' ? false : true));
  });
  if (live) throw new Error(`${path}: another gateway is listening on it, or it cannot be told apart from one`);
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

function answer(socket: Socket, response: unknown): void {
  if (socket.destroyed) return;
  try {
    socket.end(`${JSON.stringify(maskAll(response))}\n`);
  } catch {
    // An answer that cannot be serialized ends the connection, not the process.
    socket.destroy();
  }
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
    const done = (response: unknown): void => {
      read = true;
      answer(socket, response);
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
      // Read; what is left is the handler's, however long it takes.
      clearTimeout(deadline);
      let request: unknown;
      try {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        answer(socket, { ok: false, code: 'bad_request', message: 'a request is one line of JSON' });
        return;
      }
      Promise.resolve()
        .then(() => handle(request))
        .then(
          (response) => answer(socket, response),
          () => answer(socket, { ok: false, code: 'internal', message: 'the gateway failed to handle the request' }),
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
