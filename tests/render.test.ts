import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CARD_TEXT_BUDGET,
  RETRY_AFTER_TOOLS_HINT,
  RETRY_HINT,
  renderCard,
} from '../src/channel/render.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { Event, EventType } from '../src/types.js';

let seq = 0;
function ev(type: EventType, payload: unknown): Event {
  seq += 1;
  return {
    sessionId: 's_test',
    seq,
    ts: 1_760_000_000_000 + seq,
    generation: 0,
    brokerSeq: null,
    turnId: 't_1',
    type,
    actor: 'agent',
    payload,
  };
}

describe('renderCard: what to do after a failure', () => {
  // "Turn failed." with nothing after it leaves the user guessing. Most failures
  // the driver marks retryable are a provider blip, and the fix is to send the
  // message again -- which nothing on the card used to say.
  const failedWith = (...extra: Event[]): ReturnType<typeof renderCard> =>
    renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ...extra,
      ev('agent_error', { message: 'responses API stream error 400', retryable: true }),
      ev('turn_ended', { terminal: 'failed' }),
    ]);

  it('says to send it again when a failure is retryable', () => {
    expect(failedWith().text).toContain(RETRY_HINT);
  });

  it('warns that steps already ran when the turn got as far as tools', () => {
    const view = failedWith(
      ev('tool_call', { toolCallId: 'c1', title: 'Edit main.ts', status: 'completed' }),
    );
    expect(view.text).toContain(RETRY_AFTER_TOOLS_HINT);
    expect(view.text).not.toContain(RETRY_HINT);
  });

  it('gives no hint while the turn is still open', () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_error', { message: 'transient', retryable: true }),
    ]);
    expect(view.text).not.toContain(RETRY_HINT);
  });

  it('gives no hint for an error that is not retryable', () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_error', { message: 'bad config', retryable: false }),
      ev('turn_ended', { terminal: 'failed' }),
    ]);
    expect(view.text).not.toContain(RETRY_HINT);
    expect(view.text).not.toContain(RETRY_AFTER_TOOLS_HINT);
  });

  it('gives no hint for an ambiguous turn, which may already have acted', () => {
    // Ambiguous is the terminal where resending can run the instruction twice.
    // Inviting a casual retry there is the opposite of what the session hold is for.
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_error', { message: 'process exited', retryable: true }),
      ev('turn_ended', { terminal: 'ambiguous' }),
    ]);
    expect(view.text).not.toContain(RETRY_HINT);
    expect(view.text).not.toContain(RETRY_AFTER_TOOLS_HINT);
  });

  it("does not carry a previous turn's retryable error into a later failure", () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'one' }),
      ev('agent_error', { message: 'blip', retryable: true }),
      ev('turn_ended', { terminal: 'failed' }),
      ev('turn_submitted', { text: 'two' }),
      ev('agent_error', { message: 'bad config', retryable: false }),
      ev('turn_ended', { terminal: 'failed' }),
    ]);
    expect(view.text).not.toContain(RETRY_HINT);
  });
});

describe('renderCard', () => {
  it("carries the message the current turn's card should quote", () => {
    // Taken from the log, not from the inbound message, so a card re-rendered
    // after a restart still quotes the question it answers.
    const view = renderCard([
      ev('turn_submitted', { text: 'first', replyTo: 'om_first' }),
      ev('turn_ended', { terminal: 'completed' }),
      ev('turn_submitted', { text: 'second', replyTo: 'om_second' }),
    ]);
    expect(view.replyTo).toBe('om_second');
  });

  it('quotes nothing when the turn did not ask to', () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'first', replyTo: 'om_first' }),
      ev('turn_submitted', { text: 'in a dm' }),
    ]);
    expect(view.replyTo).toBeUndefined();
  });

  it('says something rather than nothing while a turn is open', () => {
    // An empty card is indistinguishable from a broken one.
    const view = renderCard([]);
    expect(view.text).toBe('_Working…_');
    expect(view.finished).toBe(false);
  });

  it('treats empty output as a legitimate terminal', () => {
    const view = renderCard([ev('turn_ended', { terminal: 'completed' })]);
    expect(view.text).toBe('_Finished with no output._');
    expect(view.finished).toBe(true);
  });

  it('concatenates message chunks in seq order', () => {
    const view = renderCard([
      ev('agent_message_chunk', { text: 'Hello' }),
      ev('agent_message_chunk', { text: ', world' }),
    ]);
    expect(view.text).toContain('Hello, world');
  });

  it("renders the agent's markdown rather than showing its syntax", () => {
    // Every answer used to arrive with its markdown escaped: bold as literal
    // asterisks, code blocks as raw backticks.
    const view = renderCard([
      ev('agent_message_chunk', { text: 'validate **DAG-based pipelines**, including' }),
    ]);
    expect(view.text).toContain('**DAG-based pipelines**');
  });

  it('still escapes a tool title, which is a label and not markdown', () => {
    const view = renderCard([
      ev('tool_call', { toolCallId: 'c1', title: 'Read **secret**.md', status: 'completed' }),
    ]);
    expect(view.text).toContain('\\*\\*secret\\*\\*');
  });

  it('escapes agent text', () => {
    const view = renderCard([ev('agent_message_chunk', { text: '<at id=all></at>' })]);
    // Every `<` is preceded by a backslash; the substring `<at` still appears in
    // the escaped form, so the assertion has to be about the escape.
    expect(view.text).not.toMatch(/(^|[^\\])</);
  });

  it('keeps thoughts, plans and usage out of the card body', () => {
    const view = renderCard([
      ev('agent_thought_chunk', { text: 'thinking hard' }),
      ev('plan', { entries: [] }),
      ev('usage', { tokens: 10 }),
    ]);
    expect(view.text).not.toContain('thinking hard');
  });

  it('gives a tool-call update its own line even with no preceding tool_call', () => {
    // The pair can straddle a restart; dropping the orphan would hide work that
    // actually happened.
    const view = renderCard([ev('tool_call_update', { toolCallId: 'tc_9', status: 'completed' })]);
    // Escaped, because a tool call id is agent-supplied text like any other.
    expect(view.text).toContain('tc\\_9');
  });

  it('collapses a tool call and its updates into one line', () => {
    const view = renderCard([
      ev('tool_call', { toolCallId: 'tc_1', title: 'Read file', status: 'in_progress' }),
      ev('tool_call_update', { toolCallId: 'tc_1', status: 'completed' }),
    ]);
    const lines = view.text.split('\n').filter((l) => l.includes('Read file'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('✅');
  });

  it('puts every tool call on one line, a repeated one counted rather than listed again', () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'who am I?' }),
      ...[1, 2, 3, 4].map((n) => ev('tool_call', { toolCallId: `tc_${n}`, title: 'lark-cli', status: 'completed' })),
      ev('agent_message_chunk', { text: 'You are the bot.' }),
    ]);
    expect(view.text.split('\n\n')[0]).toBe('✅ lark-cli ×4');
  });

  it('keeps calls of different tools, or with a different status, apart on that line, in the order they came', () => {
    const view = renderCard([
      ev('tool_call', { toolCallId: 'a', title: 'lark-cli', status: 'completed' }),
      ev('tool_call', { toolCallId: 'b', title: 'Read', status: 'completed' }),
      ev('tool_call', { toolCallId: 'c', title: 'lark-cli', status: 'completed' }),
      ev('tool_call', { toolCallId: 'd', title: 'Bash', status: 'failed' }),
      ev('tool_call', { toolCallId: 'e', title: 'lark-cli', status: 'in_progress' }),
    ]);
    expect(view.text.split('\n\n')[0]).toBe('✅ lark-cli ×2 · ✅ Read · ❌ Bash · ⏳ lark-cli');
  });

  it('starts what the agent says after a tool call on a new paragraph, instead of running it into what came before', () => {
    const view = renderCard([
      ev('agent_message_chunk', { text: "I'll check " }),
      ev('agent_message_chunk', { text: 'who you are.' }),
      ev('tool_call', { toolCallId: 'a', title: 'lark-cli', status: 'completed' }),
      ev('tool_call_update', { toolCallId: 'a', status: 'completed' }),
      ev('agent_message_chunk', { text: 'You are the bot.' }),
    ]);
    expect(view.text).toContain("I'll check who you are.\n\nYou are the bot.");
  });

  it('reports a pending approval instead of claiming progress', () => {
    // A card reading "Working…" while the agent is blocked on a button is how
    // approvals sit unanswered for hours.
    const view = renderCard([ev('approval_requested', { approvalId: 'a_1', action: 'rm -rf' })]);
    expect(view.text).toContain('Waiting for your approval');
  });

  it('drops the approval notice once it is answered', () => {
    const view = renderCard([
      ev('approval_requested', { approvalId: 'a_1', action: 'rm -rf' }),
      ev('approval_resolved', { approvalId: 'a_1', optionId: 'allow' }),
    ]);
    expect(view.text).not.toContain('Waiting for your approval');
  });

  it('drops the approval notice after a terminal, even if never answered', () => {
    // After the turn ends the button does nothing; pointing at it sends the user
    // hunting for a control that is no longer live.
    const view = renderCard([
      ev('approval_requested', { approvalId: 'a_1', action: 'rm -rf' }),
      ev('turn_ended', { terminal: 'cancelled' }),
    ]);
    expect(view.text).not.toContain('Waiting for your approval');
    expect(view.text).toContain('cancelled');
  });

  it('names a non-completed terminal and stays quiet about a completed one', () => {
    expect(renderCard([ev('turn_ended', { terminal: 'ambiguous' })]).text).toContain('ambiguous');
    const done = renderCard([
      ev('agent_message_chunk', { text: 'done' }),
      ev('turn_ended', { terminal: 'completed' }),
    ]);
    expect(done.text).toBe('done');
  });

  it('surfaces the last error', () => {
    const view = renderCard([
      ev('agent_error', { message: 'first', retryable: true }),
      ev('agent_error', { message: 'second', retryable: false }),
    ]);
    expect(view.text).toContain('second');
    expect(view.text).not.toContain('first');
  });

  it('does not blame a new turn for the previous turn’s failure', () => {
    // The card renders the whole session from seq 0, so without a reset one bad
    // turn is stamped onto every later card forever -- an answer that streamed
    // perfectly still carries "Error: ..." underneath it, often naming a driver
    // the session no longer uses. Observed in production, not hypothetical.
    const view = renderCard([
      ev('turn_submitted', { text: 'first ask' }),
      ev('agent_error', { message: 'ACP session failed to start', retryable: true }),
      ev('turn_ended', { terminal: 'failed' }),
      ev('turn_submitted', { text: 'second ask' }),
      ev('agent_message_chunk', { text: 'a good answer' }),
      ev('turn_ended', { terminal: 'completed' }),
    ]);
    expect(view.text).toContain('a good answer');
    expect(view.text).not.toContain('ACP session failed');
    expect(view.text).not.toContain('Error:');
  });

  it('renders one turn, not the session', () => {
    // A card is the reply to one prompt. Accumulating answers ran them together
    // as "first answersecond answer", grew against the budget forever, and
    // eventually re-showed the whole history on any freshly opened card.
    const events = [
      ev('turn_submitted', { text: 'first ask' }),
      ev('agent_message_chunk', { text: 'first answer' }),
      ev('turn_ended', { terminal: 'completed' }),
      ev('turn_submitted', { text: 'second ask' }),
      ev('agent_message_chunk', { text: 'second answer' }),
    ];
    const view = renderCard(events);
    expect(view.text).toBe('second answer');
    // Live again: the previous turn's terminal must not leave the new reply frozen.
    expect(view.finished).toBe(false);
    // The earlier answer is not lost -- it is on the earlier card, and in the log.
    expect(renderCard(events.slice(0, 3)).text).toBe('first answer');
  });

  it('names the turn it is rendering, so the writer knows which card it is for', () => {
    const before = renderCard([ev('agent_message_chunk', { text: 'no turn yet' })]);
    expect(before.turnStartSeq).toBe(0);

    const start = ev('turn_submitted', { text: 'ask' });
    const view = renderCard([start, ev('agent_message_chunk', { text: 'answer' })]);
    expect(view.turnStartSeq).toBe(start.seq);
  });

  it('drops a previous turn’s unanswered approval notice', () => {
    // The button belonged to work that is over. Pointing at it on a new reply
    // sends the user hunting for a control that answers nothing.
    const view = renderCard([
      ev('approval_requested', { approvalId: 'a_1', action: 'rm -rf' }),
      ev('turn_submitted', { text: 'next' }),
      ev('agent_message_chunk', { text: 'working on it' }),
    ]);
    expect(view.text).not.toContain('Waiting for your approval');
  });

  it('drops the previous turn’s tool checklist', () => {
    // Tools are progress, not content. An old turn's checklist decorating a new
    // answer reads as work this turn did.
    const view = renderCard([
      ev('tool_call', { toolCallId: 'c1', title: 'Bash', status: 'completed' }),
      ev('turn_submitted', { text: 'next' }),
      ev('agent_message_chunk', { text: 'no tools this time' }),
    ]);
    expect(view.text).not.toContain('Bash');
  });

  it('reports the highest seq it included', () => {
    const events = [ev('agent_message_chunk', { text: 'a' }), ev('agent_message_chunk', { text: 'b' })];
    expect(renderCard(events).throughSeq).toBe(events[1]?.seq);
  });

  it('is a pure function of its input', () => {
    const events = [
      ev('tool_call', { toolCallId: 'tc_1', title: 'Grep', status: 'in_progress' }),
      ev('agent_message_chunk', { text: 'hi' }),
    ];
    expect(renderCard(events)).toEqual(renderCard(events));
  });

  it('stays inside the card budget and says that it truncated', () => {
    const view = renderCard([ev('agent_message_chunk', { text: 'x'.repeat(CARD_TEXT_BUDGET * 2) })]);
    expect(view.text.length).toBeLessThanOrEqual(CARD_TEXT_BUDGET);
    expect(view.text).toContain('truncated');
  });
});

describe('renderCard: known secrets', () => {
  beforeEach(() => {
    clearSecrets();
    addSecrets(['sk-test-123456']);
  });

  it('masks a secret split across two chunks', () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_message_chunk', { text: 'the key is sk-te' }),
      ev('agent_message_chunk', { text: 'st-123456 ok' }),
      ev('turn_ended', { terminal: 'completed' }),
    ]);
    expect(view.text).toContain(`the key is ${MASK} ok`);
    expect(view.text).not.toContain('sk-te');
  });

  it('does not show the start of a secret while the rest has not arrived', () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_message_chunk', { text: 'the key is sk-te' }),
    ]);
    expect(view.text).toContain('the key is');
    expect(view.text).not.toContain('sk-te');
  });

  it('does not show the start of a secret when a control character follows it', () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_message_chunk', { text: 'the key is sk-test-12\u0007' }),
    ]);
    expect(view.text).not.toContain('sk-te');
  });

  it('drops the start of a secret on a final render, when the turn ended part-way through it', () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_message_chunk', { text: 'done: sk-te' }),
      ev('turn_ended', { terminal: 'completed' }),
    ]);
    expect(view.text).toContain('done:');
    expect(view.text).not.toContain('sk-te');
  });
});

describe('renderCard: secrets that do not occur', () => {
  beforeEach(() => clearSecrets());
  afterEach(() => clearSecrets());

  it('renders exactly as it would with no secrets known', () => {
    const events = [
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_message_chunk', { text: '## Result\n\nSome **bold** text and `code`.' }),
      ev('tool_call', { toolCallId: 'c1', title: 'Read main.ts', status: 'completed' }),
      ev('agent_error', { message: 'responses API stream error 400', retryable: true }),
      ev('turn_ended', { terminal: 'failed' }),
    ];
    const plain = renderCard(events);
    addSecrets(['unrelated-secret-1', 'another-unrelated-2']);
    expect(renderCard(events)).toEqual(plain);
  });
});

describe('renderCard: a secret that contains another', () => {
  beforeEach(() => clearSecrets());

  function fragments(secret: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 4 <= secret.length; i += 1) out.push(secret.slice(i, i + 4));
    return out;
  }

  it('withholds the outer secret when the inner one is at its start', () => {
    const outer = 'abcdefgh-longer-secret-value';
    addSecrets(['abcdefgh', outer]);
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_message_chunk', { text: 'k abcdefgh-longer-secr' }),
    ]);
    for (const fragment of fragments(outer)) expect(view.text).not.toContain(fragment);
  });

  it('withholds the outer secret when the inner one is in its middle', () => {
    const outer = 'AAA-mid-secret-x-tail-ZZZZZZ';
    addSecrets(['mid-secret-x', outer]);
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_message_chunk', { text: 'k AAA-mid-secret-x-tail-ZZ' }),
    ]);
    for (const fragment of fragments(outer)) expect(view.text).not.toContain(fragment);
  });
});
