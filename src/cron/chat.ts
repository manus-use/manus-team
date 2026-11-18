import { forDisplay } from '../channel/escape.js';
import type { CronChat as CronChatScope, CronRefusal, FireRow, JobRow } from '../db/cron.js';
import { lastResult } from '../db/cron.js';
import type { Db } from '../db/open.js';
import { label, personText } from '../kanban/chat-render.js';
import type { PeopleDirectory } from '../kanban/people.js';
import { redactKnownSecrets } from '../secrets.js';
import type { BindingKey, InboundMessage, Principal, Tier } from '../types.js';
import { formatWall } from './schedule.js';
import type { CronService } from './service.js';

/**
 * `/cron` in chat (the cron spec, §6.1): add, list, show, pause, resume, run,
 * remove and help, through `CronService`, with the router's tiers. It touches no
 * session, so a busy one never refuses it. Every command but `add` and `help`
 * sees only the jobs delivering to this chat, any thread of it; there is no edit
 * and no workspace here, which are the terminal's.
 */

export interface CronChatDeps {
  db: Db;
  service: CronService;
  hasTier(principal: Principal, tier: Tier): boolean;
  /** After a change: a tick in process, so a run fires at once (§4.5). */
  changed?: () => void;
  /**
   * The people this bot has seen (kanban spec §9.3): each sender is noted, and
   * a job's maker is named by name in `show`. Absent, the maker is shown by principal.
   */
  people?: Pick<PeopleDirectory, 'saw' | 'chatName'>;
}

type Verb = 'add' | 'list' | 'show' | 'pause' | 'resume' | 'run' | 'remove' | 'help';

const TIERS: Readonly<Record<Verb, Tier>> = {
  add: 'operate',
  list: 'talk',
  show: 'talk',
  pause: 'operate',
  resume: 'operate',
  run: 'operate',
  remove: 'operate',
  help: 'talk',
};

/** The quotes a schedule may open with, and those each may close with: a typed `"` may arrive curly. */
const QUOTES: Readonly<Record<string, readonly string[]>> = { '"': ['"', '”'], '“': ['”', '"'], '”': ['”', '"'] };

const FIELDS = ['name', 'tz', 'script'] as const;
type Field = (typeof FIELDS)[number];

export interface AddCommand {
  schedule: string;
  role: string;
  prompt: string;
  fields: Partial<Record<Field, string>>;
}

const USAGE = 'Usage: `/cron add "<schedule>" <role> <prompt>`, then optional lines `name:`, `tz:` and `script:`. `/cron help` lists every command.';

/** Strip one pair of quotes around the whole. */
function unquote(text: string): string {
  const t = text.trim();
  const open = t[0];
  if (open !== undefined && QUOTES[open] !== undefined && t.length >= 2 && QUOTES[open].includes(t[t.length - 1] ?? '')) return t.slice(1, -1).trim();
  return t;
}

/**
 * `/cron add`'s words (§6.1): the schedule always quoted, the role the next
 * word, the prompt the rest, its first line and every following line that is
 * not a field line; each field once.
 */
export function parseAdd(rest: string): { ok: true; command: AddCommand } | { ok: false; reply: string } {
  const [first = '', ...more] = rest.split('\n');
  const line = first.trim();
  const open = line[0];
  const closes = open === undefined ? undefined : QUOTES[open];
  if (closes === undefined) return { ok: false, reply: `The schedule is quoted, as "every weekday 09:00". ${USAGE}` };
  let end = -1;
  for (let i = 1; i < line.length; i += 1) {
    if (closes.includes(line[i] ?? '')) {
      end = i;
      break;
    }
  }
  if (end === -1) return { ok: false, reply: `The schedule's quotes are not closed. ${USAGE}` };
  const schedule = line.slice(1, end).trim();
  const after = line.slice(end + 1).trim();
  const [role = '', ...words] = after.split(/\s+/);
  if (role === '') return { ok: false, reply: `A role follows the schedule. ${USAGE}` };
  const fields: Partial<Record<Field, string>> = {};
  const prompt: string[] = [words.join(' ')];
  for (const raw of more) {
    const m = /^\s*([A-Za-z][A-Za-z_-]*)\s*:\s?(.*)$/.exec(raw);
    const name = m?.[1]?.toLowerCase();
    if (m !== null && name !== undefined && (FIELDS as readonly string[]).includes(name)) {
      const f = name as Field;
      if (fields[f] !== undefined) return { ok: false, reply: `\`${f}:\` is given twice; give each field once.` };
      fields[f] = (m[2] ?? '').trim();
      continue;
    }
    if (m !== null && name === 'workspace') {
      return { ok: false, reply: "`workspace:` is not a field of `/cron add`: a job works in its role's workspace, and an operator names another with `mt cron edit --workspace`." };
    }
    prompt.push(raw);
  }
  return { ok: true, command: { schedule, role, prompt: unquote(prompt.join('\n')), fields } };
}

/** The board's own ids are code; anything else the sender typed is escaped. */
function id(jobId: string): string {
  return /^c_[0-9a-z]+$/.test(jobId) ? `\`${jobId}\`` : forDisplay(jobId);
}

function refused(r: CronRefusal): string {
  return `Not done: ${label(r.message, 600)}`;
}

function when(job: JobRow, at: number | null): string {
  return at === null ? 'none' : formatWall(job.tz, at);
}

const NO_UNION_ID =
  'Lark did not say who you are (no union_id came with the message), and a cron job records who changes it. Ask the operator to check the app can read user ids.';

export class CronChat {
  readonly #deps: CronChatDeps;

  constructor(deps: CronChatDeps) {
    this.#deps = deps;
  }

  #changed(): void {
    try {
      this.#deps.changed?.();
    } catch {
      // The change is made; the next tick acts on it.
    }
  }

  /** `/cron <arg>` from this message, bound at `key`: the reply, masked. */
  async run(arg: string, message: InboundMessage, key: BindingKey): Promise<string> {
    return redactKnownSecrets(this.#run(arg, message, key));
  }

  #run(arg: string, message: InboundMessage, key: BindingKey): string {
    // The verb ends at any white space, a newline too; the rest starts at what follows it.
    const head = /^\s*(\S*)\s*/.exec(arg)?.[0] ?? '';
    const verb = head.trim().toLowerCase();
    const rest = arg.slice(head.length);
    if (verb === '' || verb === 'help') return this.#help();
    if (verb === 'edit') return 'There is no `/cron edit`: a job is changed at the terminal, with `mt cron edit`, or removed and added again here.';
    if (!(verb in TIERS)) return `Unknown \`/cron\` command \`${forDisplay(verb)}\`. ${this.#help()}`;
    const v = verb as Verb;
    const by = message.sender.unionId === null || message.sender.unionId === '' ? undefined : `lark:${message.sender.unionId}`;
    // Noted, as `/kanban` and `/auth` note a sender, so the job's maker has a name to be shown by.
    this.#deps.people?.saw({ openId: message.sender.openId, unionId: message.sender.unionId, name: message.sender.displayName ?? null });
    if (TIERS[v] === 'operate') {
      if (!this.#deps.hasTier(message.sender, 'operate')) return `\`/cron ${v}\` changes a cron job, and needs operator permission.`;
      if (by === undefined) return NO_UNION_ID;
    }
    const scope: CronChatScope = { channel: key.channel, account: key.appId, chat: key.conversationId };
    // From the first line only: what follows on later lines is not part of the id.
    const jobId = (rest.split('\n')[0] ?? '').trim().split(/\s+/)[0] ?? '';
    switch (v) {
      case 'add':
        return this.#add(rest, message, key, by ?? '');
      case 'list':
        return this.#list(scope);
      case 'show': {
        const r = this.#deps.service.show(jobId, { chat: scope }, 10);
        return r.ok ? this.#show(r.job, r.fires) : refused(r);
      }
      case 'pause': {
        const r = this.#deps.service.pause(jobId, { chat: scope });
        if (!r.ok) return refused(r);
        this.#changed();
        return `Paused ${id(jobId)}. \`/cron resume ${jobId}\` starts it again.`;
      }
      case 'resume': {
        const r = this.#deps.service.resume(jobId, { chat: scope });
        if (!r.ok) return refused(r);
        this.#changed();
        return `Resumed ${id(jobId)}, next ${when(r.job, r.job.nextRunAt)}.`;
      }
      case 'run': {
        const r = this.#deps.service.run(jobId, { chat: scope });
        if (!r.ok) return refused(r);
        this.#changed();
        return `Running ${id(jobId)} now; its answer is posted here.`;
      }
      case 'remove': {
        const r = this.#deps.service.remove(jobId, { chat: scope });
        if (!r.ok) return refused(r);
        this.#changed();
        return `Removed ${id(jobId)}; a fire under way is stopped.`;
      }
      case 'help':
        return this.#help();
    }
  }

  #add(rest: string, message: InboundMessage, key: BindingKey, by: string): string {
    const parsed = parseAdd(rest);
    if (!parsed.ok) return parsed.reply;
    const { command } = parsed;
    const root = key.threadId === '' ? null : (message.rootId ?? null);
    const r = this.#deps.service.add({
      schedule: command.schedule,
      role: command.role,
      prompt: command.prompt,
      ...(command.fields.name === undefined ? {} : { name: command.fields.name }),
      ...(command.fields.tz === undefined ? {} : { tz: command.fields.tz }),
      ...(command.fields.script === undefined ? {} : { script: command.fields.script }),
      delivery: { channel: key.channel, account: key.appId, chat: key.conversationId, thread: key.threadId, root },
      createdBy: by,
      createdVia: { kind: 'chat', chatId: message.chatId, threadId: key.threadId, messageId: message.messageId },
      idempotencyKey: `lark:${message.messageId}`,
    });
    if (!r.ok) return refused(r);
    this.#changed();
    const j = r.job;
    const script = j.script === null ? '' : `\nScript: \`${forDisplay(redactKnownSecrets(j.script)).replace(/`/g, "'")}\``;
    return (
      `Added ${id(j.jobId)}, *${label(j.name, 100)}*: ${forDisplay(j.schedule)} (${forDisplay(j.tz)}), next ${when(j, j.nextRunAt)}, ` +
      `as ${forDisplay(j.role)}, posting here.${script}`
    );
  }

  #list(scope: CronChatScope): string {
    const jobs = this.#deps.service.list(scope);
    if (jobs.length === 0) return 'No cron jobs post here. `/cron add` makes one; `/cron help` lists the commands.';
    return jobs
      .map((j) => {
        const last = this.#deps.service.show(j.jobId, {}, 1);
        const outcome = last.ok ? (last.fires[0]?.outcome ?? 'none yet') : 'none yet';
        const next = j.state === 'active' ? `, next ${when(j, j.nextRunAt)}` : '';
        return `${id(j.jobId)} *${label(j.name, 100)}*: ${forDisplay(j.schedule)} (${forDisplay(j.tz)}), ${j.state}${next}, last ${outcome}`;
      })
      .join('\n');
  }

  #show(job: JobRow, fires: readonly FireRow[]): string {
    const lines = [
      `${id(job.jobId)} *${label(job.name, 100)}*: ${forDisplay(job.schedule)} (${forDisplay(job.tz)}), ${job.state}, next ${when(job, job.nextRunAt)}`,
      `role ${forDisplay(job.role)}, workspace ${forDisplay(job.workspace)}, made by ${personText(job.createdBy, (p) => this.#deps.people?.chatName(p))}, ${job.failures} failure(s) in a row`,
      `prompt: ${label(job.prompt, 600)}`,
      ...(job.script === null ? [] : [`script: ${label(job.script, 600)}`]),
    ];
    if (fires.length === 0) lines.push('No fires yet.');
    else {
      lines.push('Last fires:');
      for (const f of fires) {
        lines.push(`- ${when(job, f.scheduledAt)} ${f.trigger === 'run' ? '(run) ' : ''}${f.outcome ?? 'running'}${f.delivery === 'none' ? '' : `, ${f.delivery}`}`);
      }
    }
    const result = lastResult(this.#deps.db, job.jobId);
    if (result !== undefined) lines.push(`Last result, ${when(job, result.scheduledAt)}: ${label(result.result ?? '', 300)}`);
    return lines.join('\n');
  }

  #help(): string {
    return [
      '`/cron add "<schedule>" <role> <prompt>`, then optional lines `name:`, `tz:`, `script:` (operator)',
      '`/cron list`: the jobs posting in this chat (anyone allowed)',
      '`/cron show <id>`: a job, its last ten fires and its last result (anyone allowed)',
      '`/cron pause <id>`, `resume <id>`, `run <id>`, `remove <id>` (operator)',
      '`/cron help` (anyone allowed)',
      'A schedule is a cron expression (`0 9 * * 1-5`), `every 2h`, `every day 09:00`, `in 30m` or a time (`2026-11-17 09:00`). An answer of exactly `[nothing to report]` is not posted. Jobs are changed at the terminal, with `mt cron edit`.',
    ].join('\n');
  }
}
