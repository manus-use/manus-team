import type { Db } from '../db/open.js';
import { appendEvent } from '../db/events.js';
import { createSession, getSession, listSessionsByState, setState } from '../db/sessions.js';
import {
  bindSession,
  bindingsForSession,
  resolveBinding,
  revokeBindingsAt,
} from '../db/bindings.js';
import { endTurn, openTurns } from '../db/turns.js';
import { parkOverdue, pendingForSession } from '../db/approvals.js';
import type { Channel, SendTarget } from '../channel/types.js';
import type { Driver } from '../driver/types.js';
import type { BindingKey, Principal, SessionRow, SessionState } from '../types.js';
import { BOOT_ID, newSessionId } from './ids.js';
import { SessionActor } from './session-actor.js';
import type { WorkspaceProvider } from './workspace.js';
import { isReservedRoleName } from '../names.js';
import type { Clock } from '../time.js';
import { systemClock } from '../time.js';

/**
 * Owns the live session actors and the mapping from a place in a chat to a session.
 *
 * Three jobs that belong together because they share the same invariant -- at most
 * one actor per session, ever:
 *
 * 1. Hand out actors, creating them on demand.
 * 2. Resolve `(chat, thread)` to a session, creating and binding one when there is
 *    none.
 * 3. Reconcile at boot, before any channel is connected.
 *
 * Handing out actors from two places, or creating a session outside the binding
 * transaction, both produce the same symptom: two sessions on one thread, each with
 * half the conversation.
 */

/** Live actors before the least-recently-used idle one is retired. */
export const DEFAULT_MAX_LIVE = 8;

export type SessionStates = readonly SessionState[];

/** Sessions a boot must look at. Terminal states are done and stay done. */
const NON_TERMINAL: SessionStates = [
  'initializing',
  'live',
  'idle',
  'blocked',
  'cold',
  'quarantined',
  'unknown',
];

/** What a chat session runs as, and where (spec §2.4). */
export const DEFAULT_ROLE = 'default';
export const DEFAULT_WORKSPACE = 'default';

/**
 * A session's role, from `sessions.agent_id`. Rows written before roles existed
 * hold a driver id (`acp`, `structured-cli`) and mean the role default -- which is
 * why driver ids are reserved as role names.
 */
export function roleOfSession(agentId: string): string {
  return agentId === '' || isReservedRoleName(agentId) ? DEFAULT_ROLE : agentId;
}

/** A session's workspace name, from `sessions.workspace_id`; rows written before hold ''. */
export function workspaceOfSession(workspaceId: string): string {
  return workspaceId === '' ? DEFAULT_WORKSPACE : workspaceId;
}

export interface BootFinding {
  sessionId: string;
  /** What we did. Reported to the chat, so it must read as an explanation. */
  message: string;
  held: boolean;
  bindings: readonly BindingKey[];
}

export interface SessionRegistryDeps {
  db: Db;
  /** Role name → that role's driver. Must hold `default` (spec §2.4 item 1). */
  drivers: ReadonlyMap<string, Driver>;
  /**
   * A binding's channel id → the channel a session bound there posts through:
   * `lark` for chat, `kanban` for a run's sink (spec §2.4 item 4).
   */
  channels: ReadonlyMap<string, Channel>;
  /**
   * Extra environment for a session's agent, asked on every actor build (spec
   * §2.4 item 3). Plan C's dispatcher holds a run's environment in memory only.
   */
  envFor?: (sessionId: string) => Readonly<Record<string, string>> | undefined;
  workspaces: WorkspaceProvider;
  appId: string;
  clock?: Clock;
  maxLive?: number;
  note?: (line: string) => void;
}

/** How a session other than a chat's default is created. */
export interface NewSession {
  /** Default `default`. */
  role?: string;
  /** Default `default`. */
  workspace?: string;
  /**
   * Another session's observed provider session id, passed as a hint (spec §2.4
   * item 5). The driver resumes from it if it can and otherwise starts fresh;
   * whatever the agent then reports replaces it.
   */
  seedProviderSessionId?: string;
}

interface Entry {
  actor: SessionActor;
  lastUsed: number;
}

export class SessionRegistry {
  readonly #deps: SessionRegistryDeps;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  readonly #maxLive: number;
  readonly #actors = new Map<string, Entry>();

  constructor(deps: SessionRegistryDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    this.#note = deps.note ?? (() => undefined);
    this.#maxLive = deps.maxLive ?? DEFAULT_MAX_LIVE;
  }

  // -------------------------------------------------------------------------
  // Actors
  // -------------------------------------------------------------------------

  /**
   * The actor for a session, created if needed.
   *
   * Async because acquiring a workspace is, and because making capacity may mean
   * closing another actor. A synchronous version would have to fire that close and
   * forget it, which is how a card is left with a live typing indicator on a
   * session nothing is running.
   */
  async actorFor(sessionId: string, key: BindingKey): Promise<SessionActor> {
    const existing = this.#actors.get(sessionId);
    if (existing !== undefined) {
      existing.lastUsed = this.#clock.now();
      return existing.actor;
    }

    const session = getSession(this.#deps.db, sessionId);
    if (session === undefined) throw new Error(`no session ${sessionId}`);
    // The same order as create: role, workspace, channel. All before #makeRoom, so
    // a refusal never retires another session's actor.
    const role = roleOfSession(session.agentId);
    const driver = this.#deps.drivers.get(role);
    if (driver === undefined) {
      throw new Error(`session ${sessionId} runs as role ${role}, which is not configured`);
    }
    const workspaceId = workspaceOfSession(session.workspaceId);
    if (!this.#deps.workspaces.has(workspaceId)) {
      throw new Error(`session ${sessionId} works in workspace ${workspaceId}, which is not configured`);
    }
    const channel = this.#deps.channels.get(key.channel);
    if (channel === undefined) {
      throw new Error(`session ${sessionId} is bound on channel ${key.channel}, which this gateway does not run`);
    }

    await this.#makeRoom();

    const workspace = await this.#deps.workspaces.acquire(sessionId, workspaceId);
    const env = this.#deps.envFor?.(sessionId);
    const target: SendTarget = { chatId: key.conversationId, threadId: key.threadId };
    const actor = new SessionActor({
      db: this.#deps.db,
      sessionId,
      driver,
      channel,
      key,
      target,
      cwd: workspace.cwd,
      ...(env === undefined ? {} : { env }),
      clock: this.#clock,
      note: (line) => this.#note(`[${sessionId}] ${line}`),
    });

    this.#actors.set(sessionId, { actor, lastUsed: this.#clock.now() });
    return actor;
  }

  /** The actor only if one is already live. Never starts anything. */
  liveActor(sessionId: string): SessionActor | undefined {
    return this.#actors.get(sessionId)?.actor;
  }

  /**
   * The actor for a session identified by id rather than by location.
   *
   * Used by the card-callback path, which knows an `approvalId` and works backwards.
   * Returns undefined when nothing binds the session any more: a button on a
   * rotated-away session points at a place in the chat that no longer exists, and
   * inventing a binding to satisfy the click would resurrect it.
   *
   * Constructing an actor here does **not** start a runtime -- recording an answer
   * must not spawn an agent as a side effect of someone clicking a stale button.
   */
  async actorForBoundSession(sessionId: string): Promise<SessionActor | undefined> {
    const live = this.liveActor(sessionId);
    if (live !== undefined) return live;

    const [binding] = bindingsForSession(this.#deps.db, sessionId);
    if (binding === undefined) return undefined;
    return this.actorFor(sessionId, {
      channel: binding.channel,
      appId: binding.appId,
      conversationId: binding.conversationId,
      threadId: binding.threadId,
    });
  }

  /**
   * Retire the least-recently-used actor that is not doing anything.
   *
   * A busy actor is never retired, even when that leaves the registry over its cap.
   * The trade is deliberate and one-sided: being over the cap is a capacity problem
   * that shows up in a metric, whereas closing a session mid-turn destroys work the
   * user is waiting for.
   */
  async #makeRoom(): Promise<void> {
    if (this.#actors.size < this.#maxLive) return;

    const candidates = [...this.#actors.entries()]
      .filter(([, entry]) => !entry.actor.status().busy)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    const victim = candidates[0];
    if (victim === undefined) {
      this.#note(`over capacity (${this.#actors.size} live) with nothing idle to retire`);
      return;
    }

    const [sessionId, entry] = victim;
    this.#actors.delete(sessionId);
    this.#note(`retiring idle session ${sessionId} to make room`);
    // Goes cold, not terminated. The next message in that thread resumes it and
    // replays from the log; retiring is a memory decision, not a lifecycle one.
    await entry.actor.close();
    await this.#deps.workspaces.release(sessionId);
  }

  async release(sessionId: string): Promise<void> {
    const entry = this.#actors.get(sessionId);
    if (entry === undefined) return;
    this.#actors.delete(sessionId);
    await entry.actor.close();
    await this.#deps.workspaces.release(sessionId);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#actors.entries()];
    this.#actors.clear();
    // Sequential, not concurrent. Each close awaits a final card write, and firing
    // eight of those at one chat's rate limit means the last few fail.
    for (const [sessionId, entry] of entries) {
      try {
        await entry.actor.close();
        await this.#deps.workspaces.release(sessionId);
      } catch (err) {
        this.#note(`closing ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  get liveCount(): number {
    return this.#actors.size;
  }

  // -------------------------------------------------------------------------
  // Bindings
  // -------------------------------------------------------------------------

  /**
   * The session bound at this location, creating one if there is none.
   *
   * `resolveBinding` filters on `revoked_at IS NULL`, so a message redelivered
   * after a `/new` resolves to nothing here and gets the new session -- rather than
   * resurrecting the one that was rotated away.
   */
  bindOrCreate(key: BindingKey, owner: Principal): { session: SessionRow; created: boolean } {
    const now = this.#clock.now();
    const binding = resolveBinding(this.#deps.db, key);

    if (binding !== undefined) {
      const session = getSession(this.#deps.db, binding.sessionId);
      // A binding pointing at a session that is gone is a broken pointer, not a
      // reason to fail: revoke it and fall through to creating a fresh one.
      if (session !== undefined) return { session, created: false };
      revokeBindingsAt(this.#deps.db, key, now);
      this.#note(`binding at ${key.conversationId}/${key.threadId} pointed at a missing session`);
    }

    return {
      session: this.#create(key, owner, now, { role: DEFAULT_ROLE, workspace: DEFAULT_WORKSPACE, seed: undefined }),
      created: true,
    };
  }

  /**
   * Rotate: retire whatever is bound here and bind a fresh session. `/new`.
   *
   * Revoke rather than delete. The old session keeps its log and stays reachable by
   * id through `/attach`, which is what makes `/new` a safe thing to type -- if it
   * deleted, every accidental `/new` would be unrecoverable.
   */
  async rotate(key: BindingKey, owner: Principal): Promise<SessionRow> {
    const now = this.#clock.now();
    const previous = resolveBinding(this.#deps.db, key);
    if (previous !== undefined) {
      await this.release(previous.sessionId);
      setState(this.#deps.db, previous.sessionId, 'archived', now);
      appendEvent(
        this.#deps.db,
        previous.sessionId,
        {
          type: 'session_state_changed',
          actor: 'user',
          payload: { state: 'archived', reason: 'rotated by /new' },
        },
        now,
      );
    }
    revokeBindingsAt(this.#deps.db, key, now);
    return this.#create(key, owner, now, { role: DEFAULT_ROLE, workspace: DEFAULT_WORKSPACE, seed: undefined });
  }

  /**
   * Point this location at an existing session. `/attach`.
   *
   * Returns a reason string on refusal rather than throwing, because every refusal
   * here is something the user has to be told in the chat.
   */
  async attach(key: BindingKey, sessionId: string): Promise<{ ok: true; session: SessionRow } | { ok: false; reason: string }> {
    const session = getSession(this.#deps.db, sessionId);
    if (session === undefined) return { ok: false, reason: `No session ${sessionId}.` };
    if (session.state === 'terminated') {
      return { ok: false, reason: `Session ${sessionId} has ended.` };
    }

    const now = this.#clock.now();
    const previous = resolveBinding(this.#deps.db, key);
    if (previous !== undefined) {
      if (previous.sessionId === sessionId) return { ok: true, session };
      await this.release(previous.sessionId);
      revokeBindingsAt(this.#deps.db, key, now);
    }
    bindSession(this.#deps.db, key, sessionId, now);
    // Cursor starts at 0 for a newly bound location, so the next render replays the
    // session's history into this thread rather than resuming mid-sentence.
    return { ok: true, session };
  }

  /**
   * Create and bind a session as a role, in a workspace, optionally seeded.
   *
   * For sessions a chat does not create itself -- a run's, a rework's. Refuses a
   * role, workspace or channel that is not configured before anything is written,
   * so a refused create leaves no session and no binding behind.
   */
  create(key: BindingKey, owner: Principal, opts: NewSession = {}): SessionRow {
    const role = opts.role ?? DEFAULT_ROLE;
    const workspace = opts.workspace ?? DEFAULT_WORKSPACE;
    if (!this.#deps.drivers.has(role)) throw new Error(`role ${role} is not configured`);
    if (!this.#deps.workspaces.has(workspace)) throw new Error(`workspace ${workspace} is not configured`);
    if (!this.#deps.channels.has(key.channel)) throw new Error(`channel ${key.channel} is not run by this gateway`);
    // A second live binding at one place would make which session answers there
    // an accident of row order. Replacing a session is rotate's job.
    const bound = resolveBinding(this.#deps.db, key);
    if (bound !== undefined) {
      throw new Error(`${key.channel}:${key.conversationId}/${key.threadId} already has session ${bound.sessionId}`);
    }
    // An empty seed is no seed: createSession stores it as none, and the log must agree.
    const seed = opts.seedProviderSessionId === '' ? undefined : opts.seedProviderSessionId;
    return this.#create(key, owner, this.#clock.now(), { role, workspace, seed });
  }

  #create(
    key: BindingKey,
    owner: Principal,
    now: number,
    opts: { role: string; workspace: string; seed: string | undefined },
  ): SessionRow {
    const session = createSession(
      this.#deps.db,
      {
        id: newSessionId(),
        // The role, not the driver: the registry rebuilds this session's driver
        // from it (spec §2.4 item 1).
        agentId: opts.role,
        // The name, recorded now: the provider is asked again on every actor
        // build, so the session must remember where it works (spec §2.4 item 2).
        workspaceId: opts.workspace,
        ownerPrincipal: owner.unionId ?? owner.openId,
        ...(opts.seed === undefined ? {} : { providerSessionId: opts.seed }),
      },
      now,
    );
    appendEvent(
      this.#deps.db,
      session.id,
      {
        type: 'session_created',
        actor: 'user',
        payload: {
          channel: key.channel,
          conversationId: key.conversationId,
          threadId: key.threadId,
          owner: session.ownerPrincipal,
          role: opts.role,
          workspace: opts.workspace,
          seeded: opts.seed !== undefined,
        },
      },
      now,
    );
    bindSession(this.#deps.db, key, session.id, now);
    appendEvent(
      this.#deps.db,
      session.id,
      {
        type: 'binding_resolved',
        actor: 'gateway',
        payload: { channel: key.channel, conversationId: key.conversationId, threadId: key.threadId },
      },
      now,
    );
    return session;
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  /**
   * Reconcile persisted state against reality, before any channel connects.
   *
   * In this slice reality is simple and the simplification is worth naming: there
   * is no broker, so **no runtime survives the gateway**. Every handle from a
   * previous boot is dead by construction -- there is nothing to probe, nothing to
   * adopt, and no orphan to reap. When a broker arrives this becomes a real probe
   * and the `running` branch appears; the rest of the logic is unchanged.
   *
   * What still has to be decided is what happened to turns that were open. The
   * distinction that matters is already in the turn state:
   *
   * - `delivering` -- the prompt was handed over and nothing came back. We cannot
   *   tell whether the agent consumed it, so the session is **held**. This is the
   *   case quarantine exists for.
   * - `running` or `awaiting_approval` -- delivery is established, the outcome is
   *   not. That is `ambiguous` as a turn terminal, but not grounds to hold the
   *   session: the log shows what the agent did, and the next message can continue.
   *
   * Nothing here guesses. A turn is never marked completed on this path.
   */
  reconcileBoot(): BootFinding[] {
    const now = this.#clock.now();
    const findings: BootFinding[] = [];

    parkOverdue(this.#deps.db, now);

    for (const session of listSessionsByState(this.#deps.db, NON_TERMINAL)) {
      const open = openTurns(this.#deps.db, session.id);
      const handle = session.executionHandle;
      const fromThisBoot = handle !== null && handle.startsWith(`${BOOT_ID}:`);

      // Belongs to this process: nothing to reconcile, and touching it would fight
      // the live actor. Only reachable if reconcile is called late, which is a bug
      // -- but a harmless no-op beats corrupting a running session.
      if (fromThisBoot) continue;

      // A session an earlier boot already held stays held. Deriving this purely from
      // the turns found open would clear the hold on the *second* restart -- the
      // turns were closed by the first one -- and the next message would auto-resume
      // a session that is waiting on a human decision.
      let held = session.state === 'quarantined';
      const notes: string[] = [];

      for (const turn of open) {
        const ambiguousDelivery = turn.state === 'delivering' || turn.state === 'pending';
        endTurn(this.#deps.db, session.id, turn.turnId, 'ambiguous', now, turn.fence ?? undefined);
        appendEvent(
          this.#deps.db,
          session.id,
          {
            type: ambiguousDelivery ? 'turn_delivery_ambiguous' : 'turn_ended',
            actor: 'gateway',
            turnId: turn.turnId,
            generation: turn.generation,
            payload: {
              terminal: 'ambiguous',
              priorState: turn.state,
              reason: 'the gateway restarted while this turn was open',
            },
          },
          now,
        );
        if (ambiguousDelivery) held = true;
        notes.push(`turn ${turn.turnId} was ${turn.state}`);
      }

      const pending = pendingForSession(this.#deps.db, session.id);
      if (pending.length > 0) {
        // Left pending on purpose. Parking is a visibility change, not a decision,
        // and there is no timeout-to-default: denying silently kills multi-day work
        // and allowing is indefensible. The buttons no longer release an agent, and
        // the message below says so.
        notes.push(`${pending.length} approval(s) still unanswered`);
      }

      const nextState: SessionState = held ? 'quarantined' : 'cold';
      if (session.state !== nextState) {
        setState(this.#deps.db, session.id, nextState, now);
        appendEvent(
          this.#deps.db,
          session.id,
          {
            type: 'session_state_changed',
            actor: 'gateway',
            payload: {
              state: nextState,
              reason: held
                ? 'a prompt was in flight at restart and may or may not have been delivered'
                : 'the runtime did not survive the gateway restart',
            },
          },
          now,
        );
      }

      // Nothing was in flight and the state did not move, so there is nothing to
      // tell anyone. Without this every boot re-announces every session that ever
      // existed, and a chat full of restart notices is one nobody reads.
      if (open.length === 0 && pending.length === 0 && session.state === nextState) continue;

      // A session that was simply attached at restart has nothing to itemize. An
      // empty `()` reads as a bug in the message rather than as "nothing was in
      // flight", which is what it means.
      const detail = notes.length === 0 ? '' : ` (${notes.join('; ')})`;

      findings.push({
        sessionId: session.id,
        held,
        message: held
          ? `Session ${session.id} is held: ${notes.join('; ')}. The log shows what happened up to the restart. Inspect it, then /attach or /new.`
          : `Session ${session.id} was interrupted by a restart${detail}. Send a message to continue; history is replayed from the log.`,
        // Where to say it. A finding nobody is told about is the same as no
        // reconciliation at all: the user sees a session that simply stopped.
        bindings: bindingsForSession(this.#deps.db, session.id).map((b) => ({
          channel: b.channel,
          appId: b.appId,
          conversationId: b.conversationId,
          threadId: b.threadId,
        })),
      });
    }

    return findings;
  }

  /** Periodic housekeeping. Parking is a visibility change, never a decision. */
  park(): number {
    return parkOverdue(this.#deps.db, this.#clock.now());
  }
}
