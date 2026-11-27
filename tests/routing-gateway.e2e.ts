import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LarkAdapter } from '../src/channel/lark/adapter.js';
import type { Channel } from '../src/channel/types.js';
import { loadConfig, type GatewayConfig } from '../src/config.js';
import { commentsOf, membersOf, parentsOf, pendingOf, settledOf } from '../src/db/kanban-read.js';
import { createGateway, type Gateway } from '../src/index.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam } from '../src/team.js';
import { FakeChannel } from './helpers/channel.js';

/**
 * Workflow routing end to end (workflow routing spec §17): a vi-style instance
 * started from a fake chat, its steps run by the fake CLI agent through the real
 * socket. The intake's report without its packages is refused, and the next
 * taken; verify and registry are skipped and exposure fans out into three
 * tasks, in one notice; the items complete; va gives up, escalate is routed and
 * stands in, and va is archived with its comment; report joins the three items
 * and escalate, and is reviewed; patch is skipped; the instance ends done; and a
 * gateway restart in the middle decides nothing twice.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));

const FILE = `description: CVE or supply-chain assessment, routed by its intake
params:
  case: { required: true }
steps:
  intake:
    title: "{{case}} · intake"
    body: |
      REPORT {"summary": "triaged", "metadata": {"kind": "cve", "verify": false, "patch": false, "bnpm": false}}
      REPORT {"summary": "triaged", "metadata": {"kind": "cve", "verify": false, "patch": false, "bnpm": false, "packages": ["lodash", "minimist", "qs"]}}
    assignee: default
    outputs:
      kind: { enum: [cve, supplychain] }
      verify: boolean
      patch: boolean
      bnpm: boolean
      packages: { list: string, max: 100 }
  va:
    title: "{{case}} · va"
    body: CRASH
    assignee: default
    parents: [intake]
    failure_limit: 1
    when:
      - { step: intake, output: kind, equals: cve }
    on_gave_up: { route: escalate }
    outputs:
      reachable: boolean
  escalate:
    title: "{{case}} · va, escalated"
    body: 'REPORT {"summary": "asked upstream", "metadata": {"reachable": true}}'
    assignee: default
    handler: true
    stands_in_for: va
    outputs:
      reachable: boolean
  verify:
    title: "{{case}} · verify"
    assignee: default
    parents: [va]
    when:
      - { step: intake, output: verify, is: true }
      - { step: va, output: reachable, is: true }
  exposure:
    title: "{{case}} · exposure of {{item}}"
    assignee: default
    parents: [intake]
    for_each: { step: intake, output: packages }
  registry:
    title: "{{case}} · registry"
    assignee: default
    parents: [intake]
    when:
      - { step: intake, output: bnpm, is: true }
  report:
    title: "{{case}} · report"
    assignee: default
    reviewer: default
    parents: [va, verify, exposure, registry]
  patch:
    title: "{{case}} · patch"
    assignee: default
    parents: [report]
    when:
      - { step: intake, output: patch, is: true }
`;

let root: string;
let home: string;
let config: GatewayConfig;
let lark: FakeChannel;
let handlers: { message: (msg: unknown) => Promise<void> } | undefined;
let gateway: Gateway | undefined;
let lines: string[];
let seq = 0;

const CHANNEL_METHODS = ['sendText', 'openCard', 'sendApprovalCard', 'updateApprovalCard', 'sendCard', 'updateCard', 'react', 'unreact', 'chatMembers'] as const;
const OWNER = { openId: 'ou_owner', unionId: 'on_owner', name: 'Alice' };

beforeEach(() => {
  clearSecrets();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-routing-gw-')));
  home = join(root, 'home');
  mkdirSync(join(home, 'workflows'), { recursive: true });
  writeFileSync(join(home, 'workflows', 'vi-workflow.yaml'), FILE);
  mkdirSync(join(root, 'repo'));
  const env = {
    MT_HOME: home,
    MT_DB: join(home, 'team.db'),
    MT_WORKSPACE: join(root, 'repo'),
    MT_OWNER_OPEN_ID: OWNER.openId,
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret',
    MT_AGENT_COMMAND: process.execPath,
    MT_AGENT_ARGS: AGENT,
    MT_AGENT_DRIVER: 'structured-cli',
    MT_AGENT_UNSUPERVISED: 'true',
    MT_AGENT_ENV_FAKE_CLI_MODE: 'routing',
    MT_AGENT_ENV_FAKE_CLI_LOG: join(root, 'agent.log'),
  };
  writeFileSync(join(home, 'config.yaml'), 'kanban:\n  enabled: true\n');
  config = loadConfig(env);
  lark = new FakeChannel({ id: 'lark' });
  lines = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  vi.spyOn(LarkAdapter.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(LarkAdapter.prototype, 'disconnect').mockResolvedValue(undefined);
  vi.spyOn(LarkAdapter.prototype, 'botOpenId', 'get').mockReturnValue('ou_bot');
  vi.spyOn(LarkAdapter.prototype, 'raw', 'get').mockReturnValue({
    on: (h: typeof handlers) => {
      handlers = h;
      return () => {
        handlers = undefined;
      };
    },
  } as never);
  for (const method of CHANNEL_METHODS) {
    vi.spyOn(LarkAdapter.prototype as unknown as Channel, method).mockImplementation(((...args: unknown[]) =>
      (lark as unknown as Record<string, (...a: unknown[]) => unknown>)[method]?.apply(lark, args)) as never);
  }
});

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  vi.restoreAllMocks();
  clearSecrets();
  rmSync(root, { recursive: true, force: true });
});

async function start(): Promise<Gateway> {
  gateway = await createGateway(config, loadTeam(config, {}));
  await gateway.start();
  return gateway;
}

async function say(text: string): Promise<void> {
  if (handlers === undefined) throw new Error('the inbound side is not listening');
  await handlers.message({
    messageId: `om_routing_${++seq}`,
    chatId: 'oc_team',
    chatType: 'group',
    threadId: undefined,
    senderId: OWNER.openId,
    senderName: OWNER.name,
    content: text,
    mentionedBot: true,
    mentionAll: false,
    resources: [],
    createTime: Date.now(),
    raw: { sender: { sender_type: 'user', sender_id: { union_id: OWNER.unionId } }, message: { mentions: [{ key: '@_user_1', name: 'Bot', id: { open_id: 'ou_bot' } }] } },
  });
}

/** Wait for `ok`, polling, for up to about 90 s: a loaded machine starts the fake agent slowly. */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 3600; i += 1) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`gave up waiting for ${what}`);
}

const texts = (): string => lark.texts.map((m) => m.text).join('\n');

function instanceId(): string {
  const id = /`(w_[0-9a-z]+)`/.exec(texts())?.[1];
  if (id === undefined) throw new Error('no instance started');
  return id;
}

const db = () => {
  if (gateway === undefined) throw new Error('no gateway');
  return gateway.db;
};
const steps = (id: string, step: string) => membersOf(db(), id).filter((m) => m.step === step);
const phase = (taskId: string) => (db().prepare('SELECT phase FROM kanban_tasks WHERE task_id = ?').get(taskId) as { phase: string } | undefined)?.phase;
const members = (id: string) => membersOf(db(), id).length;

describe('workflow routing through createGateway', () => {
  it('routes a vi-style instance from its intake to its report, a restart in the middle deciding nothing twice', { timeout: 180_000 }, async () => {
    await start();
    await say('/kanban workflow start vi-workflow case=CVE-2026-12345');
    const id = instanceId();
    expect(texts()).toContain(`6 more steps are made as results come: \`/kanban workflow show ${id}\` follows them.`);

    await until('the exposure items', () => steps(id, 'exposure').length === 3);
    const log = (): Array<{ title: string; answer: string }> => {
      try {
        return readFileSync(join(root, 'routing.log'), 'utf8')
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => JSON.parse(l) as { title: string; answer: string });
      } catch {
        return [];
      }
    };
    // The agent writes its log once its report's answer is back, after the gateway made the items.
    await until("the intake's two reports", () => log().filter((l) => l.title === 'CVE-2026-12345 · intake').length === 2);
    const intake = log().filter((l) => l.title === 'CVE-2026-12345 · intake');
    expect(JSON.parse(intake[0]?.answer ?? '{}')).toEqual({ ok: false, code: 'invalid', message: 'output packages is missing' });
    expect(JSON.parse(intake[1]?.answer ?? '{}')).toMatchObject({ ok: true, phase: 'done' });
    await until('the intake notice', () => texts().includes('- ▶ exposure fanned out, 3 tasks: lodash, minimist, qs'));
    expect(texts()).toContain('- ⏭ verify skipped: intake.verify is false');
    expect(texts()).toContain('- ⏭ registry skipped: intake.bnpm is false');

    // A restart in the middle: nothing was due, so no reconciliation line, and nothing is made twice.
    const before = members(id);
    await gateway?.stop();
    lines.length = 0;
    await start();
    expect(lines.some((l) => l.includes('workflows: reconciled'))).toBe(false);
    expect(members(id)).toBe(before);

    await until('the instance to be done', () => {
      const row = db().prepare('SELECT 1 FROM kanban_workflow_settled WHERE instance_id = ? AND step = ? AND ref = ?').get(id, 'report', 'report');
      return row !== undefined && pendingOf(db(), id).every((p) => p.state !== 'waiting');
    });
    const va = steps(id, 'va')[0]?.taskId ?? '';
    const escalate = steps(id, 'escalate')[0]?.taskId ?? '';
    expect(phase(va)).toBe('archived');
    expect(commentsOf(db(), va).map((c) => c.body)).toContain(`Stood in for by escalate:1 (${escalate}), whose result is read in va's place.`);
    // The notifier sends on its own round, after the transaction that decided.
    await until('the stand-in notice', () => texts().includes(`- ✓ escalate stands in for va: reachable=true; \`${va}\` va archived`));
    const report = steps(id, 'report')[0]?.taskId ?? '';
    const items = steps(id, 'exposure').map((m) => m.taskId);
    // registry was skipped, so its effective parent, the intake, is linked in its place (workflow routing spec §3.2).
    const intakeTask = steps(id, 'intake')[0]?.taskId ?? '';
    expect(parentsOf(db(), report).map((p) => p.taskId).sort()).toEqual([...items, escalate, intakeTask].sort());
    expect(settledOf(db(), id).find((s) => s.step === 'report')).toMatchObject({ how: 'done', taskId: report });
    expect(pendingOf(db(), id).find((p) => p.step === 'patch')).toMatchObject({ state: 'skipped', reason: { by: 'when', why: 'intake.patch is false' } });
    expect(members(id)).toBe(7);
    await say(`/kanban workflow show ${id}`);
    expect(lark.texts.at(-1)?.text.split('\n')[0]).toBe(`**vi-workflow** \`${id}\`: done, 10 of 10 done`);
  });
});
