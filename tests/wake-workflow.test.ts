import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTask } from '../src/db/kanban-read.js';
import { parseKanban } from '../src/kanban/chat-parse.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { canonicalDag, checkDagShape } from '../src/kanban/dag.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService, type StartRequest, type WorkflowMade } from '../src/kanban/service.js';
import type { CreatedVia, Result } from '../src/kanban/types.js';
import { readWorkflow } from '../src/kanban/workflow.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { clearSecrets } from '../src/secrets.js';
import type { BindingKey, InboundMessage, Principal } from '../src/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, VIA, claimed } from './helpers/kanban.js';

/**
 * A workflow's wake (wake spec §3.1, §3.4): `wake: true` in a step and `"wake":
 * true` in a DAG task, checked; a start's wake for every member, or only the
 * steps that ask; a run's start inheriting its task's; chat's bare `wake` on
 * `workflow start`; and a start whose steps ask for one while wakes are off.
 */

const OPERATOR: CreatedVia = { kind: 'operator' };
const FOLLOW = { appId: 'cli_app', chatId: 'oc_team', threadId: '', rootId: null };
const WAKES_OFF =
  'wakes are off on this gateway: an operator turns them on with kanban.wake.enabled: true in config.yaml, and a restart';
const NOTE = 'wakes are off on this gateway (kanban.wake.enabled), so the steps that ask for one are notice-only';
const NO_CHAT = 'no chat follows this start (add --chat), so the steps that wake the chat session are notice-only';

const FLOW = `steps:
  draft:
    title: Draft the agenda
    assignee: implementer
  book:
    parents: [draft]
    title: Book the venue
    assignee: implementer
    wake: true
`;

let h: TestDb;
let dir: string;

beforeEach(() => {
  clearSecrets();
  h = testDb();
  dir = join(h.dir, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'flow.yaml'), FLOW);
});
afterEach(() => {
  clearSecrets();
  h.close();
});

function service(wake = { enabled: true, maxDepth: 5 }): KanbanService {
  return new KanbanService({ db: h.db, roles: new Map([['implementer', role('implementer')]]), workspaces: new Set(['default']), workflowsDir: dir, wake });
}

const FACTS = { roles: new Map([['implementer', role('implementer')]]), workspaces: new Set(['default']), supervisedRoles: false };

function made(r: Result<object>): WorkflowMade {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r as unknown as WorkflowMade;
}

function start(s: KanbanService, over: Partial<StartRequest> = {}): Result<WorkflowMade> {
  return s.startWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA, ...over });
}

function wakes(r: WorkflowMade): Array<[string, string | null]> {
  return r.tasks.map((t) => [t.ref, getTask(h.db, t.taskId)?.wakeBy ?? null]);
}

describe("a step's wake", () => {
  it('reads wake: true, and carries it into the DAG, absent where it is false', () => {
    const r = readWorkflow(dir, 'flow', FACTS);
    if (!r.ok) throw new Error(r.message);
    expect(r.workflow.steps.map((s) => [s.name, s.wake])).toEqual([
      ['draft', false],
      ['book', true],
    ]);
    const preview = service().previewWorkflow({ workflow: 'flow', params: { from: 'json', params: {} }, createdBy: 'operator:me', createdVia: OPERATOR });
    if (!preview.ok) throw new Error(preview.message);
    expect(preview.dag.tasks.map((t) => t.wake)).toEqual([undefined, true]);
    expect(canonicalDag(preview.dag)).toContain('"gates":[],"wake":true}');
    expect(canonicalDag(preview.dag)).not.toContain('"wake":false');
  });

  it('refuses a wake that is not true or false, naming its place', () => {
    writeFileSync(join(dir, 'flow.yaml'), FLOW.replace('wake: true', 'wake: maybe'));
    const r = readWorkflow(dir, 'flow', FACTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('steps.book.wake is true, false or { role: <name> }');
  });
});

describe("a DAG task's wake", () => {
  const dag = (wake: unknown) => ({
    format: 1,
    tasks: [{ ref: 'a', title: 'Book the venue', assignee: 'implementer', ...(wake === undefined ? {} : { wake }) }],
  });

  it('is true or false, false the same as none', () => {
    const on = checkDagShape(dag(true), 'terminal');
    const off = checkDagShape(dag(false), 'terminal');
    const none = checkDagShape(dag(undefined), 'terminal');
    if (!on.ok || !off.ok || !none.ok) throw new Error('refused');
    expect(on.dag.tasks[0]?.wake).toBe(true);
    expect(off.sha256).toBe(none.sha256);
    expect(on.sha256).not.toBe(none.sha256);
    expect(checkDagShape(dag('yes'), 'terminal')).toEqual({ ok: false, code: 'invalid', message: 'tasks[0] (a).wake is true, false or {"role": "<name>"}' });
  });

  it("makes an apply's members with wake on where they say so, as the apply's setter", () => {
    const s = service();
    const r = made(
      s.applyDag({
        dag: { format: 1, tasks: [{ ref: 'a', title: 'A', wake: true }, { ref: 'b', title: 'B' }] },
        createdBy: 'operator:me',
        createdVia: OPERATOR,
        follow: FOLLOW,
        wake: { by: ALICE, depth: 0, all: false },
      }),
    );
    expect(wakes(r)).toEqual([
      ['a', ALICE],
      ['b', null],
    ]);
  });
});

describe("a start's wake", () => {
  it('turns wake on for the steps that ask, as the setter, or for every member', () => {
    const steps = made(start(service(), { wake: { by: ALICE, depth: 0, all: false } }));
    expect(wakes(steps)).toEqual([
      ['draft', null],
      ['book', ALICE],
    ]);
    expect(steps.wakeNote).toBeUndefined();
    const all = made(start(service(), { wake: { by: ALICE, depth: 0, all: true }, idempotencyKey: 'again' }));
    expect(wakes(all)).toEqual([
      ['draft', ALICE],
      ['book', ALICE],
    ]);
  });

  it('turns none on with no setter', () => {
    expect(wakes(made(start(service())))).toEqual([
      ['draft', null],
      ['book', null],
    ]);
  });

  it('refuses a wake for every member while wakes are off, and starts a file whose steps ask for one with a note', () => {
    const off = service({ enabled: false, maxDepth: 5 });
    expect(start(off, { wake: { by: ALICE, depth: 0, all: true } })).toEqual({ ok: false, code: 'wake_off', message: WAKES_OFF });
    const r = made(start(off, { wake: { by: ALICE, depth: 0, all: false } }));
    expect(wakes(r)).toEqual([
      ['draft', null],
      ['book', null],
    ]);
    expect(r.wakeNote).toBe(NOTE);
  });

  it("refuses a terminal's wake for every member with no chat to follow them", () => {
    expect(start(service(), { createdVia: OPERATOR, createdBy: 'operator:me', wake: { by: ALICE, depth: 0, all: true } })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'a wake needs a chat that follows the task: add --chat',
    });
  });

  it("starts a terminal's file whose steps ask for the chat session's wake with no chat, those members notice-only, with the note", () => {
    const r = made(start(service(), { createdVia: OPERATOR, createdBy: 'operator:me', wake: { by: ALICE, depth: 0, all: false } }));
    expect(wakes(r)).toEqual([
      ['draft', null],
      ['book', null],
    ]);
    expect(r.wakeNote).toBe(NO_CHAT);
  });

  it("applies a terminal's DAG whose tasks ask for the chat session's wake with no chat, those members notice-only, with the note", () => {
    const r = made(
      service().applyDag({
        dag: { format: 1, tasks: [{ ref: 'a', title: 'A', wake: true }, { ref: 'b', title: 'B' }] },
        createdBy: 'operator:me',
        createdVia: OPERATOR,
        wake: { by: ALICE, depth: 0, all: false },
      }),
    );
    expect(wakes(r)).toEqual([
      ['a', null],
      ['b', null],
    ]);
    expect(r.wakeNote).toBe(NO_CHAT);
  });

  it("gives a run's start its task's wake, whatever the steps say", () => {
    const s = service();
    const parent = s.create({ title: 'Plan the offsite', assignee: 'implementer', createdBy: ALICE, createdVia: VIA, wake: { by: ALICE, depth: 1 } });
    if (!parent.ok) throw new Error(parent.message);
    const run = claimed(h.db, parent.task.taskId);
    const r = made(start(s, { createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } }));
    expect(r.tasks.map((t) => [t.ref, getTask(h.db, t.taskId)?.wakeBy, getTask(h.db, t.taskId)?.wakeDepth])).toEqual([
      ['draft', ALICE, 1],
      ['book', ALICE, 1],
    ]);
  });
});

describe("chat's bare wake on workflow start", () => {
  it('reads a trailing wake as the start\'s, and a key named wake as a param', () => {
    expect(parseKanban('workflow start flow wake')).toEqual({ ok: true, command: { verb: 'workflow start', name: 'flow', pairs: [], wake: true } });
    expect(parseKanban('workflow start flow topic=x WAKE')).toEqual({
      ok: true,
      command: { verb: 'workflow start', name: 'flow', pairs: [{ key: 'topic', value: 'x', quoted: false }], wake: true },
    });
    expect(parseKanban('workflow start flow wake=x')).toEqual({
      ok: true,
      command: { verb: 'workflow start', name: 'flow', pairs: [{ key: 'wake', value: 'x', quoted: false }] },
    });
    expect(parseKanban('workflow start flow topic="a wake"')).toEqual({
      ok: true,
      command: { verb: 'workflow start', name: 'flow', pairs: [{ key: 'topic', value: 'a wake', quoted: true }] },
    });
  });

  const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Zhixi Sun' };
  const KEY: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };
  let seq = 0;
  async function say(s: KanbanService, arg: string): Promise<string> {
    const authorizer = new Authorizer(defaultAuthConfig(OWNER.openId));
    const people = new PeopleDirectory({ db: h.db, appId: 'cli_app', canTalk: () => true });
    const chat = new KanbanChat({ service: s, hasTier: (p, tier) => authorizer.hasTier(p, tier), people, appId: 'cli_app' });
    const message: InboundMessage = {
      messageId: `om_${++seq}`,
      appId: 'cli_app',
      chatId: 'oc_team',
      chatType: 'group',
      threadId: 'omt_topic',
      rootId: 'om_root',
      sender: OWNER,
      senderIsBot: false,
      text: '',
      mentionedBot: true,
      mentionAll: false,
      mentions: [],
      attachments: [],
      createTime: 0,
    };
    return (await chat.run(arg, message, KEY)).text;
  }

  function memberWakes(): Array<string | null> {
    return h.db
      .prepare<[], { wake_by: string | null }>('SELECT wake_by FROM kanban_tasks ORDER BY created_at, rowid')
      .all()
      .map((r) => r.wake_by);
  }

  it('turns wake on for every member with wake, and for the asking steps without it, as the sender', async () => {
    await say(service(), 'workflow start flow wake');
    expect(memberWakes()).toEqual(['lark:on_owner', 'lark:on_owner']);
  });

  it("turns it on for the steps that ask, without the word", async () => {
    await say(service(), 'workflow start flow');
    expect(memberWakes()).toEqual([null, 'lark:on_owner']);
  });

  it('refuses wake while wakes are off, and ends a start whose steps ask with the note', async () => {
    const off = service({ enabled: false, maxDepth: 5 });
    expect(await say(off, 'workflow start flow wake')).toBe(`Not done: ${WAKES_OFF}`);
    expect(memberWakes()).toEqual([]);
    expect(await say(off, 'workflow start flow')).toMatch(new RegExp(`\\n\\n${NOTE.replace(/[().]/g, '\\$&')}$`));
    expect(memberWakes()).toEqual([null, null]);
  });
});
