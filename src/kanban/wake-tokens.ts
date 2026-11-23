import { chatAccess } from '../cron/tokens.js';
import { resolveBinding } from '../db/bindings.js';
import type { Db } from '../db/open.js';
import { openTurns } from '../db/turns.js';
import type { Role } from '../roles.js';
import { addSecrets, removeSecrets } from '../secrets.js';
import type { BindingKey } from '../types.js';
import type { WorkerAccess } from './dispatcher.js';
import { hashToken, mintToken, TOKEN_PATTERN } from './token.js';

/**
 * The wake tokens (wake spec §9.2): what lets a woken turn's shell ask the
 * gateway for `task show` and `task unblock` of the tasks that woke it.
 *
 * Held and checked as `CronTokens` holds a chat token (the cron spec, §7.1): one
 * for every Lark chat session at each actor build, whether cron is on or off,
 * 256 random bits kept in memory by their hash with the session and the binding
 * key they were minted for, in the masker while held, the predecessor expired at
 * the next build, at most `MAX_WAKE_TOKENS` held. A token works only while it is
 * the session's newest, the session is still bound at that key, and the session
 * has a turn open.
 *
 * **A token that once worked and no longer does is stale, not unknown**: the
 * hashes of the expired ones are kept, at most as many again beyond those held,
 * the oldest forgotten first, so `lookup` can answer `{stale}` and the shell, with
 * cron off, fall back to the operator's command. A restart forgets them all: a
 * process left from before it is answered nothing, `unauthorized`.
 *
 * Which tasks a woken turn may act on is the gateway's to say, from the token's
 * session and its running turn's wake (`wakeOfShell`), not the token's.
 */

/** Wake tokens held at most, and expired hashes kept at most beyond them. */
export const MAX_WAKE_TOKENS = 1_000;

interface Held {
  token: string;
  sessionId: string;
  key: BindingKey;
}

export type WakeLookup = { works: { sessionId: string; key: BindingKey } } | { stale: true };

export interface WakeTokensDeps {
  db: Db;
  /** How an agent reaches the socket, and the shim's directory first on its PATH, as `CronTokens`'. */
  worker?: WorkerAccess;
  /** The roles, for a session's role's own PATH. */
  roles?: ReadonlyMap<string, Role>;
  max?: number;
}

export class WakeTokens {
  readonly #db: Db;
  readonly #worker: WorkerAccess | undefined;
  readonly #roles: ReadonlyMap<string, Role>;
  readonly #max: number;
  /** By hash, in the order minted. */
  readonly #byHash = new Map<string, Held>();
  /** A session's newest token's hash. */
  readonly #newest = new Map<string, string>();
  /** The hashes of tokens expired, in the order they were. */
  readonly #expired = new Set<string>();

  constructor(deps: WakeTokensDeps) {
    this.#db = deps.db;
    this.#worker = deps.worker;
    this.#roles = deps.roles ?? new Map();
    this.#max = deps.max ?? MAX_WAKE_TOKENS;
  }

  /**
   * A chat session's environment, asked at each actor build: a new token, scoped
   * to the place the actor is built for, its predecessor expired. None for a
   * session bound anywhere but the Lark channel: a board run's is on `kanban`, a
   * fire's on `cron`.
   */
  envFor(sessionId: string, key: BindingKey): Readonly<Record<string, string>> | undefined {
    if (key.channel !== 'lark') return undefined;
    const previous = this.#newest.get(sessionId);
    if (previous !== undefined) this.#expire(previous);
    const token = mintToken();
    const hash = hashToken(token);
    addSecrets([token]);
    this.#byHash.set(hash, { token, sessionId, key });
    this.#newest.set(sessionId, hash);
    for (const oldest of this.#byHash.keys()) {
      if (this.#byHash.size <= this.#max) break;
      this.#expire(oldest);
    }
    return { ...chatAccess(this.#db, this.#worker, this.#roles, sessionId), MT_WAKE_TOKEN: token };
  }

  /** A held token no longer held: out of the masker, its hash kept as stale. */
  #expire(hash: string): void {
    const held = this.#byHash.get(hash);
    if (held === undefined) return;
    this.#byHash.delete(hash);
    removeSecrets([held.token]);
    if (this.#newest.get(held.sessionId) === hash) this.#newest.delete(held.sessionId);
    this.#expired.add(hash);
    for (const oldest of this.#expired) {
      if (this.#expired.size <= this.#max) break;
      this.#expired.delete(oldest);
    }
  }

  /**
   * What a token is now: `{works}` with its session and key while it is the
   * session's newest, the session is still bound at the key and has a turn open;
   * `{stale}` for one this process held that no longer works; nothing for a token
   * never held, or of another form.
   */
  lookup(token: string): WakeLookup | undefined {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const hash = hashToken(token);
    const held = this.#byHash.get(hash);
    if (held === undefined) return this.#expired.has(hash) ? { stale: true } : undefined;
    if (this.#newest.get(held.sessionId) !== hash) return { stale: true };
    if (resolveBinding(this.#db, held.key)?.sessionId !== held.sessionId) return { stale: true };
    if (openTurns(this.#db, held.sessionId).length === 0) return { stale: true };
    return { works: { sessionId: held.sessionId, key: held.key } };
  }
}
