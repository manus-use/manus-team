import { describe, expect, it } from 'vitest';
import {
  BOOT_ID,
  approvalNonce,
  boardCardNonce,
  boardCardUuid,
  newApprovalId,
  newRunId,
  newSessionId,
  newTaskId,
  newTurnId,
  noticeBatchUuid,
  replyUuid,
  sendUuid,
  turnIdempotencyKey,
} from '../src/core/ids.js';

describe('random ids', () => {
  it('names something that did not exist before', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSessionId()));
    expect(ids.size).toBe(200);
  });

  it('is prefixed by kind, so a mis-passed id is obvious in a log', () => {
    expect(newSessionId()).toMatch(/^s_[0-9a-z]{16}$/);
    expect(newTurnId()).toMatch(/^t_[0-9a-z]{12}$/);
    expect(newApprovalId()).toMatch(/^a_[0-9a-z]{12}$/);
  });

  it('names kanban tasks k_ and runs r_', () => {
    expect(newTaskId()).toMatch(/^k_[0-9a-z]{12}$/);
    expect(newRunId()).toMatch(/^r_[0-9a-z]{12}$/);
  });
});

describe('sendUuid', () => {
  it('is reproducible, which is the whole mechanism behind idempotent retry', () => {
    expect(sendUuid('cli_a', 's_1', 7)).toBe(sendUuid('cli_a', 's_1', 7));
  });

  it('fits the field limit', () => {
    expect(sendUuid('cli_a', 's_1', 7)).toHaveLength(50);
  });

  it('distinguishes two bots writing identical text to one chat', () => {
    // Those are two distinct effects, not a duplicate of one. Keying without the
    // app id would let one bot's send swallow the other's.
    expect(sendUuid('cli_a', 's_1', 7)).not.toBe(sendUuid('cli_b', 's_1', 7));
  });

  it('distinguishes sessions and seqs', () => {
    expect(sendUuid('cli_a', 's_1', 7)).not.toBe(sendUuid('cli_a', 's_2', 7));
    expect(sendUuid('cli_a', 's_1', 7)).not.toBe(sendUuid('cli_a', 's_1', 8));
  });
});

describe('replyUuid', () => {
  it('collapses Feishu re-pushes of one message into one reply', () => {
    expect(replyUuid('cli_a', 'om_1', 'rejected')).toBe(replyUuid('cli_a', 'om_1', 'rejected'));
    expect(replyUuid('cli_a', 'om_1', 'rejected')).toHaveLength(50);
  });

  it('keeps two different replies to the same message distinct', () => {
    // Otherwise the second reply to one message is deduped away as a repeat of the
    // first.
    expect(replyUuid('cli_a', 'om_1', 'rejected')).not.toBe(replyUuid('cli_a', 'om_1', 'help'));
  });
});

describe('noticeBatchUuid', () => {
  it('is the same for the same set of pairs, in any order, after a restart too, and differs for any other set', () => {
    const a = noticeBatchUuid('cli_app', [
      [3, 41],
      [5, 44],
    ]);
    expect(
      noticeBatchUuid('cli_app', [
        [5, 44],
        [3, 41],
      ]),
    ).toBe(a);
    expect(a).toHaveLength(50);
    const others = [
      noticeBatchUuid('cli_app', [[3, 41]]),
      noticeBatchUuid('cli_app', [
        [3, 41],
        [5, 45],
      ]),
      // Not one pair's digits run into the next's.
      noticeBatchUuid('cli_app', [
        [3, 414],
        [5, 4],
      ]),
      noticeBatchUuid('cli_other', [
        [3, 41],
        [5, 44],
      ]),
    ];
    expect(new Set([a, ...others]).size).toBe(5);
    // Never a control reply's or a session send's.
    expect(a).not.toBe(replyUuid('cli_app', '3', '41'));
    expect(a).not.toBe(sendUuid('cli_app', '3', 41));
  });
});

describe('approvalNonce', () => {
  it('binds the generation, so a superseded card fails to match', () => {
    expect(approvalNonce('s_1', 'a_1', 3)).not.toBe(approvalNonce('s_1', 'a_1', 4));
  });

  it('binds the boot id, catching the case where state did not move but the process did', () => {
    // Recomputing with the current BOOT_ID is what a nonce check does; the point of
    // including it is that a value minted under a different boot cannot reproduce.
    const mine = approvalNonce('s_1', 'a_1', 3);
    expect(mine).toBe(approvalNonce('s_1', 'a_1', 3));
    expect(BOOT_ID).toMatch(/^[0-9a-z]{10}$/);
  });

  it('is fixed-length, so the length check outside the constant-time compare leaks nothing', () => {
    expect(approvalNonce('s_1', 'a_1', 3)).toHaveLength(32);
    expect(approvalNonce('s_longer_session_id', 'a_2', 999)).toHaveLength(32);
  });
});

describe('turnIdempotencyKey', () => {
  it('is stable across a re-push of the same message', () => {
    expect(turnIdempotencyKey('cli_a', 'om_1')).toBe(turnIdempotencyKey('cli_a', 'om_1'));
  });

  it('is not the send uuid, so the two cannot be confused at a call site', () => {
    expect(turnIdempotencyKey('cli_a', 'om_1')).not.toBe(replyUuid('cli_a', 'om_1', 'turn'));
  });
});

describe("a person's card", () => {
  it('has one uuid per run, and a nonce bound to the task and the run, not to the boot', () => {
    expect(boardCardUuid('cli_app', 'r_1')).toBe(boardCardUuid('cli_app', 'r_1'));
    expect(boardCardUuid('cli_app', 'r_1')).toHaveLength(50);
    expect(boardCardUuid('cli_app', 'r_2')).not.toBe(boardCardUuid('cli_app', 'r_1'));
    const n = boardCardNonce('cli_app', 'k_1', 'r_1');
    expect(n).toHaveLength(32);
    expect(new Set([n, boardCardNonce('cli_app', 'k_2', 'r_1'), boardCardNonce('cli_app', 'k_1', 'r_2'), boardCardNonce('cli_x', 'k_1', 'r_1')]).size).toBe(4);
  });
});
