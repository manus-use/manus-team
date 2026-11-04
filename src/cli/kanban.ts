import { createConnection } from 'node:net';
import type { Readable } from 'node:stream';
import { DEFAULT_MAX_REQUEST_BYTES } from '../kanban/socket.js';
import { WORKER_COMMANDS } from '../kanban/worker.js';
import type { MtIo } from './mt.js';

/**
 * `mt kanban <command> < input.json` (spec §7.3): the worker CLI an agent reports
 * through. It takes its authority from the run's environment (spec §7.2) --
 * `MT_KANBAN_RUN`, `MT_KANBAN_TOKEN` and `MT_KANBAN_SOCKET` -- and from nothing
 * else: no flag names a run or a token, so neither appears in a command line a
 * process listing or a transcript would show.
 *
 * **JSON in on stdin, JSON out, always.** A summary is free text, and passing it
 * through shell arguments invites quoting failures that mangle a report. Every
 * answer is one line, `{"ok": true, ...}` or `{"ok": false, "code": "...",
 * "message": "..."}`, so an agent acts on the code rather than parse prose; a
 * refusal made here, before the gateway is asked, has the same shape.
 *
 * Exit codes: 0 done, 1 refused, 2 the command line was wrong.
 */

/**
 * How long to wait for the gateway's answer. A report runs the task's gates first,
 * which may take up to 10 minutes together (GATE_LIMITS.totalTimeoutS), and reads
 * the commit; this leaves room for both.
 */
export const ANSWER_TIMEOUT_MS = 15 * 60_000;

const USAGE = `usage: mt kanban <${WORKER_COMMANDS.join('|')}>, with its input as JSON on stdin`;

/** All of a stream, or undefined once it passes `maxBytes`. */
export async function readAll(stream: Readable, maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > maxBytes) return undefined;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One request line to the socket, and the gateway's one answer line. */
function ask(socket: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socket);
    let got = '';
    conn.setEncoding('utf8');
    conn.setTimeout(ANSWER_TIMEOUT_MS, () => conn.destroy(new Error('no answer in time')));
    conn.on('data', (d: string) => (got += d));
    conn.once('error', reject);
    conn.once('close', () => resolve(got));
    conn.write(line);
  });
}

/** The socket refused, or dropped the connection: what a gateway that is too busy does. */
const BUSY = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE'];

/** Why the socket could not be asked, and what to do about it. */
function why(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'ENOENT; is the gateway running?';
  if (code !== undefined && BUSY.includes(code)) return `${code}; if it is running, it may be busy: try again`;
  return code ?? (err instanceof Error ? err.message : String(err));
}

export async function kanbanCommand(command: string | undefined, rest: readonly string[], io: MtIo): Promise<number> {
  const say = (answer: Record<string, unknown>): void => io.out(JSON.stringify(answer));
  if (command === undefined || !(WORKER_COMMANDS as readonly string[]).includes(command)) {
    say({ ok: false, code: 'unknown_command', message: USAGE });
    return 2;
  }
  if (rest.length > 0) {
    say({ ok: false, code: 'bad_request', message: `mt kanban ${command} takes no arguments: its input is JSON on stdin` });
    return 2;
  }
  const run = io.env['MT_KANBAN_RUN'];
  const token = io.env['MT_KANBAN_TOKEN'];
  const socket = io.env['MT_KANBAN_SOCKET'];
  if (!run || !token || !socket) {
    say({
      ok: false,
      code: 'not_in_a_run',
      message: 'mt kanban works only inside a board run: MT_KANBAN_RUN, MT_KANBAN_TOKEN and MT_KANBAN_SOCKET must all be set',
    });
    return 1;
  }

  // show takes nothing, and reads nothing: a terminal on stdin would wait forever.
  // Every other command reads stdin, so a terminal there is refused at once.
  let input: unknown = {};
  if (command !== 'show') {
    if (io.stdinIsTTY === true) {
      say({
        ok: false,
        code: 'invalid',
        message: `mt kanban ${command} reads JSON on stdin; stdin is a terminal: redirect a file or pipe it`,
      });
      return 1;
    }
    const text = await (io.stdin?.(DEFAULT_MAX_REQUEST_BYTES) ?? Promise.resolve(''));
    if (text === undefined) {
      say({ ok: false, code: 'too_large', message: `the input is over ${DEFAULT_MAX_REQUEST_BYTES} bytes` });
      return 1;
    }
    try {
      input = JSON.parse(text);
    } catch {
      // Not quoted: the input is the agent's text, and may hold anything.
      say({ ok: false, code: 'invalid', message: `mt kanban ${command} reads one JSON object on stdin, and this is not JSON` });
      return 1;
    }
  }

  let line: string;
  try {
    line = await ask(socket, `${JSON.stringify({ run, token, command, input })}\n`);
  } catch (err) {
    say({ ok: false, code: 'unreachable', message: `cannot reach the gateway at ${socket}: ${why(err)}` });
    return 1;
  }
  let answer: unknown;
  try {
    answer = JSON.parse(line);
  } catch {
    answer = undefined;
  }
  if (typeof answer !== 'object' || answer === null || typeof (answer as { ok?: unknown }).ok !== 'boolean') {
    say({ ok: false, code: 'unreachable', message: `the gateway at ${socket} gave no answer; it may be busy: try again` });
    return 1;
  }
  io.out(JSON.stringify(answer));
  return (answer as { ok: boolean }).ok ? 0 : 1;
}
