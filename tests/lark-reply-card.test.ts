import { describe, expect, it } from 'vitest';
import { EMPTY_PART, REPLY_ELEMENTS, REPLY_SUMMARY_OPEN, replyCard, replySummary } from '../src/channel/lark/adapter.js';
import type { CardParts } from '../src/channel/types.js';

/**
 * The reply card as Lark is given it (channel spec §4.5): a streaming card of a
 * markdown element for each part with something to show, in reading order, each
 * with an element id the updates name.
 */

describe('replyCard', () => {
  it('is a streaming card of three markdown elements, the tool line, the answer and the status, in that order', () => {
    expect(replyCard({ tools: '✅ Bash', answer: 'Hello', status: '_Working…_' })).toEqual({
      schema: '2.0',
      config: {
        update_multi: true,
        streaming_mode: true,
        summary: { content: REPLY_SUMMARY_OPEN },
        streaming_config: {
          print_frequency_ms: { default: 70 },
          print_step: { default: 1 },
          print_strategy: 'fast',
        },
      },
      body: {
        elements: [
          { tag: 'markdown', element_id: 'tools', content: '✅ Bash' },
          { tag: 'markdown', element_id: 'answer', content: 'Hello' },
          { tag: 'markdown', element_id: 'status', content: '_Working…_' },
        ],
      },
    });
    expect(REPLY_ELEMENTS).toEqual({ tools: 'tools', answer: 'answer', status: 'status' });
  });

  it('gives a part with nothing to show no element, as Lark draws even a zero-width space as a blank line', () => {
    const ids = (parts: CardParts): string[] => (replyCard(parts) as { body: { elements: Array<{ element_id: string }> } }).body.elements.map((e) => e.element_id);
    expect(ids({ tools: '', answer: '', status: '_Working…_' })).toEqual(['status']);
    expect(ids({ tools: '', answer: 'Hello', status: '' })).toEqual(['answer']);
    expect(ids({ tools: '✅ Bash', answer: '', status: '_Turn failed._' })).toEqual(['tools', 'status']);
  });

  it('keeps one element of a zero-width space when no part has anything, which renderCard never gives', () => {
    const card = replyCard({ tools: '', answer: '', status: '' }) as { body: { elements: Array<{ element_id: string; content: string }> } };
    expect(card.body.elements).toEqual([{ tag: 'markdown', element_id: 'status', content: EMPTY_PART }]);
    expect(EMPTY_PART).toBe('\u200b');
  });
});

describe('replySummary', () => {
  it('previews the answer on one line, cut to 50 characters', () => {
    expect(replySummary({ tools: '✅ Bash', answer: 'Line one\n\nline   two', status: '' })).toBe('Line one line two');
    const long = replySummary({ tools: '', answer: 'word '.repeat(30), status: '' });
    expect(Array.from(long)).toHaveLength(50);
    expect(long.endsWith('…')).toBe(true);
  });

  it('previews the status when there is no answer, then the tool line', () => {
    expect(replySummary({ tools: '✅ Bash', answer: '', status: '_Turn failed._' })).toBe('Turn failed.');
    expect(replySummary({ tools: '✅ Bash', answer: '', status: '' })).toBe('✅ Bash');
  });

  it('takes out simple emphasis and backslash escapes, as a preview is plain text', () => {
    expect(replySummary({ tools: '', answer: 'All **done**, `npm test` _passes_ ~~now~~.', status: '' })).toBe('All done, npm test passes now.');
    expect(replySummary({ tools: '', answer: 'a \\<b\\> and 2 \\* 3', status: '' })).toBe('a <b> and 2 * 3');
    expect(replySummary({ tools: '', answer: 'snake_case_name and \\*not bold\\*', status: '' })).toBe('snake_case_name and *not bold*');
  });

  it('cuts on a character, never half an emoji', () => {
    const preview = replySummary({ tools: '', answer: `${'a'.repeat(48)}😀😀😀`, status: '' });
    expect(Array.from(preview)).toEqual([...'a'.repeat(48), '😀', '…']);
  });
});
