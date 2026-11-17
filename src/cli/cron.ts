import { existsSync } from 'node:fs';
import { CHAT_ID, NEEDS_BOT, chatRefused } from '../core/lark-ids.js';
import type { CronDelivery, CronRefusal, FireRow, JobRow } from '../db/cron.js';
import { lastResult } from '../db/cron.js';
import { openDb, type Db } from '../db/open.js';
import { formatWall, isoWithOffset, processZone } from '../cron/schedule.js';
import { CronService, type EditRequest } from '../cron/service.js';
import { readGatewayZone } from '../cron/zone-file.js';
import { CRON_COMMANDS } from '../cron/worker.js';
import { DEFAULT_MAX_REQUEST_BYTES } from '../kanban/socket.js';
import { redactKnownSecrets } from '../secrets.js';
import { decodeUtf8 } from '../text.js';
import { parse, table, UsageError } from './args.js';
import { loadOperator, operatorName } from './gate.js';
import { ask, why } from './kanban.js';
import type { MtIo } from './mt.js';
import { jsonLine, nudgeGateway } from './operator.js';

/**
 * `mt cron` (the cron spec, §6.2 to §6.4): two grammars under one name, told
 * apart by the shell. The operator's commands, with arguments, write the
 * database beside the gateway through `CronService`, as `operator:<login>`,
 * and nudge it after a change; an agent's four, with JSON on stdin, ask the
 * gateway through its socket, with the authority of the shell's token.
 */

export const CRON_USAGE = [
  '  mt cron add "<schedule>" <role> "<prompt>" [--script \'<cmd>\'] [--chat <chat_id>] [--tz <zone>]',
  '      [--name <n>] [--workspace <name>] [--key <key>] [--json]',
  '  mt cron list [--json]',
  '  mt cron show <id> [--json]',
  '  mt cron edit <id> [--schedule "<s>"] [--role <r>] [--prompt "<p>"] [--script \'<cmd>\' | --no-script]',
  '      [--chat <chat_id> | --no-chat] [--tz <zone>] [--name <n>] [--workspace <name>] [--json]',
  '  mt cron pause|resume|run|remove <id> [--json]',
  "an agent's commands, which work only in an agent's shell, where the gateway sets MT_CRON_TOKEN (or a board run's MT_KANBAN_RUN and MT_KANBAN_TOKEN) and MT_KANBAN_SOCKET:",
  `  mt cron <${CRON_COMMANDS.join('|')}> < input.json`,
].join('\n');

/** The database's version, for a database not migrated to cron's tables yet. */
function version(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }));
}

interface Opened {
  service: CronService;
  db: Db;
  home: string;
  appId: string | undefined;
  /** `auth.chats` as this shell's settings give it: a `--chat` outside it, when it is not empty, is refused. */
  chats: readonly string[];
  enabled: boolean | undefined;
  /** Where the zone a job gets when none is given came from: the config's cron.tz, the gateway's record, or this shell. */
  zoneSource: 'cron.tz' | 'gateway' | 'shell';
}

/** The gateway's settings and team, its database with the cron tables, and a service over them; or why not, said. */
function open(io: MtIo, what: string, refuseAs: (code: string, message: string) => number): Opened | number {
  const loaded = loadOperator(io, what, { refuse: refuseAs, unsetNote: 'those values are not masked here' });
  if (typeof loaded === 'number') return loaded;
  const { settings, team } = loaded;
  if (!existsSync(settings.dbPath)) {
    return refuseAs('no_board', `there is no database at ${settings.dbPath}: the gateway creates it when it first starts`);
  }
  const db = openDb(settings.dbPath);
  const migrated = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_jobs'").get();
  if (migrated === undefined) {
    const v = version(db);
    db.close();
    return refuseAs('no_cron', `the database is at version ${v}; start the gateway of this build once to migrate it`);
  }
  const configured = settings.cron?.tz;
  const recorded = configured === undefined ? readGatewayZone(settings.home) : undefined;
  const zone = configured ?? recorded ?? processZone();
  const zoneSource = configured !== undefined ? 'cron.tz' : recorded !== undefined ? 'gateway' : 'shell';
  const service = new CronService({ db, roles: team.roles, workspaces: new Set(team.workspaces.keys()), zone });
  return { service, db, home: settings.home, appId: settings.appId, chats: settings.chats ?? [], enabled: settings.cron?.enabled, zoneSource };
}

function jobJson(job: JobRow): Record<string, unknown> {
  return {
    job_id: job.jobId,
    name: job.name,
    schedule: job.schedule,
    tz: job.tz,
    role: job.role,
    workspace: job.workspace,
    prompt: job.prompt,
    script: job.script === null ? null : redactKnownSecrets(job.script),
    delivery: job.delivery,
    state: job.state,
    next_run_at: job.nextRunAt === null ? null : isoWithOffset(job.tz, job.nextRunAt),
    failures: job.failures,
    created_by: job.createdBy,
  };
}

function fireJson(job: JobRow, f: FireRow): Record<string, unknown> {
  return {
    fire_id: f.fireId,
    scheduled_at: isoWithOffset(job.tz, f.scheduledAt),
    trigger: f.trigger,
    outcome: f.outcome,
    delivery: f.delivery,
    error: f.error,
    result: f.result,
  };
}

function when(job: JobRow, at: number | null): string {
  return at === null ? 'none' : formatWall(job.tz, at);
}

function describeJob(job: JobRow): string[] {
  const d = job.delivery;
  return [
    `${job.jobId} ${job.name}`,
    `  schedule: ${job.schedule} (${job.tz}), ${job.state}, next ${when(job, job.nextRunAt)}`,
    `  role: ${job.role}, workspace: ${job.workspace}, made by ${job.createdBy}`,
    `  posts to: ${d === null ? 'nowhere: its results are in its history only' : `${d.chat}${d.thread === '' ? '' : `, thread ${d.thread}`}`}`,
    ...(job.script === null ? [] : [`  script: ${redactKnownSecrets(job.script)}`]),
  ];
}

/** `mt cron <command> …`, the operator's. */
export async function cronOperator(command: string | undefined, rest: readonly string[], io: MtIo): Promise<number> {
  const json = rest.includes('--json');
  const no = (code: string, message: string): number => {
    if (json) io.out(jsonLine({ ok: false, code, message }));
    else io.err(`mt: ${redactKnownSecrets(message)}`);
    return 1;
  };
  const refusal = (r: CronRefusal): number => no(r.code, r.message);
  if (command === undefined || !['add', 'list', 'show', 'edit', 'pause', 'resume', 'run', 'remove'].includes(command)) {
    throw new UsageError(`cron takes add, list, show, edit, pause, resume, run or remove`);
  }
  const what = `mt cron ${command}`;
  const flags = {
    json: { type: 'boolean' },
    script: { type: 'string' },
    'no-script': { type: 'boolean' },
    chat: { type: 'string' },
    'no-chat': { type: 'boolean' },
    tz: { type: 'string' },
    name: { type: 'string' },
    workspace: { type: 'string' },
    key: { type: 'string' },
    schedule: { type: 'string' },
    role: { type: 'string' },
    prompt: { type: 'string' },
  } as const;
  const { values, positionals } = parse(rest, flags);
  const allowed: Record<string, readonly string[]> = {
    add: ['json', 'script', 'chat', 'tz', 'name', 'workspace', 'key'],
    list: ['json'],
    show: ['json'],
    edit: ['json', 'script', 'no-script', 'chat', 'no-chat', 'tz', 'name', 'workspace', 'schedule', 'role', 'prompt'],
  };
  for (const flag of Object.keys(values)) {
    if (!(allowed[command] ?? ['json']).includes(flag)) throw new UsageError(`cron ${command} takes no --${flag}`);
  }
  if (values.script !== undefined && values['no-script'] === true) throw new UsageError('--script and --no-script are one or the other');
  if (values.chat !== undefined && values['no-chat'] === true) throw new UsageError('--chat and --no-chat are one or the other');
  if (values.chat !== undefined && !CHAT_ID.test(values.chat)) throw new UsageError(`--chat takes a chat id as Lark gives one, oc_…, not ${JSON.stringify(values.chat)}`);
  const want = command === 'add' ? 3 : command === 'list' ? 0 : 1;
  if (positionals.length !== want) {
    if (command === 'add' && positionals.length === 0) {
      throw new UsageError("cron add takes a schedule, a role and a prompt; the JSON form, mt cron add < job.json, works only in an agent's shell");
    }
    throw new UsageError(command === 'add' ? 'cron add takes a schedule, a role and a prompt' : command === 'list' ? 'cron list takes no arguments' : `cron ${command} takes a job id`);
  }

  const o = open(io, what, no);
  if (typeof o === 'number') return o;
  try {
    // Before the add or the edit, so a repeated key naming a chat that has left auth.chats is refused too (§6.2).
    const delivery = (chat: string): CronDelivery | number => {
      if (o.appId === undefined) return no('invalid', NEEDS_BOT);
      const outside = chatRefused(chat, o.chats);
      return outside === undefined ? { channel: 'lark', account: o.appId, chat, thread: '', root: null } : no('invalid', outside);
    };
    let changed: JobRow | undefined;
    let lines: string[] = [];
    let out: Record<string, unknown> = {};
    switch (command) {
      case 'list': {
        const jobs = o.service.list();
        if (json) io.out(jsonLine({ ok: true, jobs: jobs.map(jobJson) }));
        else if (jobs.length === 0) io.out('no cron jobs: mt cron add makes one');
        else {
          const rows = jobs.map((j) => [j.jobId, j.name, j.schedule, j.tz, j.state, when(j, j.nextRunAt), j.delivery?.chat ?? 'nowhere']);
          for (const l of table([['id', 'name', 'schedule', 'zone', 'state', 'next', 'posts to'], ...rows])) io.out(redactKnownSecrets(l));
        }
        return 0;
      }
      case 'show': {
        const r = o.service.show(positionals[0] ?? '');
        if (!r.ok) return refusal(r);
        if (json) {
          io.out(jsonLine({ ok: true, job: jobJson(r.job), fires: r.fires.map((f) => fireJson(r.job, f)) }));
          return 0;
        }
        for (const l of describeJob(r.job)) io.out(redactKnownSecrets(l));
        io.out(`  prompt: ${redactKnownSecrets(r.job.prompt).replace(/\n/g, '\n    ')}`);
        io.out(r.fires.length === 0 ? '  no fires yet' : '  fires, newest first:');
        for (const f of r.fires) {
          io.out(`    ${f.fireId}  ${when(r.job, f.scheduledAt)}  ${f.trigger}  ${f.outcome ?? 'running'}  ${f.delivery}${f.error === null ? '' : `  ${redactKnownSecrets(f.error).split('\n')[0] ?? ''}`}`);
        }
        const result = lastResult(o.db, r.job.jobId);
        if (result !== undefined) io.out(`  last result: ${redactKnownSecrets(result.result ?? '')}`);
        return 0;
      }
      case 'add': {
        const [schedule = '', role = '', prompt = ''] = positionals;
        let d: CronDelivery | null = null;
        if (values.chat !== undefined) {
          const got = delivery(values.chat);
          if (typeof got === 'number') return got;
          d = got;
        }
        const r = o.service.add({
          schedule,
          role,
          prompt,
          ...(values.name === undefined ? {} : { name: values.name }),
          ...(values.tz === undefined ? {} : { tz: values.tz }),
          ...(values.script === undefined ? {} : { script: values.script }),
          ...(values.workspace === undefined ? {} : { workspace: values.workspace }),
          delivery: d,
          createdBy: operatorName(io),
          createdVia: { kind: 'operator' },
          ...(values.key === undefined ? {} : { idempotencyKey: `operator:${values.key}` }),
        });
        if (!r.ok) return refusal(r);
        if (values.tz === undefined && o.zoneSource === 'shell' && !json) {
          io.err(`mt: times in ${r.job.tz}, this shell's zone, as no gateway has recorded its own; --tz names another`);
        }
        changed = r.existing ? undefined : r.job;
        lines = [`${r.existing ? 'already added, as' : 'added'} ${r.job.jobId}: next ${when(r.job, r.job.nextRunAt)}`, ...describeJob(r.job)];
        // Where the zone came from, for a new job given no --tz: a retry's job took its zone at its first add.
        out = { job: jobJson(r.job), existing: r.existing, ...(values.tz === undefined && !r.existing ? { zone_source: o.zoneSource } : {}) };
        break;
      }
      case 'edit': {
        const req: EditRequest = {};
        if (values.schedule !== undefined) req.schedule = values.schedule;
        if (values.role !== undefined) req.role = values.role;
        if (values.prompt !== undefined) req.prompt = values.prompt;
        if (values.name !== undefined) req.name = values.name;
        if (values.tz !== undefined) req.tz = values.tz;
        if (values.workspace !== undefined) req.workspace = values.workspace;
        if (values.script !== undefined) req.script = values.script;
        if (values['no-script'] === true) req.script = null;
        if (values['no-chat'] === true) req.delivery = null;
        if (values.chat !== undefined) {
          const got = delivery(values.chat);
          if (typeof got === 'number') return got;
          req.delivery = got;
        }
        if (Object.keys(req).length === 0) throw new UsageError('cron edit takes at least one change');
        const r = o.service.edit(positionals[0] ?? '', req);
        if (!r.ok) return refusal(r);
        changed = r.job;
        lines = [`edited ${r.job.jobId}: next ${when(r.job, r.job.nextRunAt)}`, ...describeJob(r.job)];
        out = { job: jobJson(r.job) };
        break;
      }
      default: {
        const id = positionals[0] ?? '';
        const r =
          command === 'pause' ? o.service.pause(id) : command === 'resume' ? o.service.resume(id) : command === 'run' ? o.service.run(id) : o.service.remove(id);
        if (!r.ok) return refusal(r);
        changed = r.job;
        const said: Record<string, string> = {
          pause: `paused ${id}`,
          resume: `resumed ${id}: next ${when(r.job, r.job.nextRunAt)}`,
          run: `asked for a run of ${id}: the gateway fires it at once`,
          remove: `removed ${id}: the gateway stops a fire under way, and deletes the job`,
        };
        lines = [said[command] ?? ''];
        out = { job: jobJson(r.job) };
      }
    }
    let nudged: boolean | undefined;
    if (changed !== undefined) {
      if (o.enabled !== true) {
        nudged = false;
        io.err('mt: cron is off on this gateway (its config does not set cron.enabled to true): the change is recorded, and nothing fires until cron is turned on and the gateway restarted');
      } else {
        const n = await nudgeGateway(o.home);
        nudged = n.failed === undefined;
        if (n.failed !== undefined) io.err(`mt: no gateway answered at ${n.socket} (${n.failed}); the change stands, and a running gateway acts on it at its next tick`);
      }
    }
    if (json) io.out(jsonLine({ ok: true, ...out, ...(nudged === undefined ? {} : { nudged }) }));
    else for (const l of lines) io.out(redactKnownSecrets(l));
    return 0;
  } finally {
    o.db.close();
  }
}

/** `mt cron <add|list|pause|remove> < input.json`, an agent's, in its shell (§6.3). */
export async function cronAgent(command: string, rest: readonly string[], io: MtIo): Promise<number> {
  const say = (answer: Record<string, unknown>): void => io.out(JSON.stringify(answer));
  if (rest.length > 0) {
    say({ ok: false, code: 'bad_request', message: `mt cron ${command} takes no arguments here: its input is JSON on stdin` });
    return 2;
  }
  const socket = io.env['MT_KANBAN_SOCKET'];
  const cronToken = io.env['MT_CRON_TOKEN'];
  const run = io.env['MT_KANBAN_RUN'];
  const token = cronToken ?? io.env['MT_KANBAN_TOKEN'];
  if (socket === undefined || socket === '' || token === undefined || token === '') {
    say({ ok: false, code: 'not_in_a_run', message: "mt cron's JSON form needs MT_KANBAN_SOCKET and MT_CRON_TOKEN, or a board run's MT_KANBAN_RUN and MT_KANBAN_TOKEN" });
    return 1;
  }
  let input: unknown = {};
  if (command !== 'list' || io.stdinIsTTY !== true) {
    if (io.stdinIsTTY === true) {
      say({ ok: false, code: 'invalid', message: `mt cron ${command} reads JSON on stdin; stdin is a terminal: redirect a file or pipe it` });
      return 1;
    }
    const bytes = await (io.stdin?.(DEFAULT_MAX_REQUEST_BYTES) ?? Promise.resolve(new Uint8Array()));
    if (bytes === undefined) {
      say({ ok: false, code: 'too_large', message: `the input is over ${DEFAULT_MAX_REQUEST_BYTES} bytes` });
      return 1;
    }
    const text = decodeUtf8(bytes);
    if (text === undefined) {
      say({ ok: false, code: 'invalid', message: `mt cron ${command} reads one JSON object on stdin, in UTF-8, and this is not UTF-8` });
      return 1;
    }
    try {
      input = text.trim() === '' && command === 'list' ? {} : JSON.parse(text);
    } catch {
      say({ ok: false, code: 'invalid', message: `mt cron ${command} reads one JSON object on stdin, and this is not JSON` });
      return 1;
    }
  }
  const request = { cron: command, token, input, ...(cronToken === undefined && run !== undefined ? { run } : {}) };
  let line: string;
  try {
    line = await ask(socket, `${JSON.stringify(request)}\n`);
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
