import { describe, expect, it } from 'vitest';
import { approvalOutcomeCard } from '../src/channel/lark/adapter.js';

/**
 * The answered-approval card replaces one that carried live buttons. Two things
 * matter about it: the buttons are really gone, and nothing on it -- the agent's
 * request text, or the answerer's display name, which is whatever they set in
 * their profile -- is rendered somewhere a tag could be injected.
 */

const VIEW = { action: 'rm -rf /', choice: 'Deny', answeredBy: 'Alice' };

function elements(card: object): Array<Record<string, unknown>> {
  return (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
}

function texts(card: object): Array<{ tag: string; content: string }> {
  return elements(card)
    .map((e) => e['text'] as { tag: string; content: string } | undefined)
    .filter((t): t is { tag: string; content: string } => t !== undefined);
}

describe('approvalOutcomeCard', () => {
  it('has no buttons left to click', () => {
    const card = approvalOutcomeCard(VIEW);
    expect(JSON.stringify(card)).not.toContain('"button"');
    expect(elements(card).some((e) => e['tag'] === 'action')).toBe(false);
  });

  it('shows the request, the answer and who gave it', () => {
    const shown = texts(approvalOutcomeCard(VIEW)).map((t) => t.content).join('\n');
    expect(shown).toContain('rm -rf /');
    expect(shown).toContain('Deny');
    expect(shown).toContain('Alice');
  });

  it('renders every piece of text as plain_text, so none of it can become a mention', () => {
    const card = approvalOutcomeCard({
      action: '<at id=all></at>',
      choice: 'Allow',
      answeredBy: '<at id=all></at>',
    });
    expect(texts(card).every((t) => t.tag === 'plain_text')).toBe(true);
  });

  it('stays updatable, like the card it replaces', () => {
    const card = approvalOutcomeCard(VIEW) as { config?: { update_multi?: boolean } };
    expect(card.config?.update_multi).toBe(true);
  });
});
