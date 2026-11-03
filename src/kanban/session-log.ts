import type { Db } from '../db/open.js';
import { lastSeq, readEvents } from '../db/events.js';
import { redactKnownSecrets, withholdSecretPrefix } from '../secrets.js';
import type { Event } from '../types.js';

/**
 * What a run did, read from its session's event log (spec §8.1, §8.3): the log
 * is the system of record, so the board never keeps its own copy of an agent's
 * output or tool calls.
 */

/** One tool call, as the agent titled it, with its last status. */
export interface ToolCall {
  toolCallId: string;
  title: string;
  status: string;
}

/** The most of an agent's last output a run records as `last_output` (spec §3.3). */
export const LAST_OUTPUT_CHARS = 2000;

function eventsOf(db: Db, sessionId: string): Event[] {
  return readEvents(db, sessionId, 0, lastSeq(db, sessionId));
}

function text(payload: unknown, key: string): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Every tool call the session made, in the order each was first heard of, each
 * with its latest status.
 *
 * An update for a call not yet seen creates it, titled `tool`, which no role
 * lists as read-only: dropped, a write whose only record is an update would make
 * the run look read-only, the unsafe side of `if-no-side-effects`. Either kind
 * of event sets only the fields it carries; an empty title or status leaves the
 * known one as it was.
 */
export function toolCallsOf(db: Db, sessionId: string): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const event of eventsOf(db, sessionId)) {
    if (event.type !== 'tool_call' && event.type !== 'tool_call_update') continue;
    const id = text(event.payload, 'toolCallId');
    if (id === undefined) continue;
    let call = calls.get(id);
    if (call === undefined) {
      call = { toolCallId: id, title: 'tool', status: '' };
      calls.set(id, call);
    }
    const title = text(event.payload, 'title');
    if (title !== undefined && title !== '') call.title = title;
    const status = text(event.payload, 'status');
    if (status !== undefined && status !== '') call.status = status;
  }
  return [...calls.values()];
}

/**
 * Whether the calls changed anything (spec §2.1, §8.3): any call whose title is
 * not one of the role's readOnlyTools. An empty list means every call counts.
 */
export function hadSideEffects(calls: readonly ToolCall[], readOnlyTools: readonly string[]): boolean {
  return calls.some((call) => !readOnlyTools.includes(call.title));
}

/** The session's last turn, as the classifier and `last_output` need it. */
export interface LastTurn {
  /** The text of the turn's `agent_error` events, the agent's and the gateway's. */
  errors: string[];
  /**
   * The tail of what the agent said in the turn, masked (spec §10.1 layer 2): the
   * chunks are joined first, so a secret split between two is masked whole, and a
   * turn that ended part-way through one keeps none of it.
   */
  output: string;
}

export function lastTurnOf(db: Db, sessionId: string): LastTurn {
  const events = eventsOf(db, sessionId);
  const turnId = events.findLast((e) => e.type === 'turn_submitted')?.turnId ?? null;
  if (turnId === null) return { errors: [], output: '' };
  const errors: string[] = [];
  let said = '';
  for (const event of events) {
    if (event.turnId !== turnId) continue;
    if (event.type === 'agent_error') {
      const message = text(event.payload, 'message');
      if (message !== undefined) errors.push(message);
    } else if (event.type === 'agent_message_chunk') {
      said += text(event.payload, 'text') ?? '';
    }
  }
  // Masked before it is cut, so the cut cannot leave the end of a secret showing.
  return { errors, output: redactKnownSecrets(withholdSecretPrefix(said)).slice(-LAST_OUTPUT_CHARS) };
}
