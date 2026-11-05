import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { delimiter, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type {
  AgentRuntime,
  Driver,
  DriverEvent,
  PromptInput,
  StartMode,
  StartOptions,
  StartResult,
} from '../types.js';
import type { TurnTerminal } from '../../types.js';
import { buildEnv } from '../env.js';
import { isResumableProviderId } from '../../provider-id.js';

/**
 * The CLI driver: one process per *turn*, driven by argv, read back as NDJSON.
 *
 * This exists because an agent's ACP server can be broken while its command line
 * works perfectly. ACP is the primary driver and stays that way -- it is the only
 * one that can carry a permission request, and the only one that keeps a session
 * alive between turns. This is the fallback for when it is unavailable, and it is
 * a genuinely worse thing. Three properties are worth knowing before choosing it:
 *
 * 1. **No approvals.** The command line has no permission protocol: the agent
 *    never asks, it just acts. So this driver can never emit a
 *    `permission-request`, the `operate` tier stops gating tool use, and approval
 *    cards stop appearing. That is not a limitation to work around -- it is a
 *    security posture, which is why `agent.unsupervised` has to be written down
 *    in the config before this driver will load at all.
 * 2. **Resume per process.** Each turn is a fresh process, which continues the
 *    provider's own session: the driver reads the id the agent writes to
 *    `--session-id-file` and passes it back as `--session` on the next turn, which
 *    then carries only the new message. When the agent refuses the id, the turn is
 *    run again with the conversation composed into the prompt as a transcript --
 *    `resume: native -> replay`, the one degrade this layer sanctions -- which
 *    recovers what was *said* but not the tool state behind it.
 * 3. **No cooperative cancel.** Cancelling means killing the process, so work
 *    already done stands.
 *
 * The wire format below is ByteSec's `run --format json` stream, verified against
 * 0.7.2 rather than inferred, and its sessions against 0.7.4 (plan E's spike).
 * Everything specific to it -- the flag spellings, the event names, the stderr
 * of a refused session -- stops at this file, in the same way ACP stops at
 * `../acp`.
 */

export interface CliDriverConfig {
  command: string;
  /**
   * Leading arguments, from `agent.args`: the subcommand and any model choice.
   * The driver appends the flags it depends on for parsing.
   */
  args: readonly string[];
  /** Injected at spawn. Where credentials go; never a file in the workspace. */
  env?: Readonly<Record<string, string>>;
  /** Test seam. See MAX_PROMPT_BYTES. */
  maxPromptBytes?: number;
}

/**
 * How large a composed prompt may get.
 *
 * The prompt travels in argv, and argv has a hard kernel limit (1 MiB on Darwin,
 * ~2 MiB on Linux) beyond which the spawn fails with `E2BIG` -- an error that
 * reads like a broken binary rather than a long conversation. Well under it, so
 * the transcript is trimmed on our terms and with an explanation.
 */
const MAX_PROMPT_BYTES = 96 * 1024;

/** SIGTERM, then SIGKILL. Matches the ACP driver's grace period. */
const KILL_GRACE_MS = 2000;

/** Enough stderr to explain a failure, bounded so a chatty agent cannot grow it. */
const STDERR_TAIL_BYTES = 8192;

/** How long a finished turn waits for the tail of stderr. See `drain`. */
const STDERR_DRAIN_MS = 100;

/**
 * The last line of stderr when bytesec 0.7.4 will not continue a session: an id
 * its store does not hold, or one made as another agent. Both exit 1 before the
 * turn starts, with nothing on stdout (plan E's spike). Matched only as the whole
 * last line, so a turn that merely mentions it is not taken for a refusal.
 */
const RESUME_REFUSED = /^turn \d+: (persistence: session not found|unknown agent: \S+)$/;

/** The id the agent wrote, or undefined when it wrote none, or nothing usable. */
function readSessionId(path: string): string | undefined {
  try {
    const id = readFileSync(path, 'utf8').trim();
    return isResumableProviderId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The `session_id` of a typed event on stdout: which session the agent says it is in. */
function typedSessionId(line: string): string | undefined {
  try {
    const obj = JSON.parse(line) as unknown;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
    const { type, session_id: id } = obj as Record<string, unknown>;
    return typeof type === 'string' && typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The last non-empty line of stderr, without colour codes. */
function lastLine(stderr: string): string {
  return (
    stderr
      .replace(ANSI, '')
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) => line !== '') ?? ''
  );
}

/** Resolve once the stream has ended, or once the wait stops being worth it. */
async function drain(stream: Readable): Promise<void> {
  if (stream.readableEnded) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STDERR_DRAIN_MS);
    timer.unref();
    stream.once('end', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function createCliDriver(config: CliDriverConfig): Driver {
  return {
    id: 'structured-cli',
    async start(opts: StartOptions) {
      // Resolved here rather than at the first prompt. A command that does not
      // exist is a configuration mistake, and reporting it at start leaves the
      // session cold; reporting it mid-turn looks like the agent failing, and
      // failing mid-turn is what quarantines a session.
      const command = resolveExecutable(config.command, process.env['PATH']);

      const runtime = new CliRuntime({ ...config, command }, opts);
      return { runtime, result: runtime.startResult() };
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** One prompt and what the agent said back, for the transcript. */
interface Exchange {
  prompt: string;
  /** Empty when this turn predates the runtime and only the prompt is known. */
  answer: string;
}

class CliRuntime implements AgentRuntime {
  /** The fence label for the transcript, unguessable so it cannot be forged. */
  readonly #nonce: string;

  #config: CliDriverConfig & { command: string };
  #cwd: string;
  #env: Readonly<Record<string, string>>;
  /** This session's own arguments, after the configured ones (StartOptions.args). */
  #args: readonly string[];
  #history: Exchange[];
  #maxPromptBytes: number;
  /** The provider session the next turn continues, if there is one. */
  #resume: string | undefined;
  /** Cleared once the agent answers `--session` with another session: it does not resume. */
  #native = true;
  /** The last id the agent reported, or the one this runtime was started to continue. */
  #providerSessionId: string;

  /** Set synchronously by `prompt`, so a second caller is refused, not queued. */
  #inflight = false;
  #child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  #cancelled = false;
  #closed = false;
  /** Distinguishes "the user cancelled" from "we tore the runtime down". */
  #closedDuringTurn = false;

  constructor(config: CliDriverConfig & { command: string }, opts: StartOptions) {
    this.#config = config;
    this.#cwd = opts.cwd;
    this.#env = opts.env ?? {};
    this.#args = opts.args ?? [];
    this.#maxPromptBytes = config.maxPromptBytes ?? MAX_PROMPT_BYTES;
    this.#nonce = randomUUID().slice(0, 8);
    // The id the session observed before, or was seeded with (spec §2.4 item 5).
    // Empty until the first turn reports one otherwise: the agent mints it.
    this.#resume = isResumableProviderId(opts.providerSessionId) ? opts.providerSessionId : undefined;
    this.#providerSessionId = this.#resume ?? '';

    // Prior prompts come from the event log, which is the system of record. Their
    // answers do not: the log has them, but the driver is not allowed its own idea
    // of history and `StartOptions.replay` carries prompts only. So an inherited
    // turn contributes what was asked, and this runtime fills in both halves for
    // every turn it runs itself.
    this.#history = (opts.replay ?? []).map((input) => ({
      prompt: renderInput(input),
      answer: '',
    }));
  }

  get providerSessionId(): string {
    return this.#providerSessionId;
  }

  /**
   * What the first turn will do: continue a provider session (`resumed`), carry
   * the history as a transcript (`replayed`), or neither. Nothing is spawned
   * yet, so `resumed` is an intent; each turn reports what it actually did with
   * `session-observed`, a refused id included.
   */
  startResult(): StartResult {
    return {
      providerSessionId: this.#providerSessionId,
      mode: this.#resume !== undefined ? 'resumed' : this.#history.length === 0 ? 'fresh' : 'replayed',
    };
  }

  prompt(input: PromptInput): AsyncIterable<DriverEvent> {
    if (this.#closed) throw new Error('runtime is closed');
    if (this.#inflight) {
      // Serialization is the session actor's job. If two prompts reach here the
      // actor is broken, and continuing would interleave two turns' output into
      // one stream with no way to tell them apart afterwards.
      throw new Error('a turn is already in flight on this runtime');
    }
    this.#inflight = true;
    this.#cancelled = false;
    this.#closedDuringTurn = false;
    return this.#run(input);
  }

  async *#run(input: PromptInput): AsyncGenerator<DriverEvent> {
    try {
      const resume = this.#native ? this.#resume : undefined;
      // A resumed turn carries only the new message: the provider has the rest.
      const composed = resume === undefined ? this.#compose(input) : this.#alone(input);
      if (composed === undefined) {
        const size = Buffer.byteLength(renderInput(input), 'utf8');
        yield {
          kind: 'error',
          message:
            `this message is ${String(size)} bytes, and the agent is invoked with the ` +
            `prompt on its command line, which caps it at ${String(this.#maxPromptBytes)}. ` +
            'Attach it as a file instead.',
          // Nothing about retrying makes the message shorter.
          retryable: false,
        };
        // It never reached the agent, so nothing happened and nothing is unclear.
        yield { kind: 'turn-ended', terminal: 'failed' };
        return;
      }

      if (this.#cancelled) {
        // Cancelled between the synchronous `prompt` call and the first `next`.
        yield { kind: 'turn-ended', terminal: 'cancelled' };
        return;
      }

      yield* this.#runTurn(input, composed, resume, undefined);
    } finally {
      this.#inflight = false;
      this.#child = undefined;
    }
  }

  /**
   * One turn, in one process -- or two, when the agent refuses to continue the
   * session it was given: then the turn is run again with the transcript, which
   * is safe because a refused resume starts nothing (`#attempt`).
   *
   * The id file lives in a directory of its own under the system's temporary
   * directory, never the workspace, where it would show in the agent's checkout,
   * and is removed once read. A gateway that dies mid-turn leaves the directory
   * behind; it holds only the id, which is no secret.
   */
  async *#runTurn(
    input: PromptInput,
    composed: string,
    resume: string | undefined,
    refused: string | undefined,
  ): AsyncGenerator<DriverEvent> {
    let dir: string;
    try {
      dir = mkdtempSync(join(tmpdir(), 'mt-session-id-'));
    } catch (err) {
      yield {
        kind: 'error',
        message: `could not make a directory for the agent's session id: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      };
      // Nothing was started, so nothing is unclear.
      yield { kind: 'turn-ended', terminal: 'failed' };
      return;
    }
    let refusal: string | undefined;
    try {
      refusal = yield* this.#attempt(input, composed, resume, refused, join(dir, 'session-id'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (refusal === undefined) return;
    // A defence, not reachable today: `#attempt` already takes a stopped run's
    // refusal for the turn's own outcome, and nothing is awaited between its
    // check and this one. Kept so the second process can never follow a stop.
    if (this.#closed) {
      yield { kind: 'turn-ended', terminal: 'cancelled', detail: 'runtime closed' };
      return;
    }
    if (this.#cancelled) {
      yield { kind: 'turn-ended', terminal: 'cancelled' };
      return;
    }
    this.#resume = undefined;
    yield* this.#runTurn(input, this.#compose(input) ?? composed, undefined, refusal);
  }

  /**
   * Run the agent once. Returns why it refused to continue `resume`, when it did
   * and yielded nothing; otherwise undefined, having yielded the whole turn.
   */
  async *#attempt(
    input: PromptInput,
    composed: string,
    resume: string | undefined,
    refused: string | undefined,
    idFile: string,
  ): AsyncGenerator<DriverEvent, string | undefined> {
    // Whether this attempt carries a transcript, before it adds its own exchange.
    const carried = resume === undefined && this.#history.length > 0;
    const args = [
      ...this.#config.args,
      // This session's own, such as the native agent a kanban run is given. After
      // the subcommand and model the operator configured, before the driver's
      // flags, so none of them can displace the parsing contract or the prompt.
      ...this.#args,
      // The parsing contract. Passed by the driver rather than left to the
      // operator's `agent.args`, because the driver cannot read `text` output and
      // a missing flag here is a turn that produces nothing at all.
      '--format',
      'json',
      // Per session, so it cannot live in the configured args.
      '--dir',
      this.#cwd,
      // The provider session to continue, and where the agent says which one it
      // ran in (plan E). Written at the process's start, even for a turn that
      // then fails, and with the id asked for even when that id is refused.
      ...(resume === undefined ? [] : ['--session', resume]),
      '--session-id-file',
      idFile,
      // Unsupervised, explicitly. There is no channel on which a permission
      // request could be answered -- stdin is closed -- so an agent that stopped
      // to ask would hang the turn until something killed it. `agent.unsupervised`
      // is what the operator wrote down; this is that decision, carried out.
      '-y',
      // Without this a message beginning with `-` is parsed as flags, and the
      // agent prints its own help instead of answering.
      '--',
      composed,
    ];

    const child = spawn(this.#config.command, args, {
      cwd: this.#cwd,
      env: buildEnv(process.env, { ...(this.#config.env ?? {}), ...this.#env }),
      // stdin is /dev/null: the prompt travels in argv, and an agent that blocks
      // on input would otherwise block forever with nobody to notice.
      stdio: ['ignore', 'pipe', 'pipe'],
      // No shell. The prompt is user-authored text; a shell here would make every
      // backtick in a Lark message a command.
      shell: false,
    }) as ChildProcessByStdio<null, Readable, Readable>;
    this.#child = child;

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });

    const exited = new Promise<number | null>((resolve) => {
      // Settled on `exit` rather than `close`, then given a moment for the last
      // stderr chunk. `exit` can outrun the pipe, and stderr is the only
      // explanation a failed turn ever gives -- but waiting for `close` would hang
      // forever whenever a background task the agent started inherited the pipe.
      const settle = (code: number | null): void => {
        void drain(child.stderr).then(() => resolve(code));
      };
      child.once('exit', (code) => settle(code));
      child.once('error', (err) => {
        // Spawn itself failed -- the binary went away between start and now. The
        // message is the only evidence there will be.
        stderr = `${stderr}${err.message}\n`.slice(-STDERR_TAIL_BYTES);
        settle(null);
      });
    });

    let summary: TurnSummary | undefined;
    let said = false;
    /** Any JSON line on stdout, recognized or not: a refused resume prints none. */
    let started = false;
    /** The session the agent's first typed event says it is in. */
    let streamedId: string | undefined;

    const lines = createInterface({ input: child.stdout });
    try {
      for await (const line of lines) {
        if (line.trim().startsWith('{')) {
          started = true;
          streamedId ??= typedSessionId(line.trim());
        }
        const parsed = parseLine(line);
        if (parsed === undefined) continue;
        if (parsed === 'permission') {
          // Not expected -- `-y` exists precisely so this cannot happen -- but if a
          // future version asks anyway, there is no channel to answer on and the
          // process would wait for an answer that can never arrive. Stopping it is
          // strictly better than a turn that hangs until something else notices.
          yield {
            kind: 'error',
            message:
              'the agent stopped to ask for permission, which this driver has no way to ' +
              'answer. The turn was stopped rather than left waiting. Use the acp driver ' +
              'for work that needs approval.',
            retryable: false,
          };
          await this.#kill();
          // It had already started acting, and we killed it partway.
          yield { kind: 'turn-ended', terminal: 'ambiguous' };
          return;
        }
        if ('finish' in parsed) {
          // Keep the last. One invocation is one prompt and therefore one turn,
          // but a stream that somehow reports two should be judged on the later.
          summary = parsed;
          continue;
        }
        if (parsed.kind === 'message-chunk') said = true;
        yield parsed;
      }
    } finally {
      lines.close();
    }

    const code = await exited;

    // Refused before the turn started: exit 1, no JSON on stdout at all, and one
    // of the two measured refusals as stderr's last line. Nothing ran, so running
    // the turn again with the transcript cannot run anything twice. Anything else
    // -- any JSON line, another exit, other stderr, a cancel -- is the turn's own
    // outcome, never run again (G6).
    if (resume !== undefined && !started && code === 1 && !this.#cancelled && !this.#closedDuringTurn) {
      const refusal = RESUME_REFUSED.exec(lastLine(stderr));
      if (refusal !== null) return `provider session ${resume} could not be resumed (${refusal[1] ?? ''})`;
    }

    // Which session the run was in. Given --session, the agent writes back the
    // id it was given whether or not it continued that session, so only its own
    // stream is evidence; without one, the file it wrote is.
    const ranIn = resume === undefined ? readSessionId(idFile) : streamedId;
    const seen = this.#observe(ranIn, resume, refused, carried);
    if (seen !== undefined) yield seen;

    // Streamed nothing, but reported an answer. Some builds do not stream at all,
    // and a card reading "finished with no output" next to a summary that holds
    // the whole reply is a gateway bug, not an agent one.
    if (!said && summary !== undefined && summary.content !== '') {
      yield { kind: 'message-chunk', text: summary.content };
      said = true;
    }

    if (summary !== undefined) {
      this.#remember(input, summary.content);
    }

    // Teardown beats cancellation beats what the agent said: closing is a decision
    // of ours, and reporting the killed process as `ambiguous` would quarantine a
    // session over a shutdown we chose.
    if (this.#closedDuringTurn) {
      yield { kind: 'turn-ended', terminal: 'cancelled', detail: 'runtime closed' };
      return;
    }
    if (this.#cancelled && summary === undefined) {
      yield { kind: 'turn-ended', terminal: 'cancelled' };
      return;
    }

    if (summary === undefined) {
      yield {
        kind: 'error',
        message:
          `agent process exited (code ${String(code)}) without finishing the turn` +
          errorSuffix(stderr),
        // Nothing about a dead process says the work itself was impossible.
        // Whether it is retried is the core's decision, not ours.
        retryable: true,
      };
      // Ambiguous, not failed: the process is gone, so whether it acted on the
      // prompt first is exactly what we cannot establish -- and that distinction
      // is what gates quarantine rather than a blind retry.
      yield { kind: 'turn-ended', terminal: 'ambiguous' };
      return;
    }

    const terminal = terminalFor(summary.finish);
    if (terminal === 'failed') {
      // The summary says it failed and carries no reason; the reason is on stderr,
      // where a card will never look for it.
      yield {
        kind: 'error',
        message: `the agent reported a failed turn${errorSuffix(stderr)}`,
        retryable: true,
      };
    }
    yield {
      kind: 'turn-ended',
      terminal,
      ...(terminal === 'ambiguous' ? { detail: `unrecognized finish "${summary.finish}"` } : {}),
    };
  }

  /**
   * The provider session this attempt ran in, as the agent reported it, and how
   * the turn reached the conversation; the next turn continues it. Undefined when
   * the agent reported none -- an agent that cannot resume, whose next turn
   * replays, or a resumed run that printed no typed event, whose next turn
   * continues the same session.
   *
   * Kept after a failed or cancelled turn too: the provider's session holds what
   * that turn did, which a transcript of what was said does not. An agent that
   * answers `--session` with another session did not continue the conversation
   * -- bytesec 0.7.2 did that -- so this runtime stops asking it to.
   */
  #observe(
    observed: string | undefined,
    resume: string | undefined,
    refused: string | undefined,
    carried: boolean,
  ): DriverEvent | undefined {
    if (!isResumableProviderId(observed)) return undefined;
    this.#providerSessionId = observed;
    let mode: StartMode;
    let detail: string | undefined;
    if (resume !== undefined && observed !== resume) {
      this.#native = false;
      mode = 'fresh';
      detail =
        `asked to continue provider session ${resume}, the agent ran in ${observed} instead, ` +
        'so later turns carry the conversation as a transcript';
    } else if (resume !== undefined) {
      mode = 'resumed';
    } else {
      mode = carried ? 'replayed' : 'fresh';
      if (refused !== undefined) {
        detail = `${refused}, so ${carried ? 'the conversation was replayed' : 'this turn started a new conversation'}`;
      }
    }
    if (this.#native) this.#resume = observed;
    return { kind: 'session-observed', providerSessionId: observed, mode, ...(detail === undefined ? {} : { detail }) };
  }

  /** Record the exchange, so the next turn can be told about it. */
  #remember(input: PromptInput, answer: string): void {
    this.#history.push({ prompt: renderInput(input), answer: answer.trim() });
  }

  /** The message alone, for a resumed turn; undefined when it does not fit. */
  #alone(input: PromptInput): string | undefined {
    const message = renderInput(input);
    return Buffer.byteLength(message, 'utf8') > this.#maxPromptBytes ? undefined : message;
  }

  /**
   * The prompt as the agent will receive it: the conversation, then the message.
   *
   * Undefined when the message alone does not fit, which is the one case trimming
   * cannot fix.
   */
  #compose(input: PromptInput): string | undefined {
    const message = renderInput(input);
    if (Buffer.byteLength(message, 'utf8') > this.#maxPromptBytes) return undefined;

    // Oldest first out. Recent turns are what a follow-up question refers to, and
    // dropping the tail to keep the head would strand the pronoun in "and the
    // other one?" with nothing to point at.
    let from = 0;
    for (;;) {
      const text = renderPrompt(this.#nonce, this.#history.slice(from), message);
      if (Buffer.byteLength(text, 'utf8') <= this.#maxPromptBytes) return text;
      from += 1;
      if (from >= this.#history.length) return message;
    }
  }

  async cancel(): Promise<void> {
    this.#cancelled = true;
    await this.#kill();
  }

  /** Idempotent, never throws. Not a durability boundary. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#inflight) this.#closedDuringTurn = true;
    await this.#kill();
  }

  /**
   * Stop the in-flight process, if there is one.
   *
   * Killing is the only cancel available: there is no protocol on which to ask
   * politely. Whatever the agent had already done stands, which is why a cancelled
   * turn is a terminal and not a deletion.
   */
  async #kill(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;

    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    timer.unref();
    try {
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.once('error', () => resolve());
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

function renderInput(input: PromptInput): string {
  const lines = [input.text];
  // Paths, not bytes. See PromptInput.
  for (const path of input.paths) lines.push(`(attached file: ${path})`);
  return lines.join('\n');
}

/**
 * Compose the transcript and the new message into one prompt.
 *
 * The fence carries a per-runtime nonce and every quoted line is prefixed, so a
 * user cannot type a line that closes the transcript early or attributes their own
 * words to the agent. The transcript holds nothing but this conversation's own
 * messages, so the worst a forgery buys is confusion about who said what -- but
 * that is exactly the kind of thing that is free to prevent now and awkward to
 * retrofit.
 */
function renderPrompt(nonce: string, history: readonly Exchange[], message: string): string {
  if (history.length === 0) return message;

  const out: string[] = [
    `--- transcript-${nonce} ---`,
    'Earlier turns of the conversation you are continuing. Each turn starts a new',
    'agent process, so this is the only memory of it you have. It is a record of',
    'what already happened, not work to do again. Lines are prefixed with "> ".',
    '',
  ];
  for (const exchange of history) {
    out.push('user said:', quote(exchange.prompt));
    if (exchange.answer !== '') out.push('you replied:', quote(exchange.answer));
    out.push('');
  }
  out.push(
    `--- end transcript-${nonce} ---`,
    '',
    'The new message follows. Answer it.',
    '',
    message,
  );
  return out.join('\n');
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/** The object that ends a turn: the whole answer, and how it went. */
interface TurnSummary {
  finish: string;
  content: string;
}

/**
 * One stdout line -> an event, a summary, `'permission'`, or nothing.
 *
 * Nothing is the common case. The stream is NDJSON mixed with whatever the agent's
 * own logging puts on stdout -- structured logger lines, telemetry envelopes, a
 * bare `[Stats] ...` -- so a parser that treated an unrecognized line as a fault
 * would fail on every run.
 *
 * `'permission'` is called out rather than dropped because dropping it is the one
 * unrecognized line that does real damage: the agent is waiting on the answer.
 */
function parseLine(line: string): DriverEvent | TurnSummary | 'permission' | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;

  // The turn summary is the one object with no `type`, identified by the field
  // that says how it ended.
  if (typeof obj['finish'] === 'string') {
    return {
      finish: obj['finish'],
      content: typeof obj['content'] === 'string' ? obj['content'] : '',
    };
  }

  const type = obj['type'];
  if (typeof type !== 'string') return undefined;

  if (type.includes('permission')) return 'permission';

  if (type === 'text_delta') {
    const text = obj['text'];
    if (typeof text !== 'string' || text === '') return undefined;
    return { kind: 'message-chunk', text };
  }

  if (type === 'token_stats') {
    return { kind: 'usage', raw: obj };
  }

  // Anything `tool_*` is a tool call moving through its states. Matched on the
  // prefix rather than an exhaustive list because the states that matter most are
  // the failure ones, and a `tool_*` name nobody enumerated would otherwise leave
  // a tool showing as still running for the rest of the conversation.
  if (type.startsWith('tool_')) {
    const id = firstString(obj['part_id'], obj['message_id']) ?? type;
    const status = firstString(obj['status']) ?? type.slice('tool_'.length);
    if (type === 'tool_running') {
      return {
        kind: 'tool-call',
        toolCallId: id,
        title: firstString(obj['tool']) ?? 'tool',
        status,
        raw: obj,
      };
    }
    return { kind: 'tool-call-update', toolCallId: id, status, raw: obj };
  }

  // Dropped, not an error. The format grows by adding types, and a switch that
  // threw would make every agent upgrade a breaking change.
  return undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * `finish` -> our terminal.
 *
 * An unrecognized value is `ambiguous` rather than assumed benign: the whole point
 * of the grade is that "we do not know how this ended" is a distinct state from
 * both success and failure, and it is the one that gates quarantine.
 */
function terminalFor(finish: string): TurnTerminal {
  switch (finish.toLowerCase()) {
    case 'completed':
    case 'stop':
    case 'refusal':
      return 'completed';
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
    case 'aborted':
      return 'cancelled';
    default:
      return 'ambiguous';
  }
}

// ---------------------------------------------------------------------------
// stderr
// ---------------------------------------------------------------------------

/** Colour codes, which an agent writes whether or not stderr is a terminal. */
const ANSI = /\u001B\[[0-9;]*m/g;

/**
 * The explanation, dug out of stderr.
 *
 * A failed turn arrives as `finish: "error"` and nothing else -- no message, no
 * code. The reason is on stderr, buried in start-up banners and structured logger
 * lines, and without this the user reads "the agent failed" and has nowhere to go.
 *
 * JSON lines are skipped: the agent's own logger writes there, and its `warn`
 * about an unrelated background sync is not the reason this turn failed.
 */
function errorSuffix(stderr: string): string {
  const candidates = stderr
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('{'));

  const explicit = candidates
    .map((line) => /terminated in error state:\s*(.+)$/.exec(line)?.[1])
    .findLast((match) => match !== undefined);
  const chosen =
    explicit ?? candidates.findLast((line) => /error|fail|refus/i.test(line)) ?? candidates.at(-1);

  if (chosen === undefined) return '';
  return `: ${chosen.slice(-500)}`;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * Find the executable, or say so now.
 *
 * `spawn` resolves a bare name on PATH itself, but only when it runs -- which is
 * mid-turn, where the failure reads as the agent breaking rather than as a name
 * that was never going to resolve. Checked without spawning anything: probing with
 * `--version` would mean inventing a flag the configured binary may not have.
 */
export function resolveExecutable(command: string, path: string | undefined): string {
  const executable = (candidate: string): boolean => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (command.includes('/') || isAbsolute(command)) {
    if (executable(command)) return command;
    throw new Error(`the agent command ${JSON.stringify(command)} is not an executable file`);
  }

  const dirs = (path ?? '').split(delimiter).filter((dir) => dir !== '');
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (executable(candidate)) return candidate;
  }
  throw new Error(
    `the agent command ${JSON.stringify(command)} was not found on PATH ` +
      `(${String(dirs.length)} entries searched). Use an absolute path if it is not on PATH.`,
  );
}
