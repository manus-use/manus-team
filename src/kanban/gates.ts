import { spawn } from 'node:child_process';
import { buildEnv } from '../driver/env.js';
import type { Role } from '../roles.js';
import { redactKnownSecrets, withholdSecretSuffix } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import type { GateRow } from './types.js';

/**
 * Running a task's gates (spec §7.7): each command, in the order it was defined,
 * in the task's workspace, as the gateway's user, until one fails.
 *
 * **Never on the event loop.** A gate is a process, awaited: the gateway goes on
 * serving chat and other runs while a test suite runs. The runner is injected,
 * so the unit tests start no process; `spawnGate` is the real one.
 *
 * **Its environment is its role's** (`gateEnv`): the allowlist every agent gets
 * (driver/env.ts), and the role's own values -- its agent's base environment,
 * `.env` and `passEnv`. Never the gateway's own environment, which holds its Lark
 * secret, and never a run's: no `MT_KANBAN_TOKEN`, no `MT_KANBAN_SOCKET`. A test
 * suite has no business reporting on the board.
 *
 * **Its output is masked** (spec §10.1) before it is cut to its last
 * GATE_OUTPUT_BYTES, so a cut cannot leave the start of a secret showing. The
 * raw window read before that, its last RAW_OUTPUT_BYTES, is cut before masking,
 * so `rawTail` drops the end of a secret that cut split.
 */

/** What one gate process did. */
export interface GateExit {
  /** Its exit code; null when a signal ended it, or it never started. */
  exitCode: number | null;
  /** The signal that ended it, if one did. */
  signal: string | null;
  /** It ran past its timeout, and was killed. */
  timedOut: boolean;
  /** The end of what it wrote, stdout and stderr together, as written: not yet masked. */
  output: string;
}

export interface GateRunOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** Aborted when the gateway stops: the gate is killed, and the report not applied. */
  signal?: AbortSignal;
  /** How long the output may stay open once the shell has exited; OUTPUT_GRACE_MS when not given. */
  outputGraceMs?: number;
}

/** Runs one gate's command. Never rejects: a gate that cannot start is a failed gate. */
export type GateRunner = (command: string, opts: GateRunOptions) => Promise<GateExit>;

/** One gate's result, as it is recorded and shown. */
export interface GateResult {
  gateId: number;
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** Masked, then cut to its last GATE_OUTPUT_BYTES. */
  output: string;
}

/** A report's run of the task's gates. */
export interface GateRun {
  /** Every gate exited 0 in time. */
  passed: boolean;
  /** The gateway stopped while they ran. */
  aborted: boolean;
  /** Those that ran, in order: all of them, or up to the first that failed. */
  results: GateResult[];
  /** Gates not run, after the one that failed or the stop. */
  notRun: number;
}

/** What is kept of a gate's output, in UTF-8 bytes, after masking. */
export const GATE_OUTPUT_BYTES = 4 * 1024;
/** What is read of a gate's output before masking: its last bytes. */
export const RAW_OUTPUT_BYTES = 64 * 1024;
/** Begins the raw window when the output was longer than it. */
const CUT_MARKER = '[earlier output cut]\n';
/** How long a gate that was told to stop has before it is killed. */
const KILL_GRACE_MS = 2_000;
/**
 * How long a gate's output may stay open once its shell has exited and its
 * group been killed: whatever holds it then has left the group, and is not waited for.
 */
const OUTPUT_GRACE_MS = 1_000;

/** The process groups of the gates running now. */
const running = new Set<number>();
let killOnExit = false;

/**
 * Kill every running gate's group when the gateway exits, however it exits but
 * a SIGKILL: a crash's `process.exit` included. A gate left running would go on
 * changing a checkout the next boot hands to an agent.
 */
function tracked(pid: number): void {
  if (!killOnExit) {
    killOnExit = true;
    process.on('exit', () => {
      for (const group of running) {
        try {
          process.kill(-group, 'SIGKILL');
        } catch {
          // Gone already.
        }
      }
    });
  }
  running.add(pid);
}

/** The longest suffix of `text` that fits in `max` UTF-8 bytes, cut on a character. */
function tailBytes(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  return buf.subarray(buf.length - max).toString('utf8').replace(/^\uFFFD+/, '');
}

/**
 * The last RAW_OUTPUT_BYTES of what a gate wrote, as text, not yet masked. When
 * the start was cut away, the cut may have split a secret, whose end would then
 * escape the masker: leading text that ends a known secret is dropped, and the
 * window begins with CUT_MARKER.
 */
export function rawTail(all: Buffer): string {
  if (all.length <= RAW_OUTPUT_BYTES) return all.toString('utf8');
  const tail = all.subarray(all.length - RAW_OUTPUT_BYTES).toString('utf8').replace(/^\uFFFD+/, '');
  return `${CUT_MARKER}${withholdSecretSuffix(tail)}`;
}

/**
 * A gate's environment: the allowlist an agent gets from the gateway's own
 * environment, and its role's values. Nothing named `MT_KANBAN_*`, whatever put
 * it there.
 */
export function gateEnv(role: Role, parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env = buildEnv(parent, role.agent.env);
  for (const key of Object.keys(env)) if (key.startsWith('MT_KANBAN_')) delete env[key];
  return env;
}

export interface GateContext {
  cwd: string;
  env: Readonly<Record<string, string>>;
  runner: GateRunner;
  clock?: Clock;
  signal?: AbortSignal;
}

/** Whether the gateway has asked for the gates to stop. A function: a narrowed property would not see it change. */
function stopping(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Run the gates in order, stopping at the first that fails, or when the gateway stops. */
export async function runGates(gates: readonly GateRow[], ctx: GateContext): Promise<GateRun> {
  const clock = ctx.clock ?? systemClock;
  const results: GateResult[] = [];
  for (const [i, gate] of gates.entries()) {
    if (stopping(ctx.signal)) {
      return { passed: false, aborted: true, results, notRun: gates.length - i };
    }
    const started = clock.now();
    const exit = await ctx
      .runner(gate.command, {
        cwd: ctx.cwd,
        env: ctx.env,
        timeoutMs: gate.timeoutS * 1000,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      })
      // A runner should never reject; one that does fails its gate, which is recorded, masked, like any other.
      .catch(
        (err: unknown): GateExit => ({
          exitCode: null,
          signal: null,
          timedOut: false,
          output: `the gate could not run: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
    const result: GateResult = {
      gateId: gate.id,
      command: gate.command,
      exitCode: exit.exitCode,
      signal: exit.signal,
      timedOut: exit.timedOut,
      durationMs: clock.now() - started,
      output: tailBytes(redactKnownSecrets(exit.output), GATE_OUTPUT_BYTES),
    };
    results.push(result);
    const aborted = stopping(ctx.signal);
    if (aborted || exit.timedOut || exit.exitCode !== 0) {
      return { passed: false, aborted, results, notRun: gates.length - i - 1 };
    }
  }
  return { passed: true, aborted: false, results, notRun: 0 };
}

/**
 * The real runner: `/bin/sh -c <command>`, in its own process group, so that a
 * timeout or a stop kills what the gate started too. stdin is closed; stdout and
 * stderr are read together, keeping their last RAW_OUTPUT_BYTES.
 *
 * Once the shell has exited, whatever it left running in its group is killed: a
 * background process holding the gate's output open would otherwise keep the
 * report waiting until the timeout. One that left the group is not waited for:
 * the output is let go of OUTPUT_GRACE_MS (or `outputGraceMs`) after the shell exited.
 */
export const spawnGate: GateRunner = (command, opts) =>
  new Promise<GateExit>((resolve) => {
    const chunks: Buffer[] = [];
    let kept = 0;
    let timedOut = false;
    let settled = false;
    let exited: { code: number | null; signal: string | null } | undefined;
    let killer: NodeJS.Timeout | undefined;
    let letGo: NodeJS.Timeout | undefined;

    const keep = (chunk: Buffer): void => {
      chunks.push(chunk);
      kept += chunk.length;
      while (chunks.length > 1 && kept - (chunks[0]?.length ?? 0) >= RAW_OUTPUT_BYTES) kept -= chunks.shift()?.length ?? 0;
    };
    const text = (): string => rawTail(Buffer.concat(chunks));

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/bin/sh', ['-c', command], {
        cwd: opts.cwd,
        env: { ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolve({ exitCode: null, signal: null, timedOut: false, output: `the gate could not start: ${(err as Error).message}` });
      return;
    }
    const pid = child.pid;
    if (pid !== undefined) tracked(pid);
    const group = (sig: NodeJS.Signals): void => {
      try {
        if (pid !== undefined) process.kill(-pid, sig);
      } catch {
        // Gone already.
      }
    };
    const stop = (): void => {
      group('SIGTERM');
      killer ??= setTimeout(() => group('SIGKILL'), KILL_GRACE_MS);
    };
    const finish = (extra?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      clearTimeout(letGo);
      opts.signal?.removeEventListener('abort', stop);
      group('SIGKILL');
      if (pid !== undefined) running.delete(pid);
      resolve({
        exitCode: exited?.code ?? null,
        signal: exited?.signal ?? null,
        timedOut,
        output: extra === undefined ? text() : `${text()}${extra}`,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    opts.signal?.addEventListener('abort', stop, { once: true });
    // A signal aborted before the listener was added never fires it.
    if (opts.signal?.aborted === true) stop();
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.once('error', (err) => finish(`the gate could not start: ${err.message}`));
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      // It ended in time: what follows is not its own running past the timeout.
      clearTimeout(timer);
      // What the gate left behind in its group, holding its output open.
      group('SIGKILL');
      letGo = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, opts.outputGraceMs ?? OUTPUT_GRACE_MS);
    });
    child.once('close', () => finish());
  });
