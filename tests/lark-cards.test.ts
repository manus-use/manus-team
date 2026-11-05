import { describe, expect, it } from 'vitest';
import { approvalCard, approvalOutcomeCard, boardCard, messageRequest, postContent } from '../src/channel/lark/adapter.js';
import { personTarget, type CardView } from '../src/channel/types.js';

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

/** The buttons of a row: a column_set of auto-width columns, one button each, so they sit side by side. */
function row(e: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  expect(e).toMatchObject({ tag: 'column_set', flex_mode: 'none' });
  const columns = (e as { columns: Array<{ tag: string; width: string; elements: Array<Record<string, unknown>> }> }).columns;
  for (const c of columns) expect(c).toMatchObject({ tag: 'column', width: 'auto' });
  expect(columns.every((c) => c.elements.length === 1)).toBe(true);
  return columns.map((c) => c.elements[0] as Record<string, unknown>);
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

describe('approvalCard', () => {
  const spec = {
    approvalId: 'a_1',
    action: '<at id=all></at> rm -rf build',
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
    nonce: 'n1',
  };

  it("puts one button per option in one row, each value returned by a callback behavior and saying it is an approval's", () => {
    const els = elements(approvalCard(spec));
    expect(els[0]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: '<at id=all></at> rm -rf build' } });
    expect(els).toHaveLength(2);
    expect(row(els[1]).map((b) => [b['tag'], b['type'], b['behaviors']])).toEqual([
      ['button', 'primary', [{ type: 'callback', value: { kind: 'approval', approvalId: 'a_1', optionId: 'allow', nonce: 'n1' } }]],
      ['button', 'danger', [{ type: 'callback', value: { kind: 'approval', approvalId: 'a_1', optionId: 'deny', nonce: 'n1' } }]],
    ]);
    // No container of schema 1.0: every element is one schema 2.0 has.
    expect(JSON.stringify(approvalCard(spec))).not.toContain('"action"');
    expect((approvalCard(spec) as { schema?: string; config?: { update_multi?: boolean } })).toMatchObject({
      schema: '2.0',
      config: { update_multi: true },
    });
  });
});

describe('messageRequest', () => {
  const card = { schema: '2.0' };

  it('sends a person a direct message by union_id, with the uuid (spec §9.2)', () => {
    expect(messageRequest(personTarget('on_alice'), 'interactive', card, 'u-1')).toEqual({
      kind: 'create',
      params: { receive_id_type: 'union_id' },
      data: { receive_id: 'on_alice', msg_type: 'interactive', content: JSON.stringify(card), uuid: 'u-1' },
    });
  });

  it('replies in a thread, quotes at chat scope, and posts new otherwise, the uuid always with it', () => {
    expect(messageRequest({ chatId: 'oc_team', threadId: 'omt_topic' }, 'post', card, 'u-2')).toEqual({
      kind: 'reply',
      path: { message_id: 'omt_topic' },
      data: { msg_type: 'post', content: JSON.stringify(card), uuid: 'u-2', reply_in_thread: true },
    });
    expect(messageRequest({ chatId: 'oc_team', threadId: '', replyTo: 'om_q' }, 'post', card, 'u-3')).toEqual({
      kind: 'reply',
      path: { message_id: 'om_q' },
      data: { msg_type: 'post', content: JSON.stringify(card), uuid: 'u-3' },
    });
    expect(messageRequest({ chatId: 'oc_team', threadId: '' }, 'post', card, 'u-4')).toEqual({
      kind: 'create',
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_team', msg_type: 'post', content: JSON.stringify(card), uuid: 'u-4' },
    });
  });

  it('makes a text one post of one markdown element, as the SDK does', () => {
    expect(postContent('**Done** — x')).toEqual({ zh_cn: { title: '', content: [[{ tag: 'md', text: '**Done** — x' }]] } });
  });
});

describe('boardCard', () => {
  const view: CardView = {
    markdown: '📋 **Draft the notes** `k_1`',
    input: { placeholder: '<at id=all></at> a summary' },
    buttons: [
      { label: 'Done', style: 'primary', value: { kind: 'kanban', act: 'done', task: 'k_1', run: 'r_1', nonce: 'n' } },
      { label: '<at id=all></at>', style: 'danger', value: { kind: 'kanban', act: 'block', task: 'k_1', run: 'r_1', nonce: 'n' } },
    ],
  };

  it("puts the box and a row of the buttons in one form, so a button submits the box's text", () => {
    const els = elements(boardCard(view));
    expect(els[0]).toEqual({ tag: 'markdown', content: view.markdown });
    const form = els[1] as { tag: string; elements: Array<Record<string, unknown>> };
    expect(form.tag).toBe('form');
    expect(form.elements[0]).toMatchObject({ tag: 'input', name: 'text' });
    expect(form.elements).toHaveLength(2);
    expect(row(form.elements[1]).map((b) => [b['form_action_type'], b['behaviors']])).toEqual([
      ['submit', [{ type: 'callback', value: view.buttons[0]?.value }]],
      ['submit', [{ type: 'callback', value: view.buttons[1]?.value }]],
    ]);
  });

  it('renders every label and the placeholder as plain_text, so none can become a mention', () => {
    const json = JSON.stringify(boardCard(view));
    expect(json).not.toContain('"lark_md"');
    const form = elements(boardCard(view))[1] as { elements: Array<Record<string, unknown>> };
    const shown = [form.elements[0], ...row(form.elements[1])] as Array<Record<string, { tag: string }>>;
    expect(shown.map((e) => (e['text'] ?? e['placeholder'])?.tag)).toEqual(['plain_text', 'plain_text', 'plain_text']);
  });

  it("names each button by its place and the card's attempt, so a redrawn card's buttons are new ones", () => {
    const names = (v: CardView) =>
      row((elements(boardCard(v))[1] as { elements: Array<Record<string, unknown>> }).elements[1]).map((b) => b['name']);
    expect(names(view)).toEqual(['button_0_0', 'button_1_0']);
    expect(names({ ...view, attempt: 2 })).toEqual(['button_0_2', 'button_1_2']);
  });

  it('has no form without a box, and no buttons once acted on; and stays updatable', () => {
    const plain = elements(boardCard({ markdown: view.markdown, buttons: view.buttons }));
    expect(plain.map((e) => e['tag'])).toEqual(['markdown', 'column_set']);
    expect(row(plain[1]).map((b) => [b['tag'], b['form_action_type']])).toEqual([
      ['button', undefined],
      ['button', undefined],
    ]);
    const acted = boardCard({ markdown: 'Done by Alice', buttons: [] });
    expect(JSON.stringify(acted)).not.toContain('"button"');
    expect((acted as { config?: { update_multi?: boolean } }).config?.update_multi).toBe(true);
  });
});
