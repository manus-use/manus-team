import { delimiter } from 'node:path';
import { resolveBinding } from '../db/bindings.js';
import type { Db } from '../db/open.js';
import { openTurns } from '../db/turns.js';
import type { WorkerAccess } from '../kanban/dispatcher.js';
import { hashToken, mintToken, TOKEN_PATTERN } from '../kanban/token.js';
import { addSecrets, removeSecrets } from '../secrets.js';
import type { BindingKey } from '../types.js';

/**
 * The cron tokens (the cron spec, §7): a chat session's, minted on each actor
 * build, and a fire's, minted for its session. Held in memory only, by their
 * hash, and in the masker while they work.
 *
 * **A chat turn's token works only while its session has a turn open** (§7.1):
 * an agent's environment is fixed when its runtime starts, so a session cannot
 * be given a token per turn. It is usable while the session has an open turn,
 * is still bound where the token was minted, and the token is its newest. The
 * router records each turn's sender's tier against the session, so an `add` is
 * judged by the turn that is running.
 */

/** Chat tokens held at most; the oldest is dropped first (§7.1). A fire's is not counted. */
export const MAX_TOKENS = 1_000;
/** Turns' tiers kept per session, as the actor's mailbox holds at most 32. */
export const TURNS_KEPT = 32;

export type Held =
  | { kind: 'chat'; token: string; sessionId: string; key: BindingKey }
  | { kind: 'fire'; token: string; fireId: number; jobId: string };

export interface CronTokensDeps {
  db: Db;
  /** How an agent reaches the socket, and the shim's directory first on its PATH (§7.1). */
  worker?: WorkerAccess;
  max?: number;
}

export class CronTokens {
  readonly #db: Db;
  readonly #worker: WorkerAccess | undefined;
  readonly #max: number;
  /** By hash, in the order minted. */
  readonly #byHash = new Map<string, Held>();
  /** The chat tokens among them. */
  #chats = 0;
  /** A chat session's newest token's hash. */
  readonly #newest = new Map<string, string>();
  /** A session's turns' tiers, by the turn's idempotency key: true for operate. */
  readonly #turns = new Map<string, Map<string, boolean>>();

  constructor(deps: CronTokensDeps) {
    this.#db = deps.db;
    this.#worker = deps.worker;
    this.#max = deps.max ?? MAX_TOKENS;
  }

  /**
   * Held, and the oldest chat tokens dropped past the cap. Only chat tokens are
   * counted: a fire's is bounded by max_running and dropped when its fire ends,
   * and chat churn must not evict one from under its running fire.
   */
  #hold(held: Held): void {
    const hash = hashToken(held.token);
    addSecrets([held.token]);
    this.#byHash.set(hash, held);
    if (held.kind === 'chat') this.#chats += 1;
    for (const [oldest, h] of this.#byHash) {
      if (this.#chats <= this.#max) break;
      if (h.kind === 'chat') this.#drop(oldest, h);
    }
  }

  #drop(hash: string, held: Held): void {
    if (!this.#byHash.delete(hash)) return;
    if (held.kind === 'chat') this.#chats -= 1;
    removeSecrets([held.token]);
    if (held.kind === 'chat' && this.#newest.get(held.sessionId) === hash) this.#newest.delete(held.sessionId);
  }

  /** The socket and PATH an agent's token goes with. */
  #access(path: string | undefined): Record<string, string> {
    const worker = this.#worker;
    if (worker === undefined) return {};
    const rest = path ?? worker.path;
    return { MT_KANBAN_SOCKET: worker.socket, PATH: rest === undefined || rest === '' ? worker.mtDir : `${worker.mtDir}${delimiter}${rest}` };
  }

  /**
   * A chat session's environment, asked on each actor build (§7.1): a new token,
   * scoped to the place the actor is built for, its predecessor expired. None
   * for a session bound anywhere but the Lark channel.
   */
  envFor(sessionId: string, key: BindingKey, path?: string): Readonly<Record<string, string>> | undefined {
    if (key.channel !== 'lark') return undefined;
    const previous = this.#newest.get(sessionId);
    if (previous !== undefined) {
      const held = this.#byHash.get(previous);
      if (held !== undefined) this.#drop(previous, held);
    }
    const token = mintToken();
    this.#hold({ kind: 'chat', token, sessionId, key });
    this.#newest.set(sessionId, hashToken(token));
    return { ...this.#access(path), MT_CRON_TOKEN: token };
  }

  /** A fire's token, held while the fire runs (§7.2). */
  mintFire(fireId: number, jobId: string): string {
    const token = mintToken();
    this.#hold({ kind: 'fire', token, fireId, jobId });
    return token;
  }

  /** The socket and PATH a fire's agent gets, beside its token. */
  fireAccess(path: string | undefined): Record<string, string> {
    return this.#access(path);
  }

  /** A token that stops working: a fire's that ended. */
  drop(token: string): void {
    const hash = hashToken(token);
    const held = this.#byHash.get(hash);
    if (held !== undefined) this.#drop(hash, held);
  }

  /** The router's word, before it submits a turn (§7.1): its key, and whether its sender has operate tier. */
  turnSubmitted(sessionId: string, idempotencyKey: string, operate: boolean): void {
    let turns = this.#turns.get(sessionId);
    if (turns === undefined) {
      turns = new Map();
      this.#turns.set(sessionId, turns);
    }
    turns.delete(idempotencyKey);
    turns.set(idempotencyKey, operate);
    for (const oldest of turns.keys()) {
      if (turns.size <= TURNS_KEPT) break;
      turns.delete(oldest);
    }
    // Bounded across sessions too, as the tokens are.
    for (const oldest of this.#turns.keys()) {
      if (this.#turns.size <= this.#max) break;
      this.#turns.delete(oldest);
    }
  }

  /**
   * The token's holder, if it works now (§7.1, §7.2): a fire's while it runs; a
   * chat session's while it is the session's newest, the session still bound
   * where it was minted, and a turn open.
   */
  lookup(token: string): Held | undefined {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const hash = hashToken(token);
    const held = this.#byHash.get(hash);
    if (held === undefined || held.kind === 'fire') return held;
    if (this.#newest.get(held.sessionId) !== hash) return undefined;
    if (resolveBinding(this.#db, held.key)?.sessionId !== held.sessionId) return undefined;
    if (openTurns(this.#db, held.sessionId).length === 0) return undefined;
    return held;
  }

  /**
   * Whether the session's running turn was asked by someone with operate tier
   * (§7.1): the one open turn past `pending`, as the actor runs one at a time.
   * A turn with none recorded is not.
   */
  runningTurnOperate(sessionId: string): boolean {
    const running = openTurns(this.#db, sessionId).find((t) => t.state !== 'pending');
    if (running === undefined) return false;
    return this.#turns.get(sessionId)?.get(running.idempotencyKey) === true;
  }
}
