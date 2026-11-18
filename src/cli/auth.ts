import { existsSync } from 'node:fs';
import { loadTeamSettings, type ListSources, type TeamSettings } from '../config.js';
import { processZone, formatWall } from '../cron/schedule.js';
import { readGatewayZone } from '../cron/zone-file.js';
import { activeGrants, grantTier, revokeGrant, talkGrantsMadeBy, type GrantRow } from '../db/grants.js';
import { openDb, type Db } from '../db/open.js';
import { peopleOf, personOf, type PersonRow } from '../db/people.js';
import { NO_MENTIONS } from '../kanban/task-checks.js';
import { sourcesOf, tiersFrom } from '../policy/auth.js';
import { decideGrant, decideRevoke, grantReply, revokeReply, tierEntries, type Held, type Target, type TierEntry, type Words } from '../policy/grants.js';
import { addSecrets, redactKnownSecrets } from '../secrets.js';
import type { Tier } from '../types.js';
import { parse, table, UsageError } from './args.js';
import { operatorName } from './gate.js';
import type { MtIo } from './mt.js';
import { jsonLine } from './operator.js';
import { line } from './plain.js';

/**
 * `mt auth grant|revoke|list` (the tier grants spec §6.2, §8.2): the
 * terminal's grants, as the owner's, recorded `operator:<login>` with no chat,
 * through the same writer and the same decisions as chat's `/auth`, in the
 * same words. The person is `lark:<union_id>`, one this bot has seen: a
 * union_id typed or pasted from elsewhere is the failure grants exist to end.
 *
 * The terminal judges by its own read of the configuration, the file and the
 * environment as this shell sees them, which may differ from the running
 * gateway's until it restarts. A grant made here is seen by the gateway at its
 * next check, with no nudge, and announced nowhere.
 *
 * Exit codes: 0 done, a no-op included; 1 refused; 2 the command line was
 * wrong. `--json` on all three, as on the other operator commands.
 */

export const AUTH_USAGE = [
  '  mt auth grant lark:<union_id> talk|operate [--json]',
  '  mt auth revoke lark:<union_id> [--json]',
  '  mt auth list [--json]',
].join('\n');

/** What a command did, or why not. */
type Outcome = { ok: true; lines: string[]; json: Record<string, unknown> } | { ok: false; code: string; message: string };

/** The database and what this shell's settings give, opened for one command. */
interface Opened {
  db: Db;
  appId: string;
  settings: TeamSettings;
  from: ListSources;
  zone: string;
}

const NO_OWNER = 'this shell finds no auth.owner or MT_OWNER_OPEN_ID, so it cannot tell what the configuration gives';

/** The person a command names, checked: a principal this bot has seen. */
function personNamed(text: string, db: Db, appId: string): PersonRow | Outcome {
  const shown = line(text, 80);
  if (text.startsWith('ou_')) {
    return { ok: false, code: 'open_id', message: `${shown} is an open_id, which is per app: a person is lark:<union_id>, which mt auth list and mt kanban people give` };
  }
  if (text.startsWith('@')) return { ok: false, code: 'invalid', message: NO_MENTIONS };
  const unionId = text.startsWith('lark:') ? text.slice('lark:'.length) : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(unionId)) {
    return { ok: false, code: 'invalid', message: `${shown} is not a person: a person is lark:<union_id>, which mt auth list and mt kanban people give` };
  }
  const person = personOf(db, appId, unionId);
  if (person === undefined) {
    return {
      ok: false,
      code: 'unknown_person',
      message: `${shown} is not someone this bot has seen: mt kanban people lists those it has, or grant them in chat with /auth grant @Name talk, which needs no id`,
    };
  }
  return person;
}

/** This shell's settings and the database they name, migrated to grants; or why not. */
function open(io: MtIo): Opened | Outcome {
  const settings = loadTeamSettings(io.env);
  const secret = io.env['LARK_APP_SECRET'];
  if (secret !== undefined && secret !== '') addSecrets([secret]);
  const appId = settings.appId;
  if (appId === undefined) return { ok: false, code: 'no_bot', message: 'there is no bot to grant for: this shell finds no lark.appId or LARK_APP_ID' };
  if (!existsSync(settings.dbPath)) {
    return { ok: false, code: 'not_migrated', message: `there is no database at ${settings.dbPath}: the gateway creates it when it first starts` };
  }
  const db = openDb(settings.dbPath);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tier_grants'").get() === undefined) {
    db.close();
    return { ok: false, code: 'not_migrated', message: `the database at ${settings.dbPath} has no tier grants yet: start the gateway once, so it is migrated` };
  }
  const configured = settings.cron?.tz;
  const zone = configured ?? readGatewayZone(settings.home) ?? processZone();
  const from = settings.from ?? { owner: 'auth.owner', talk: 'auth.talk', operate: 'auth.operate' };
  return { db, appId, settings, from, zone };
}

function held(g: GrantRow | undefined): Held | undefined {
  return g === undefined ? undefined : { tier: g.tier, by: g.grantedBy, at: g.grantedAt };
}

/** A person, as the terminal names them: their name and principal, or the principal alone. */
function whoOf(p: PersonRow): string {
  return p.name === null ? `lark:${line(p.unionId, 80)}` : `${line(p.name, 80)} (lark:${line(p.unionId, 80)})`;
}

/** The words a decision is said in at the terminal. */
function words(o: Opened, p: PersonRow, io: MtIo): Words {
  const nameOf = (principal: string): string => {
    const named = principal.startsWith('lark:') ? personOf(o.db, o.appId, principal.slice('lark:'.length))?.name : undefined;
    return line(named ?? principal, 80);
  };
  return {
    via: 'terminal',
    who: whoOf(p),
    principal: `lark:${p.unionId}`,
    by: operatorName(io),
    from: o.from,
    held: (g) => `${nameOf(g.by)} on ${formatWall(o.zone, g.at).slice(0, 10)}`,
  };
}

function targetOf(o: Opened, p: PersonRow, grant: GrantRow | undefined): Target {
  const s = o.settings;
  return { sources: sourcesOf({ ownerOpenId: s.owner ?? '', allowTalk: s.talk ?? [], allowOperate: s.operate ?? [] }, p.openId), grant: held(grant) };
}

/** The tier a person has with this target's sources and grant: what `--json` gives as `tier`. */
function tierNow(t: Target, grant: Tier | undefined): Tier | null {
  const now = tiersFrom(t.sources, grant);
  return now.operate ? 'operate' : now.talk ? 'talk' : null;
}

function grant(o: Opened, person: string, tier: Tier, io: MtIo): Outcome {
  if (o.settings.owner === undefined) return { ok: false, code: 'no_owner', message: NO_OWNER };
  const p = personNamed(person, o.db, o.appId);
  if (!('unionId' in p)) return p;
  let target = targetOf(o, p, undefined);
  const r = grantTier(
    o.db,
    { appId: o.appId, unionId: p.unionId, openId: p.openId, tier, by: operatorName(io), via: 'terminal', chat: null },
    (g) => {
      target = targetOf(o, p, g);
      return decideGrant('terminal', target, tier);
    },
    Date.now(),
  );
  const d = r.decision;
  const message = grantReply(d, target, words(o, p, io));
  if (d.outcome === 'refused') return { ok: false, code: d.code, message };
  return {
    ok: true,
    lines: [message],
    // The tier the person has afterwards: a talk grant to a person in auth.operate makes an operator.
    json: { outcome: d.outcome, tier: d.outcome === 'already' ? d.tier : tierNow(target, d.tier), principal: `lark:${p.unionId}` },
  };
}

function revoke(o: Opened, person: string, io: MtIo): Outcome {
  if (o.settings.owner === undefined) return { ok: false, code: 'no_owner', message: NO_OWNER };
  const p = personNamed(person, o.db, o.appId);
  if (!('unionId' in p)) return p;
  let target = targetOf(o, p, undefined);
  const r = revokeGrant(
    o.db,
    { appId: o.appId, unionId: p.unionId, by: operatorName(io), via: 'terminal', chat: null },
    (g) => {
      target = targetOf(o, p, g);
      return decideRevoke('terminal', target);
    },
    Date.now(),
  );
  const d = r.decision;
  const principal = `lark:${p.unionId}`;
  const made = d.outcome === 'revoked' && d.grant === 'operate' ? talkGrantsMadeBy(o.db, o.appId, principal) : 0;
  const message = revokeReply(d, target, words(o, p, io), made);
  if (d.outcome === 'refused') return { ok: false, code: d.code, message };
  const tier = d.outcome === 'revoked' ? d.left : tierNow(target, target.grant?.tier);
  return { ok: true, lines: [message], json: { outcome: d.outcome, tier, principal } };
}

/** Where a person's tier comes from, as `mt auth list` says it. */
function sourcesText(e: TierEntry, o: Opened): string {
  const out: string[] = [];
  if (e.sources.owner) out.push('owner');
  if (e.sources.talk) out.push(o.from.talk);
  if (e.sources.operate) out.push(o.from.operate);
  const g = e.grant;
  if (g !== undefined) {
    const where = g.grantedVia === 'chat' ? `in chat ${line(g.grantedChat ?? '', 80)}` : 'at the terminal';
    out.push(`${g.tier} grant by ${line(g.grantedBy, 80)} ${where}, ${formatWall(o.zone, g.grantedAt)}`);
  }
  return out.join('; ');
}

function list(o: Opened, io: MtIo, json: boolean): Outcome {
  const s = o.settings;
  if (s.owner === undefined && !json) io.err('mt: this shell finds no auth.owner or MT_OWNER_OPEN_ID, so only the grants are shown');
  const entries = tierEntries({ owner: s.owner ?? '', talk: s.owner === undefined ? [] : (s.talk ?? []), operate: s.owner === undefined ? [] : (s.operate ?? []) }, activeGrants(o.db, o.appId), peopleOf(o.db, o.appId)).filter(
    (e) => e.unionId !== null || e.openId !== '',
  );
  const rows = entries.map((e) => [
    e.name === null ? (e.unionId === null ? '(not seen)' : '(no name)') : line(e.name, 80),
    e.unionId === null ? line(e.openId ?? '', 80) : `lark:${line(e.unionId, 80)}`,
    e.tier ?? 'none',
    sourcesText(e, o),
  ]);
  return {
    ok: true,
    lines: rows.length === 0 ? ['nobody has a tier'] : table([['name', 'person', 'tier', 'from'], ...rows]),
    json: {
      people: entries.map((e) => ({
        principal: e.unionId === null ? null : `lark:${e.unionId}`,
        union_id: e.unionId,
        open_id: e.openId,
        name: e.name,
        tier: e.tier,
        owner: e.sources.owner,
        config: { talk: e.sources.talk, operate: e.sources.operate },
        grant:
          e.grant === undefined
            ? null
            : { tier: e.grant.tier, by: e.grant.grantedBy, via: e.grant.grantedVia, chat_id: e.grant.grantedChat, at: e.grant.grantedAt },
      })),
    },
  };
}

/** `mt auth <sub> …`, in an operator's shell, with the gateway's .env read. */
export function authCommand(argv: readonly string[], io: MtIo): number {
  const [sub, ...rest] = argv;
  const { values, positionals } = parse(rest, { json: { type: 'boolean' } });
  const json = values.json === true;
  let run: (o: Opened) => Outcome;
  if (sub === 'grant') {
    const [person, tier, extra] = positionals;
    const t = tier?.toLowerCase();
    if (person === undefined || (t !== 'talk' && t !== 'operate') || extra !== undefined) {
      throw new UsageError('auth grant takes a person, lark:<union_id>, and a tier, talk or operate');
    }
    run = (o) => grant(o, person, t, io);
  } else if (sub === 'revoke') {
    const [person, extra] = positionals;
    if (person === undefined || extra !== undefined) throw new UsageError('auth revoke takes a person, lark:<union_id>');
    run = (o) => revoke(o, person, io);
  } else if (sub === 'list') {
    if (positionals.length > 0) throw new UsageError('auth list takes no arguments');
    run = (o) => list(o, io, json);
  } else {
    throw new UsageError('auth takes grant, revoke or list');
  }
  const opened = open(io);
  let outcome: Outcome;
  if ('db' in opened) {
    try {
      outcome = run(opened);
    } catch (err) {
      outcome = { ok: false, code: 'failed', message: `the database failed: ${redactKnownSecrets(err instanceof Error ? err.message : String(err))}` };
    } finally {
      opened.db.close();
    }
  } else {
    outcome = opened;
  }
  if (!outcome.ok) {
    if (json) io.out(jsonLine({ ok: false, code: outcome.code, message: outcome.message }));
    else io.err(`mt: ${redactKnownSecrets(outcome.message)}`);
    return 1;
  }
  if (json) io.out(jsonLine({ ok: true, ...outcome.json }));
  else for (const l of outcome.lines) io.out(redactKnownSecrets(l));
  return 0;
}
