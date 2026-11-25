#!/usr/bin/env node
/**
 * A fake command-line agent, emitting ByteSec's `run --format json` stream by hand.
 *
 * Written against the observed wire format rather than a shared helper, for the
 * same reason `agent.mjs` is: the driver's job is to survive other people's
 * processes, and a real one interleaves its structured events with logger noise on
 * the same stdout, writes its actual failure reason to stderr, exits without
 * finishing, and ignores being asked to stop. None of that is reproducible with a
 * cooperative double.
 *
 * Behaviour is chosen by `FAKE_CLI_MODE`:
 *
 *   basic       two text deltas and token stats, then a completed turn
 *   tool        a tool call through running -> completed, then a completed turn
 *   noise       lines the driver has no projection for, then a completed turn
 *   permission  ask for permission, which no command line can answer
 *   error       write a reason to stderr, finish with `error`, exit 1
 *   crash       write to stderr and exit without finishing
 *   hang        stream one delta and then never finish
 *   unstreamed  stream nothing, put the whole answer in the summary
 *   weird       finish with a value nobody has a projection for
 *   kanban      run `mt kanban show`, then report `mt kanban complete`, as a board
 *               run's agent does: `mt` found on PATH, its input on stdin
 *   kanban-late the same, but only once it has been nudged; before that it
 *               narrates its next step and stops without reporting
 *   kanban-gated report `mt kanban complete`, which the task's gate refuses until a
 *               file `gate-ok` is in the workspace; then write it and report again
 *   kanban-review run `mt kanban show`, then ask for review with `mt kanban review`,
 *               saying, on a rework, the reviewer's reason it revised for
 *   kanban-body run `mt kanban show`; when the task's body is a worker command and
 *               its JSON, `start-workflow {…}` or `apply-dag {…}`, run it, writing
 *               its answer to `asked.log` beside the log; then report complete
 *   cron        in a chat turn whose prompt is `cron-add {…}`, run `mt cron add`
 *               with that JSON and answer with its answer; in a cron fire, answer
 *               `[nothing to report]` when the job's prompt says QUIET, hang when
 *               it says SLOW, and otherwise `Fired: ` and the job's prompt; each
 *               turn's PATH, its MT_CRON_FIRE if a fire's, and its
 *               MT_AGENT_SESSION, is appended to `cron-env.log` beside the log
 *   staged      a board run that works a while: a tool running, then, once a file
 *               `release-1` is beside the log, the tool done and a line of text,
 *               then, once `release-2` is, `mt kanban complete`
 *   wake        in a board run, report `mt kanban complete`, or, the first time a
 *               task whose title or body says BLOCK is run, `mt kanban block` as
 *               `needs_input`; in a chat turn the board woke (its prompt starts
 *               `Board update`), unblock with `mt kanban task unblock` the task its
 *               prompt says it may lift, unless the prompt says KEEP, and wait for
 *               a file `release` beside the log first when the prompt says SLOW;
 *               each chat turn's prompt,
 *               whether it had a wake token, and the unblock's answer, is
 *               appended to `wake.log` beside the log; a reaction task's run
 *               (its body starts as a role's wake prompt) lifts the block its
 *               body says it may with `mt kanban wake-show` and `wake-unblock`,
 *               logging both to `reaction.log`, and completes
 *
 * Every invocation appends its argv to `FAKE_CLI_LOG` as one JSON line. That file
 * is how a test sees the composed prompt -- which is the whole of this driver's
 * session handling, and otherwise invisible. The line also carries the one
 * environment variable a native package is named by, `BYTESEC_LOCAL_APM_PATH`,
 * as `apm` (null when unset), a board run's id, `MT_KANBAN_RUN`, as `run`, and
 * the session marker every agent session is given, `MT_AGENT_SESSION`, as
 * `marker`.
 *
 * In the kanban modes it also writes the run's environment to `kanban-env.json`
 * beside the log, token included: a test that later reports as a run whose
 * process has gone needs it, and the token is a test's own.
 *
 * With `FAKE_CLI_SESSIONS` set to a directory, it keeps sessions there as
 * bytesec 0.7.4 keeps them in its local store, as the native-resume spike measured:
 *
 *   - `--session-id-file <path>` is written at the start, before the turn, with
 *     the session's id and a newline: on success, failure and cancel alike, and
 *     with the id asked for even when that id is then refused;
 *   - without `--session`, a new session is made, as the agent the run names
 *     (`--agent`, else `bytesec-agent`);
 *   - `--session <id>` continues that session, whatever `--dir` says; one the
 *     store does not hold exits 1 with nothing on stdout and
 *     `turn 1: persistence: session not found` on stderr, and one made as
 *     another agent exits 1 with `turn 1: unknown agent: <its agent>`;
 *   - `FAKE_CLI_RESUME=ignore` makes a new session even when `--session` names
 *     one, as 0.7.2 did, so the id written is not the one asked for;
 *     `FAKE_CLI_RESUME=echo` does too, but writes the id asked for to the file,
 *     so only the `session_id` on its events says which session it ran in;
 *   - `FAKE_CLI_REFUSAL` changes how a refusal looks: `noisy` prints a typed
 *     event nobody has a projection for before it, `trailing` writes another
 *     stderr line after it, and `slow` ignores SIGTERM and waits 1 s first --
 *     inside the driver's 2 s grace before SIGKILL -- so a test can stop it and
 *     still see it exit 1 with the refusal, as a stop that loses the race would;
 *   - `FAKE_CLI_FIRST_ID` is the `session_id` of its first typed event, in place
 *     of the session's own, so a test can lead with one no driver could resume.
 *
 * Each session's file holds its agent and every prompt it was sent. Without
 * `FAKE_CLI_SESSIONS` the agent writes no id, as an agent that cannot resume.
 * The log line carries `--session`'s value as `session` (null when absent).
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MODE = process.env['FAKE_CLI_MODE'] ?? 'basic';
const LOG = process.env['FAKE_CLI_LOG'];
const SESSIONS = process.env['FAKE_CLI_SESSIONS'];

const argv = process.argv.slice(2);
const dashdash = argv.indexOf('--');
const prompt = dashdash === -1 ? '' : argv.slice(dashdash + 1).join(' ');
const flags = dashdash === -1 ? argv : argv.slice(0, dashdash);

/** A flag's value, before the `--` that starts the prompt. */
function flag(name) {
  const i = flags.indexOf(name);
  return i === -1 ? undefined : flags[i + 1];
}

const asked = flag('--session');

// Before the invocation is logged, so a stop the moment a test sees the
// invocation is already ignored, and the refusal still comes, exit 1 and all.
if (process.env['FAKE_CLI_REFUSAL'] === 'slow') process.on('SIGTERM', () => {});

if (LOG !== undefined) {
  const apm = process.env['BYTESEC_LOCAL_APM_PATH'] ?? null;
  const run = process.env['MT_KANBAN_RUN'] ?? null;
  const marker = process.env['MT_AGENT_SESSION'] ?? null;
  appendFileSync(LOG, `${JSON.stringify({ argv, prompt, apm, run, session: asked ?? null, marker })}\n`);
}

let SESSION = 'ses_fake_cli';

/** Refuse to continue the session, as bytesec does: before the turn, exit 1. Written synchronously, then gone. */
function refuse(line) {
  const how = process.env['FAKE_CLI_REFUSAL'];
  if (how === 'slow') {
    // SIGTERM is ignored (see the top), so the refusal still arrives after a stop,
    // well inside the driver's 2 s grace before SIGKILL.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  if (how === 'noisy') writeSync(1, `${JSON.stringify({ type: 'sentiment_delta', session_id: asked, mood: 'wary' })}\n`);
  writeSync(2, `${line}\n`);
  if (how === 'trailing') writeSync(2, 'session store closed\n');
  process.exit(1);
}

if (SESSIONS !== undefined) {
  mkdirSync(SESSIONS, { recursive: true });
  const agent = flag('--agent') ?? 'bytesec-agent';
  const resume = process.env['FAKE_CLI_RESUME'];
  const continuing = asked !== undefined && resume !== 'ignore' && resume !== 'echo';
  SESSION = continuing ? asked : `ses_fake_${randomBytes(6).toString('hex')}`;
  const idFile = flag('--session-id-file');
  if (idFile !== undefined) writeFileSync(idFile, `${asked !== undefined && resume === 'echo' ? asked : SESSION}\n`);
  const file = join(SESSIONS, `${SESSION}.json`);
  if (continuing) {
    if (!existsSync(file)) refuse('turn 1: persistence: session not found');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    if (stored.agent !== agent) refuse(`turn 1: unknown agent: ${stored.agent}`);
    writeFileSync(file, JSON.stringify({ agent, prompts: [...stored.prompts, prompt] }));
  } else {
    writeFileSync(file, JSON.stringify({ agent, prompts: [prompt] }));
  }
}

/** `mt kanban <command>`, as an agent's shell runs it: by name, from PATH, JSON on stdin. */
function mt(command, input) {
  const r = spawnSync('mt', ['kanban', command], {
    input: input === undefined ? '' : JSON.stringify(input),
    encoding: 'utf8',
    // Never longer than a turn should take: a socket nobody answers fails the turn.
    timeout: 30_000,
  });
  return { status: r.status, answer: r.stdout.trim(), error: r.error?.message ?? r.stderr.trim() };
}

function kanbanRun() {
  if (LOG !== undefined) {
    const keep = ['MT_KANBAN_RUN', 'MT_KANBAN_TOKEN', 'MT_KANBAN_SOCKET', 'PATH'];
    const env = Object.fromEntries(keep.map((k) => [k, process.env[k] ?? null]));
    writeFileSync(join(dirname(LOG), 'kanban-env.json'), JSON.stringify(env));
  }
  const shown = mt('show');
  let title = '?';
  try {
    title = JSON.parse(shown.answer).task.title;
  } catch {
    process.stderr.write(`mt kanban show failed: ${shown.error} ${shown.answer}\n`);
  }
  const done = mt('complete', { summary: `did: ${title}`, metadata: { by: 'cli-agent' } });
  delta(`show: ${shown.status}; complete: ${done.answer}`);
  summary('completed', `reported on ${title}`);
}

function emit(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`);
}

let firstId = process.env['FAKE_CLI_FIRST_ID'];

function event(type, extra = {}) {
  const session_id = firstId ?? SESSION;
  firstId = undefined;
  emit({ type, session_id, message_id: 'msg_1', agent_path: '/root', ...extra });
}

function delta(text) {
  event('text_delta', { part_id: 'prt_text', text });
}

function summary(finish, content) {
  emit({
    content,
    finish,
    timing_summary: { start_ms: 1, end_ms: 2, duration_ms: 1 },
    tokens: { cached: 0, input: 10, output: 2, reasoning: 0 },
    tool_calls: null,
    tool_results: null,
    turn: 1,
  });
}

switch (MODE) {
  case 'tool': {
    event('tool_running', { part_id: 'prt_tool', tool: 'Glob', status: 'running' });
    event('tool_completed', {
      part_id: 'prt_tool',
      tool: 'Glob',
      status: 'completed',
      output: 'a.txt\nb.txt',
    });
    delta('two files');
    summary('completed', 'two files');
    break;
  }

  case 'noise': {
    // Not JSON at all, and on stdout. A real one prints this before anything else.
    process.stdout.write(
      '[Stats] 2026-08-24 20:05:00.722 failed to init cgroup collector: no such file\n',
    );
    // The agent's own structured logger, on the same stream as the events.
    emit({ level: 'warn', component: 'memory-sync', message: 'startup memory sync failed' });
    // A telemetry envelope with no `type` and no `finish`.
    emit({ agent_step_budget: { total_steps: 0 }, tag: 'agent_step_budget', unix_ms: 1 });
    // A type from a later version than this driver.
    event('sentiment_delta', { mood: 'chipper' });
    event('token_stats', { tokens: { cached: 0, input: 10, output: 2, reasoning: 0 } });
    summary('completed', '');
    break;
  }

  case 'permission': {
    delta('about to do something');
    event('permission_request', { tool: 'Bash', action: 'rm -rf /tmp/scratch' });
    // Waits for an answer that cannot arrive. Being killed is the correct outcome.
    setInterval(() => {}, 1000);
    break;
  }

  case 'error': {
    // Colour codes and a line the driver must not mistake for the reason.
    process.stderr.write(
      '[1;31mError [model-retry] attempt failed attempt=5/5 retryable=true[0m\n',
    );
    process.stderr.write(
      '{"level":"info","component":"tce-shutdown","message":"engine cleanup completed"}\n',
    );
    summary('error', '');
    process.stderr.write('headless run terminated in error state: no such model "big-pickle"\n');
    process.exitCode = 1;
    break;
  }

  case 'crash': {
    delta('starting');
    process.stderr.write('fake agent is going down mid-turn\n');
    process.exit(7);
    break;
  }

  case 'hang': {
    delta('working');
    setInterval(() => {}, 1000);
    break;
  }

  case 'unstreamed': {
    // Streams nothing at all. The answer exists only in the summary, and a card
    // reading "finished with no output" next to it would be a gateway bug.
    summary('completed', 'the whole answer, unstreamed');
    break;
  }

  case 'kanban': {
    kanbanRun();
    break;
  }

  case 'kanban-gated': {
    const first = mt('complete', { summary: 'first try' });
    // The agent's cwd is the task's workspace.
    writeFileSync('gate-ok', '');
    const second = mt('complete', { summary: 'gate fixed' });
    delta(`first: ${first.answer}\nsecond: ${second.answer}`);
    summary('completed', 'reported twice');
    break;
  }

  case 'kanban-review': {
    const shown = mt('show');
    let title = '?';
    let reason;
    try {
      const brief = JSON.parse(shown.answer);
      title = brief.task.title;
      reason = brief.rework?.reason;
    } catch {
      process.stderr.write(`mt kanban show failed: ${shown.error} ${shown.answer}\n`);
    }
    const asked = mt('review', { summary: reason === undefined ? `drafted: ${title}` : `revised (${reason}): ${title}` });
    delta(`review: ${asked.answer}`);
    summary('completed', `asked for review of ${title}`);
    break;
  }

  case 'kanban-body': {
    const shown = mt('show');
    let task = { title: '?', body: '' };
    try {
      task = JSON.parse(shown.answer).task;
    } catch {
      process.stderr.write(`mt kanban show failed: ${shown.error} ${shown.answer}\n`);
    }
    const m = /^(start-workflow|apply-dag) (\{[\s\S]*\})$/.exec(task.body ?? '');
    if (m !== null) {
      const asked = mt(m[1], JSON.parse(m[2]));
      if (LOG !== undefined) appendFileSync(join(dirname(LOG), 'asked.log'), `${asked.answer}\n`);
    }
    const done = mt('complete', { summary: `did: ${task.title}` });
    delta(`complete: ${done.answer}`);
    summary('completed', `reported on ${task.title}`);
    break;
  }

  case 'kanban-late': {
    if (prompt.includes('reminder 1 of')) {
      kanbanRun();
    } else {
      delta('Next I will report.');
      summary('completed', 'Next I will report.');
    }
    break;
  }

  case 'cron': {
    // What the turn was given to find mt by: a chat turn's, or a fire's, by its fire id.
    if (LOG !== undefined) {
      appendFileSync(
        join(dirname(LOG), 'cron-env.log'),
        `${JSON.stringify({ fire: process.env['MT_CRON_FIRE'] ?? null, path: process.env['PATH'] ?? null, marker: process.env['MT_AGENT_SESSION'] ?? null })}\n`,
      );
    }
    const add = /^cron-add (\{[\s\S]*\})$/.exec(prompt.trim());
    if (add !== null) {
      const r = spawnSync('mt', ['cron', 'add'], { input: add[1], encoding: 'utf8', timeout: 30_000 });
      delta(`added: ${r.stdout.trim()}`);
      summary('completed', 'added');
      break;
    }
    const job = /The job's prompt: (.*)/.exec(prompt)?.[1] ?? '';
    if (job.includes('SLOW')) {
      delta('working');
      setInterval(() => {}, 1_000);
      break;
    }
    const answer = job.includes('QUIET') ? '[nothing to report]' : `Fired: ${job}`;
    delta(answer);
    summary('completed', answer);
    break;
  }

  case 'wake': {
    const beside = (name) => join(dirname(LOG ?? '.'), name);
    if (process.env['MT_KANBAN_RUN'] !== undefined) {
      const shown = mt('show');
      let task = { taskId: '?', title: '?', body: '' };
      try {
        task = JSON.parse(shown.answer).task;
      } catch {
        process.stderr.write(`mt kanban show failed: ${shown.error} ${shown.answer}\n`);
      }
      // A reaction task's run (wake spec §19.5): its body is the wake's prompt. It reads the task the
      // prompt says it may lift with wake-show, lifts it with wake-unblock, logs both, and completes.
      if ((task.body ?? '').startsWith("Board update: you are this task's run")) {
        const lift = /lift it with mt kanban wake-unblock, given \{"task_id": "(k_[0-9a-z]+)"/.exec(task.body);
        let shownSource = null;
        let unblocked = null;
        if (lift !== null) {
          shownSource = mt('wake-show', { task_id: lift[1] });
          unblocked = mt('wake-unblock', { task_id: lift[1], comment: 'Speaker two is confirmed.' });
        }
        appendFileSync(beside('reaction.log'), `${JSON.stringify({ body: task.body, shown: shownSource, unblocked })}\n`);
        const done = mt('complete', { summary: lift === null ? 'nothing to lift' : `lifted ${lift[1]}` });
        delta(`complete: ${done.answer}`);
        summary('completed', 'reacted');
        break;
      }
      // A task that says BLOCK blocks on its first run only: the next, after an unblock, completes.
      if (`${task.title} ${task.body ?? ''}`.includes('BLOCK') && !existsSync(beside(`blocked-${task.taskId}`))) {
        writeFileSync(beside(`blocked-${task.taskId}`), '');
        const blocked = mt('block', { kind: 'needs_input', reason: 'Which of the two speakers is confirmed?' });
        delta(`block: ${blocked.answer}`);
        summary('completed', 'blocked');
        break;
      }
      const done = mt('complete', { summary: `did: ${task.title}` });
      delta(`complete: ${done.answer}`);
      summary('completed', `reported on ${task.title}`);
      break;
    }
    const woken = prompt.startsWith('Board update');
    let unblocked = null;
    if (woken) {
      if (prompt.includes('SLOW')) {
        const until = Date.now() + 30_000;
        while (!existsSync(beside('release')) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      const lift = /lift it with mt kanban task unblock (k_[0-9a-z]+) /.exec(prompt);
      // A task whose title says KEEP is one the agent cannot answer: it replies, and lifts nothing.
      if (lift !== null && !prompt.includes('KEEP')) {
        const r = spawnSync('mt', ['kanban', 'task', 'unblock', lift[1], 'Speaker', 'two', 'is', 'confirmed.'], { encoding: 'utf8', timeout: 30_000 });
        unblocked = { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
      }
    }
    appendFileSync(beside('wake.log'), `${JSON.stringify({ prompt, token: process.env['MT_WAKE_TOKEN'] !== undefined, unblocked })}\n`);
    const answer = woken ? `Noted ${prompt.split('\n').length} lines.` : 'hello';
    delta(answer);
    summary('completed', answer);
    break;
  }

  case 'weird': {
    delta('half an answer');
    summary('interrupted_by_something_new', 'half an answer');
    break;
  }

  case 'staged': {
    // A board run that works a while, written at once so the gateway sees each
    // step as it comes: a tool running; once `release-1` is beside the log, the
    // tool done and a line of text; once `release-2` is, `mt kanban complete`.
    const beside = (name) => join(dirname(LOG ?? '.'), name);
    const now = (type, extra) => writeSync(1, `${JSON.stringify({ type, session_id: SESSION, message_id: 'msg_1', agent_path: '/root', ...extra })}\n`);
    const wait = (name) => {
      const until = Date.now() + 60_000;
      while (!existsSync(beside(name)) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    };
    now('tool_running', { part_id: 'prt_glob', tool: 'Glob', status: 'running' });
    wait('release-1');
    now('tool_completed', { part_id: 'prt_glob', tool: 'Glob', status: 'completed', output: 'a.txt\nb.txt' });
    now('text_delta', { part_id: 'prt_text', text: 'Found the two files.' });
    wait('release-2');
    const done = mt('complete', { summary: 'found the files' });
    now('text_delta', { part_id: 'prt_text', text: ` complete: ${done.answer}` });
    summary('completed', 'reported');
    break;
  }

  default: {
    delta('hello ');
    delta(`world (${prompt.split('\n').at(-1) ?? ''})`);
    event('token_stats', { tokens: { cached: 0, input: 10, output: 2, reasoning: 0 } });
    summary('completed', `hello world (${prompt.split('\n').at(-1) ?? ''})`);
    break;
  }
}
