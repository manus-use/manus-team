import { afterEach, describe, expect, it } from 'vitest';
import { renderCard } from '../src/channel/render.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { Event, EventType } from '../src/types.js';

/**
 * A woken turn's card (wake spec §6.2): its first line says the board woke it,
 * and as whom, escaped as a label, above the answer as it streams. A typed turn's
 * card is unchanged.
 */

let seq = 0;
function ev(type: EventType, payload: unknown): Event {
  seq += 1;
  return { sessionId: 's_test', seq, ts: 1_760_000_000_000 + seq, generation: 0, brokerSeq: null, turnId: 't_1', type, actor: 'agent', payload };
}

const WOKEN = { text: 'Board update: …', paths: [], messageId: 'wake:abc', wake: { id: 7, by: 'lark:on_zhixi', name: 'Zhixi Sun' } };

afterEach(() => clearSecrets());

describe('renderCard: a woken turn', () => {
  it('starts with the line that says the board woke it, as whom', () => {
    const view = renderCard([ev('turn_submitted', WOKEN), ev('agent_message_chunk', { text: 'On it.' })]);
    expect(view.text.split('\n')[0]).toBe('_(woken by the board, as Zhixi Sun)_');
    expect(view.parts.tools).toBe('_(woken by the board, as Zhixi Sun)_');
    expect(view.parts.answer).toBe('On it.');
  });

  it('keeps the line above the tool line and the placeholder', () => {
    const open = renderCard([ev('turn_submitted', WOKEN)]);
    expect(open.parts).toEqual({ tools: '_(woken by the board, as Zhixi Sun)_', answer: '', status: '_Working…_' });
    const tools = renderCard([ev('turn_submitted', WOKEN), ev('tool_call', { toolCallId: 'c1', title: 'Bash', status: 'completed' })]);
    expect(tools.parts.tools).toBe('_(woken by the board, as Zhixi Sun)_\n\n✅ Bash');
  });

  it('escapes the name as a label, and masks it', () => {
    addSecrets(['sk-secret-9876']);
    const view = renderCard([ev('turn_submitted', { ...WOKEN, wake: { ...WOKEN.wake, name: 'A_*b* sk-secret-9876' } })]);
    expect(view.parts.tools).toBe(`_(woken by the board, as A\\_\\*b\\* ${MASK})_`);
  });

  it('is gone at the next, typed, turn', () => {
    const view = renderCard([
      ev('turn_submitted', WOKEN),
      ev('turn_ended', { terminal: 'completed' }),
      ev('turn_submitted', { text: 'hi', paths: [], messageId: 'om_1' }),
    ]);
    expect(view.parts.tools).toBe('');
  });

  it('leaves a typed turn without it', () => {
    const view = renderCard([ev('turn_submitted', { text: 'hi', paths: [], messageId: 'om_1' }), ev('agent_message_chunk', { text: 'yes' })]);
    expect(view.text).toBe('yes');
  });
});
