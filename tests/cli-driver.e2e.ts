import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAgentVersion } from '../src/cli/role.js';
import { createCliDriver, resolveExecutable } from '../src/driver/cli/driver.js';
import type { AgentRuntime, DriverEvent, PromptInput, StartResult } from '../src/driver/types.js';

/**
 * The CLI driver against real child processes -- one per turn, which is the whole
 * point of it.
 *
 * `tests/fakes/cli-agent.mjs` writes its argv to a log on every invocation. That
 * log is the only way to see the composed prompt and the `--session` asked for,
 * and those two *are* this driver's session handling: the provider's session
 * continued natively, or, from an agent that cannot resume, the conversation as
 * text the driver puts on the command line. With `sessions`, the fake keeps
 * sessions as bytesec 0.7.4 does (plan E's spike).
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));

interface Started {
  runtime: AgentRuntime;
  result: StartResult;
  cwd: string;
  /** One entry per process the driver started, in order. */
  invocations(): Invocation[];
  /** The prompts the fake's store holds for a provider session. */
  stored(id: string): { agent: string; prompts: string[] };
}

interface Invocation {
  argv: string[];
  prompt: string;
  apm: string | null;
  session: string | null;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function start(
  mode: string,
  opts: {
    replay?: PromptInput[];
    maxPromptBytes?: number;
    args?: string[];
    env?: Record<string, string>;
    /** A store for the fake's sessions, shared by every start given the same one. */
    sessions?: string;
    providerSessionId?: string | undefined;
  } = {},
): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'mt-cli-test-'));
  const logPath = join(dir, 'invocations.log');
  const driver = createCliDriver({
    command: process.execPath,
    args: [AGENT],
    env: {
      FAKE_CLI_MODE: mode,
      FAKE_CLI_LOG: logPath,
      ...(opts.sessions === undefined ? {} : { FAKE_CLI_SESSIONS: opts.sessions }),
    },
    ...(opts.maxPromptBytes === undefined ? {} : { maxPromptBytes: opts.maxPromptBytes }),
  });

  const started = await driver.start({
    cwd: dir,
    replay: opts.replay,
    args: opts.args,
    env: opts.env,
    providerSessionId: opts.providerSessionId,
  });

  cleanups.push(async () => {
    await started.runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    runtime: started.runtime,
    result: started.result,
    cwd: dir,
    invocations: () => {
      let raw: string;
      try {
        raw = readFileSync(logPath, 'utf8');
      } catch {
        return [];
      }
      return raw
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Invocation);
    },
    stored: (id) => {
      if (opts.sessions === undefined) throw new Error('this start keeps no sessions');
      return JSON.parse(readFileSync(join(opts.sessions, `${id}.json`), 'utf8')) as { agent: string; prompts: string[] };
    },
  };
}

/** A directory for the fake's sessions, removed after the test. */
function store(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mt-cli-sessions-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function observed(events: readonly DriverEvent[]): Extract<DriverEvent, { kind: 'session-observed' }> | undefined {
  return events.find((e): e is Extract<DriverEvent, { kind: 'session-observed' }> => e.kind === 'session-observed');
}

/** The value after a flag in an invocation's argv, before the prompt. */
function flagOf(invocation: Invocation | undefined, name: string): string | undefined {
  const argv = invocation?.argv ?? [];
  const end = argv.indexOf('--');
  const i = argv.slice(0, end === -1 ? argv.length : end).indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

async function collect(stream: AsyncIterable<DriverEvent>): Promise<DriverEvent[]> {
  const events: DriverEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function texts(events: readonly DriverEvent[]): string {
  return events
    .filter((e): e is Extract<DriverEvent, { kind: 'message-chunk' }> => e.kind === 'message-chunk')
    .map((e) => e.text)
    .join('');
}

function kinds(events: readonly DriverEvent[]): string[] {
  return events.map((e) => e.kind);
}

function said(text: string): PromptInput {
  return { text, paths: [] };
}

describe('CLI driver: establishing a session', () => {
  it('starts without a process, and reports no provider id until a turn does', async () => {
    const s = await start('basic');
    // No process yet: there is nothing for one to hold open between turns.
    expect(s.invocations()).toEqual([]);
    // The agent mints its session's id in the first turn's process; an id made up
    // here would be stored as observed and handed back as one to resume.
    expect(s.result.providerSessionId).toBe('');
    expect(s.runtime.providerSessionId).toBe('');
    expect(s.result.mode).toBe('fresh');
  });

  it('reports replayed when there is history to carry and no session to continue', async () => {
    // The user is entitled to know the agent is working from a transcript.
    const s = await start('basic', { replay: [said('earlier')] });
    expect(s.result.mode).toBe('replayed');
  });

  it('reports a command that does not exist at start, not mid-turn', async () => {
    const driver = createCliDriver({ command: '/nonexistent/agent-binary', args: [] });
    // Failing to start leaves the session cold. The same failure discovered on the
    // first prompt looks like the agent breaking, and breaking mid-turn is what
    // quarantines a session.
    await expect(driver.start({ cwd: tmpdir() })).rejects.toThrow(/not an executable file/);
  });

  it("reads an agent's version from its --version, and nothing from a command that cannot run", () => {
    // `mt role check` asks bytesec this way (plan E); node answers `v22.…`.
    expect(readAgentVersion(process.execPath, process.env)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readAgentVersion('/nonexistent/agent-binary', process.env)).toBeUndefined();
  });

  it('finds a bare command on PATH, and says so when it cannot', () => {
    expect(resolveExecutable('node', process.env['PATH'])).toMatch(/node/);
    expect(() => resolveExecutable('definitely-not-a-real-binary', '/usr/bin:/bin')).toThrow(
      /not found on PATH/,
    );
  });

  it('gives the agent the session environment over the configured one', async () => {
    // A run's MT_KANBAN_* variables arrive this way (spec §2.4 item 3); the
    // session's value wins, so the log lands where the start said, not the config.
    const dir = mkdtempSync(join(tmpdir(), 'mt-cli-env-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const configured = join(dir, 'configured.log');
    const fromStart = join(dir, 'from-start.log');
    const driver = createCliDriver({
      command: process.execPath,
      args: [AGENT],
      env: { FAKE_CLI_MODE: 'basic', FAKE_CLI_LOG: configured },
    });
    const { runtime } = await driver.start({ cwd: dir, env: { FAKE_CLI_LOG: fromStart } });
    cleanups.push(() => runtime.close());
    await collect(runtime.prompt(said('hello')));
    expect(readFileSync(fromStart, 'utf8')).toContain('hello');
    expect(() => readFileSync(configured, 'utf8')).toThrow();
  });
});

describe('CLI driver: a turn', () => {
  it('normalizes the stream into driver events, ending with a terminal', async () => {
    const s = await start('basic');
    const events = await collect(s.runtime.prompt(said('go')));

    expect(kinds(events)).toEqual(['message-chunk', 'message-chunk', 'usage', 'turn-ended']);
    expect(texts(events)).toBe('hello world (go)');
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'completed' });
  });

  it('passes the flags the parser and the workspace depend on', async () => {
    const s = await start('basic');
    await collect(s.runtime.prompt(said('go')));

    const argv = s.invocations()[0]?.argv ?? [];
    // `--format json` is the parsing contract; text output would produce a turn
    // with no events at all.
    expect(argv.join(' ')).toContain('--format json');
    // The workspace is per session, so it cannot come from the configured args.
    expect(argv.join(' ')).toContain(`--dir ${s.cwd}`);
    // Unsupervised, explicitly: there is nowhere to answer a permission request.
    expect(argv).toContain('-y');
    // `--` before the prompt, or a message beginning with `-` is parsed as flags
    // and the agent prints its own help instead of answering.
    expect(argv.indexOf('--')).toBe(argv.length - 2);
  });

  it("puts a session's own arguments after the configured ones, and its environment in the agent's", async () => {
    // How a kanban run reaches its role's native agent package (plan R).
    const s = await start('basic', { args: ['--agent', 'implementer'], env: { BYTESEC_LOCAL_APM_PATH: '/pkg/a' } });
    await collect(s.runtime.prompt(said('go')));
    await collect(s.runtime.prompt(said('again')));

    // Every turn is a process, and each is given them.
    for (const { argv, apm } of s.invocations()) {
      // argv after the script: the configured args are the script itself here.
      expect(argv.slice(0, 3)).toEqual(['--agent', 'implementer', '--format']);
      expect(apm).toBe('/pkg/a');
    }
    expect(s.invocations()).toHaveLength(2);
  });

  it('gives an agent no extra arguments, and no package, when the session has none', async () => {
    const s = await start('basic');
    await collect(s.runtime.prompt(said('go')));
    expect(s.invocations()[0]?.argv[0]).toBe('--format');
    expect(s.invocations()[0]?.apm).toBeNull();
  });

  it('maps a tool call through its states under one id', async () => {
    const s = await start('tool');
    const events = await collect(s.runtime.prompt(said('list files')));

    expect(kinds(events)).toEqual([
      'tool-call',
      'tool-call-update',
      'message-chunk',
      'turn-ended',
    ]);
    const call = events[0] as Extract<DriverEvent, { kind: 'tool-call' }>;
    const update = events[1] as Extract<DriverEvent, { kind: 'tool-call-update' }>;
    // Same id across both, or the card shows a second tool that never finishes.
    expect(call.toolCallId).toBe(update.toolCallId);
    expect(call.title).toBe('Glob');
    expect(update.status).toBe('completed');
  });

  it('drops lines it has no projection for and keeps the ones it has', async () => {
    const s = await start('noise');
    const events = await collect(s.runtime.prompt(said('go')));
    // Logger output, telemetry envelopes and a bare `[Stats]` line all share this
    // stdout. A parser that treated an unrecognized line as a fault would fail on
    // every single run.
    expect(kinds(events)).toEqual(['usage', 'turn-ended']);
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'completed' });
  });

  it('shows an answer that was only ever summarized', async () => {
    const s = await start('unstreamed');
    const events = await collect(s.runtime.prompt(said('go')));
    // The answer exists; it just never arrived as deltas. Rendering "finished with
    // no output" next to a summary holding the whole reply would be our bug.
    expect(texts(events)).toBe('the whole answer, unstreamed');
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'completed' });
  });

  it('sends attachments as paths, never as bytes', async () => {
    const s = await start('basic');
    await collect(s.runtime.prompt({ text: 'look', paths: ['/tmp/a.png'] }));
    expect(s.invocations()[0]?.prompt).toContain('/tmp/a.png');
  });

  it('refuses a second concurrent prompt instead of interleaving two turns', async () => {
    const s = await start('hang');
    const first = s.runtime.prompt(said('one'));
    expect(() => s.runtime.prompt(said('two'))).toThrow(/already in flight/);

    await s.runtime.cancel();
    await collect(first);
  });
});

describe('CLI driver: continuity', () => {
  it('carries the previous turn into the next one, fenced', async () => {
    const s = await start('basic');
    await collect(s.runtime.prompt(said('remember pickle')));
    await collect(s.runtime.prompt(said('what did I say?')));

    const second = s.invocations()[1]?.prompt ?? '';
    // There is no resume, so continuity is text or it is nothing.
    expect(second).toContain('remember pickle');
    expect(second).toContain('hello world (remember pickle)');
    expect(second).toContain('what did I say?');
    // Fenced with a per-runtime nonce, and every quoted line prefixed, so a user
    // cannot type a line that closes the transcript or attributes their own words
    // to the agent.
    expect(second).toMatch(/--- transcript-[0-9a-f]{8} ---/);
    expect(second).toContain('> remember pickle');
  });

  it('says nothing about a conversation that has not happened yet', async () => {
    const s = await start('basic');
    await collect(s.runtime.prompt(said('first thing')));
    // A first turn with no history is the prompt and nothing else. A transcript
    // header over an empty transcript is context the agent has to read past.
    expect(s.invocations()[0]?.prompt).toBe('first thing');
  });

  it('carries replayed prompts, and does not invent answers for them', async () => {
    const s = await start('basic', { replay: [said('asked before')] });
    await collect(s.runtime.prompt(said('asking now')));

    const prompt = s.invocations()[0]?.prompt ?? '';
    expect(prompt).toContain('> asked before');
    // The log has the answers, but `StartOptions.replay` carries prompts only, and
    // the driver is not allowed its own idea of history.
    expect(prompt).not.toContain('you replied');
  });

  it('drops the oldest turns rather than the message being answered', async () => {
    // Sized so the third turn can carry one exchange and not two.
    const s = await start('basic', { maxPromptBytes: 440 });
    await collect(s.runtime.prompt(said('first turn here')));
    await collect(s.runtime.prompt(said('second turn here')));
    await collect(s.runtime.prompt(said('third')));

    const third = s.invocations()[2]?.prompt ?? '';
    expect(third).toContain('third');
    // The recent turn is what "and the other one?" points at; keeping the head and
    // dropping the tail would strand the pronoun.
    expect(third).toContain('second turn here');
    expect(third).not.toContain('first turn here');
  });

  it('refuses a message too large for a command line before starting anything', async () => {
    const s = await start('basic', { maxPromptBytes: 500 });
    const events = await collect(s.runtime.prompt(said('z'.repeat(600))));

    expect(kinds(events)).toEqual(['error', 'turn-ended']);
    const error = events[0] as Extract<DriverEvent, { kind: 'error' }>;
    expect(error.message).toContain('command line');
    // Nothing about retrying makes the message shorter.
    expect(error.retryable).toBe(false);
    // Failed, not ambiguous: it never reached the agent, so nothing is unclear.
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'failed' });
    expect(s.invocations()).toEqual([]);
  });
});

describe('CLI driver: native resume', () => {
  it('reads the id the agent writes, and reports it with how the turn reached the conversation', async () => {
    const s = await start('basic', { sessions: store() });
    const events = await collect(s.runtime.prompt(said('remember pickle')));

    // Before the terminal, so the core stores it with the turn still open.
    expect(kinds(events)).toEqual(['message-chunk', 'message-chunk', 'usage', 'session-observed', 'turn-ended']);
    const seen = observed(events);
    expect(seen?.providerSessionId).toMatch(/^ses_fake_/);
    expect(seen?.mode).toBe('fresh');
    expect(s.runtime.providerSessionId).toBe(seen?.providerSessionId);
    // A first turn asks for no session, and is told where to write the one it ran in.
    const [first] = s.invocations();
    expect(first?.session).toBeNull();
    // The id file is the driver's own, outside the workspace, and gone once read.
    const idFile = flagOf(first, '--session-id-file') ?? '';
    expect(idFile.startsWith(s.cwd)).toBe(false);
    expect(existsSync(idFile)).toBe(false);
  });

  it('continues that session on the next turn, sending only the new message', async () => {
    const s = await start('basic', { sessions: store() });
    const first = observed(await collect(s.runtime.prompt(said('remember pickle'))));
    const events = await collect(s.runtime.prompt(said('what did I say?')));

    const second = s.invocations()[1];
    expect(second?.session).toBe(first?.providerSessionId);
    // No transcript: the provider's session holds the conversation.
    expect(second?.prompt).toBe('what did I say?');
    expect(observed(events)).toEqual({
      kind: 'session-observed',
      providerSessionId: first?.providerSessionId,
      mode: 'resumed',
    });
    expect(s.stored(first?.providerSessionId ?? '').prompts).toEqual(['remember pickle', 'what did I say?']);
  });

  it('starts from a session observed before, and says so, without the transcript', async () => {
    // A restart, an idle eviction or a rework's seed (spec §2.4 item 5).
    const sessions = store();
    const before = await start('basic', { sessions });
    const id = observed(await collect(before.runtime.prompt(said('remember pickle'))))?.providerSessionId;

    const s = await start('basic', { sessions, providerSessionId: id, replay: [said('remember pickle')] });
    expect(s.result).toEqual({ providerSessionId: id, mode: 'resumed' });
    await collect(s.runtime.prompt(said('what did I say?')));
    expect(s.invocations()[0]?.session).toBe(id);
    expect(s.invocations()[0]?.prompt).toBe('what did I say?');
  });

  it('never hands back an id it stored before it could resume', async () => {
    // A session from before native resume holds `cli:<nonce>`, which names a runtime.
    const s = await start('basic', { sessions: store(), providerSessionId: 'cli:1a2b3c4d', replay: [said('asked before')] });
    expect(s.result).toEqual({ providerSessionId: '', mode: 'replayed' });
    const events = await collect(s.runtime.prompt(said('asking now')));
    expect(s.invocations()[0]?.session).toBeNull();
    expect(s.invocations()[0]?.prompt).toContain('> asked before');
    expect(observed(events)?.mode).toBe('replayed');
  });

  it('keeps the session of a turn that failed, and continues it on the next', async () => {
    // The provider's session holds what the failed turn did; a transcript holds only what was said.
    const s = await start('error', { sessions: store() });
    const events = await collect(s.runtime.prompt(said('go')));
    expect(kinds(events)).toEqual(['session-observed', 'error', 'turn-ended']);
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'failed' });

    await collect(s.runtime.prompt(said('again')));
    expect(s.invocations()[1]?.session).toBe(observed(events)?.providerSessionId);
  });

  it('keeps the session of a cancelled turn', async () => {
    const s = await start('hang', { sessions: store() });
    const iterator = s.runtime.prompt(said('forever'))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ kind: 'message-chunk' });
    await s.runtime.cancel();
    const rest: DriverEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      rest.push(next.value);
    }
    expect(kinds(rest)).toEqual(['session-observed', 'turn-ended']);
    expect(rest.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'cancelled' });
    expect(s.runtime.providerSessionId).toMatch(/^ses_fake_/);
  });

  it('reports nothing for a resumed turn that printed no typed event, and goes on continuing the session', async () => {
    // Given --session, the id file only echoes it: the agent's own events are the evidence.
    const sessions = store();
    const before = await start('basic', { sessions });
    const id = observed(await collect(before.runtime.prompt(said('remember pickle'))))?.providerSessionId;

    const s = await start('unstreamed', { sessions, providerSessionId: id });
    const events = await collect(s.runtime.prompt(said('what did I say?')));
    expect(kinds(events)).toEqual(['message-chunk', 'turn-ended']);
    expect(s.runtime.providerSessionId).toBe(id);
    await collect(s.runtime.prompt(said('and now?')));
    expect(s.invocations()[1]?.session).toBe(id);
  });

  it('ends a turn failed, saying why, when it cannot make the directory for the id', async () => {
    const s = await start('basic', { sessions: store() });
    const saved = process.env['TMPDIR'];
    process.env['TMPDIR'] = join(s.cwd, 'no-such-directory');
    let events: DriverEvent[];
    try {
      events = await collect(s.runtime.prompt(said('go')));
    } finally {
      if (saved === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = saved;
    }
    expect(kinds(events)).toEqual(['error', 'turn-ended']);
    expect((events[0] as Extract<DriverEvent, { kind: 'error' }>).message).toMatch(/^could not make a directory for the agent's session id: /);
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'failed' });
    expect(s.invocations()).toEqual([]);
  });
});

describe('CLI driver: when the agent will not resume', () => {
  it('runs the turn again with the transcript when the agent refuses the session, in the same turn', async () => {
    const s = await start('basic', { sessions: store(), providerSessionId: 'ses_gone', replay: [said('asked before')] });
    const events = await collect(s.runtime.prompt(said('asking now')));

    // One turn, completed: the refusal started nothing, so nothing ran twice.
    expect(kinds(events)).toEqual(['message-chunk', 'message-chunk', 'usage', 'session-observed', 'turn-ended']);
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'completed' });
    const [refused, replayed] = s.invocations();
    expect(s.invocations()).toHaveLength(2);
    expect(refused?.session).toBe('ses_gone');
    expect(refused?.prompt).toBe('asking now');
    expect(replayed?.session).toBeNull();
    expect(replayed?.prompt).toContain('> asked before');
    const seen = observed(events);
    expect(seen?.mode).toBe('replayed');
    expect(seen?.providerSessionId).not.toBe('ses_gone');
    expect(seen?.detail).toBe(
      'provider session ses_gone could not be resumed (persistence: session not found), so the conversation was replayed',
    );

    // The new session is the one continued from now on.
    await collect(s.runtime.prompt(said('and now')));
    expect(s.invocations()[2]?.session).toBe(seen?.providerSessionId);
    expect(s.invocations()[2]?.prompt).toBe('and now');
  });

  it('says a refused session with no history to carry started a new conversation', async () => {
    const s = await start('basic', { sessions: store(), providerSessionId: 'ses_gone' });
    const seen = observed(await collect(s.runtime.prompt(said('hello'))));
    expect(seen?.mode).toBe('fresh');
    expect(seen?.detail).toBe(
      'provider session ses_gone could not be resumed (persistence: session not found), so this turn started a new conversation',
    );
  });

  it('takes a session made as another agent for refused', async () => {
    // bytesec keeps a session's agent: resumed as another, it exits before the turn.
    const sessions = store();
    const writer = await start('basic', { sessions, args: ['--agent', 'writer'] });
    const id = observed(await collect(writer.runtime.prompt(said('draft it'))))?.providerSessionId;

    const s = await start('basic', { sessions, args: ['--agent', 'editor'], providerSessionId: id });
    const events = await collect(s.runtime.prompt(said('edit it')));
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'completed' });
    expect(s.invocations()).toHaveLength(2);
    expect(observed(events)?.detail).toContain('(unknown agent: writer)');
  });

  it('stops resuming an agent that answers --session with another session', async () => {
    // bytesec 0.7.2 did: the turn ran, but not in the conversation it was asked to continue.
    const s = await start('basic', { sessions: store(), env: { FAKE_CLI_RESUME: 'ignore' } });
    const first = observed(await collect(s.runtime.prompt(said('remember pickle'))));
    const second = observed(await collect(s.runtime.prompt(said('what did I say?'))));
    expect(s.invocations()[1]?.session).toBe(first?.providerSessionId);
    expect(second?.mode).toBe('fresh');
    expect(second?.detail).toBe(
      `asked to continue provider session ${first?.providerSessionId ?? ''}, the agent ran in ` +
        `${second?.providerSessionId ?? ''} instead, so later turns carry the conversation as a transcript`,
    );

    await collect(s.runtime.prompt(said('and now?')));
    const third = s.invocations()[2];
    expect(third?.session).toBeNull();
    expect(third?.prompt).toContain('> remember pickle');
  });

  it('takes the session a resumed run ran in from its events, not from the id file', async () => {
    // bytesec writes back the id it was given even when it does not continue it.
    const s = await start('basic', { sessions: store(), env: { FAKE_CLI_RESUME: 'echo' } });
    const first = observed(await collect(s.runtime.prompt(said('remember pickle'))));
    const second = observed(await collect(s.runtime.prompt(said('what did I say?'))));
    expect(s.invocations()[1]?.session).toBe(first?.providerSessionId);
    expect(second?.mode).toBe('fresh');
    expect(second?.providerSessionId).toMatch(/^ses_fake_/);
    expect(second?.providerSessionId).not.toBe(first?.providerSessionId);
    expect(s.runtime.providerSessionId).toBe(second?.providerSessionId);
    await collect(s.runtime.prompt(said('and now?')));
    expect(s.invocations()[2]?.session).toBeNull();
  });

  it('does not take a run that printed anything for refused, whatever stderr says', async () => {
    const s = await start('basic', { sessions: store(), providerSessionId: 'ses_gone', env: { FAKE_CLI_REFUSAL: 'noisy' } });
    const events = await collect(s.runtime.prompt(said('hello')));
    expect(s.invocations()).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'ambiguous' });
  });

  it('takes only the last line of stderr for a refusal', async () => {
    const s = await start('basic', { sessions: store(), providerSessionId: 'ses_gone', env: { FAKE_CLI_REFUSAL: 'trailing' } });
    const events = await collect(s.runtime.prompt(said('hello')));
    expect(s.invocations()).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'ambiguous' });
  });

  it('does not run a refused turn again once it is cancelled', async () => {
    const s = await start('basic', { sessions: store(), providerSessionId: 'ses_gone', env: { FAKE_CLI_REFUSAL: 'slow' } });
    const turn = collect(s.runtime.prompt(said('hello')));
    // The fake ignores the stop, and refuses as it would have, exit 1 and all:
    // only the cancel says not to run the turn again. Until it has started:
    for (let i = 0; i < 200 && s.invocations().length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    await s.runtime.cancel();
    const events = await turn;
    expect(events).toEqual([{ kind: 'turn-ended', terminal: 'cancelled' }]);
    expect(s.invocations()).toHaveLength(1);
  });

  it('does not run a resumed turn again when it fails after starting', async () => {
    // Only a refusal before the turn is safe to run again; a crash is the turn's own outcome.
    const sessions = store();
    const before = await start('basic', { sessions });
    const id = observed(await collect(before.runtime.prompt(said('remember pickle'))))?.providerSessionId;

    const s = await start('crash', { sessions, providerSessionId: id });
    const events = await collect(s.runtime.prompt(said('go')));
    expect(s.invocations()).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'ambiguous' });
    expect(observed(events)?.mode).toBe('resumed');
  });
});

describe('CLI driver: things going wrong', () => {
  it('hands over the reason a turn failed, from stderr', async () => {
    const s = await start('error');
    const events = await collect(s.runtime.prompt(said('go')));

    expect(kinds(events)).toEqual(['error', 'turn-ended']);
    const error = events[0] as Extract<DriverEvent, { kind: 'error' }>;
    // `finish: "error"` carries no message. Without this the user reads "the agent
    // failed" and has nowhere to go.
    expect(error.message).toContain('no such model');
    // The agent's own logger writes to the same stream; its unrelated shutdown
    // notice is not the reason this turn failed.
    expect(error.message).not.toContain('tce-shutdown');
    expect(error.retryable).toBe(true);
    // It ran and failed. That is a different thing from not knowing what happened.
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'failed' });
  });

  it('reports an exit with no terminal as ambiguous, with the stderr tail', async () => {
    const s = await start('crash');
    const events = await collect(s.runtime.prompt(said('go')));

    expect(kinds(events)).toEqual(['message-chunk', 'error', 'turn-ended']);
    const error = events[1] as Extract<DriverEvent, { kind: 'error' }>;
    expect(error.message).toContain('going down mid-turn');
    expect(error.message).toContain('code 7');
    // Ambiguous, not failed: the process is gone, so whether it acted on the prompt
    // first is exactly what cannot be established.
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'ambiguous' });
  });

  it('does not guess at a terminal it does not recognize', async () => {
    const s = await start('weird');
    const events = await collect(s.runtime.prompt(said('go')));
    // "We do not know how this ended" is a distinct state from success and from
    // failure, and it is the one that gates quarantine.
    expect(events.at(-1)).toEqual({
      kind: 'turn-ended',
      terminal: 'ambiguous',
      detail: 'unrecognized finish "interrupted_by_something_new"',
    });
  });

  it('stops an agent that asks for permission rather than leaving it waiting', async () => {
    const s = await start('permission');
    const events = await collect(s.runtime.prompt(said('delete things')));

    // `-y` exists so this cannot happen, but if a version asks anyway there is no
    // channel to answer on, and the process would wait for an answer that can never
    // arrive. Stopping it beats a turn that hangs until something else notices.
    expect(kinds(events)).toEqual(['message-chunk', 'error', 'turn-ended']);
    const error = events[1] as Extract<DriverEvent, { kind: 'error' }>;
    expect(error.message).toContain('no way to answer');
    expect(error.retryable).toBe(false);
    // It had started acting, and we killed it partway.
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'ambiguous' });
  });
});

describe('CLI driver: stopping', () => {
  it('ends a cancelled turn as cancelled, not as an error', async () => {
    const s = await start('hang');
    const stream = s.runtime.prompt(said('forever'));
    const iterator = stream[Symbol.asyncIterator]();
    // Wait until the process is actually streaming, so the cancel has something to
    // interrupt rather than racing the spawn.
    expect((await iterator.next()).value).toMatchObject({ kind: 'message-chunk' });

    await s.runtime.cancel();

    const rest: DriverEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      rest.push(next.value);
    }
    // Killing is the only cancel available, so whatever the agent had already done
    // stands. Cancellation is a terminal, not a deletion.
    expect(rest).toEqual([{ kind: 'turn-ended', terminal: 'cancelled' }]);
  });

  it('closes a turn that is still open when the runtime goes away', async () => {
    const s = await start('hang');
    const stream = s.runtime.prompt(said('forever'));
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();

    await s.runtime.close();

    const rest: DriverEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      rest.push(next.value);
    }
    // Closing is a decision of ours. Reporting the process we killed as ambiguous
    // would quarantine a session over our own shutdown.
    expect(rest).toEqual([
      { kind: 'turn-ended', terminal: 'cancelled', detail: 'runtime closed' },
    ]);
  });

  it('is safe to close twice', async () => {
    const s = await start('basic');
    await s.runtime.close();
    await expect(s.runtime.close()).resolves.toBeUndefined();
  });

  it('refuses a prompt after close instead of spawning one more process', async () => {
    const s = await start('basic');
    await s.runtime.close();
    expect(() => s.runtime.prompt(said('go'))).toThrow(/closed/);
    expect(s.invocations()).toEqual([]);
  });
});
