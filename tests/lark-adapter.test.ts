import { describe, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { LarkAdapter, sendError } from '../src/channel/lark/adapter.js';
import { ChannelError } from '../src/channel/types.js';

/**
 * How the Lark adapter sends one message (spec §9.4): through the SDK's client,
 * with the uuid, retried on a failure that never reached Lark, and falling back
 * as the SDK's own send does. Over a stand-in for the SDK's channel: nothing
 * here reaches Lark.
 */

interface Call {
  kind: 'create' | 'reply';
  payload: { params?: { receive_id_type: string }; path?: { message_id: string }; data: { msg_type: string; content: string; uuid: string; receive_id?: string } };
}

/** An HTTP error as axios throws one: Lark's code in the response body. */
function refused(code: number, status = 400): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { code, msg: `refused ${code}` }, headers: {} },
  });
}

/** What Lark answers a send with: a failure, or more of a success's data, such as its thread_id. */
type Answer = Error | { thread_id: string } | undefined;

function adapter(answers: Answer[]): { a: LarkAdapter; calls: Call[]; waits: number[] } {
  const calls: Call[] = [];
  const waits: number[] = [];
  let seq = 0;
  const answer = async (kind: Call['kind'], payload: Call['payload']) => {
    calls.push({ kind, payload });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { code: 0, msg: 'ok', data: { message_id: `om_${++seq}`, ...next } };
  };
  const lark = {
    rawClient: {
      im: {
        v1: {
          message: {
            create: (p: Call['payload']) => answer('create', p),
            reply: (p: Call['payload']) => answer('reply', p),
          },
        },
      },
    },
  } as unknown as LarkChannel;
  const a = new LarkAdapter({ appId: 'cli_app', appSecret: 'not-a-secret' }, undefined, {
    lark,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  // Before anything is sent: an adapter that built its own SDK channel would reach Lark.
  if (a.raw !== lark) throw new Error('the adapter did not take the stand-in for the SDK');
  return { a, calls, waits };
}

const CHAT = { chatId: 'oc_team', threadId: '' };

describe('LarkAdapter.sendText', () => {
  it('sends a text as one post, with its uuid', async () => {
    const { a, calls } = adapter([]);
    expect(await a.sendText(CHAT, '**Done**', 'u-1')).toEqual({ messageId: 'om_1', deduped: false });
    expect(calls).toEqual([
      {
        kind: 'create',
        payload: {
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: 'oc_team',
            msg_type: 'post',
            content: JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'md', text: '**Done**' }]] } }),
            uuid: 'u-1',
          },
        },
      },
    ]);
  });

  it('retries a send that never reached Lark, with the same uuid, and not one Lark refused', async () => {
    const { a, calls, waits } = adapter([new Error('socket hang up'), new Error('ETIMEDOUT')]);
    expect((await a.sendText(CHAT, 'hi', 'u-2')).messageId).toBe('om_1');
    expect(calls.map((c) => c.payload.data.uuid)).toEqual(['u-2', 'u-2', 'u-2']);
    expect(waits).toHaveLength(2);
    const refusing = adapter([refused(230099)]);
    await expect(refusing.a.sendText(CHAT, 'hi', 'u-3')).rejects.toMatchObject({ code: 230099, retryable: false });
    expect(refusing.calls).toHaveLength(1);
  });

  it('sends a post Lark refuses as invalid content as plain text, and a reply to a withdrawn message to its chat', async () => {
    const invalid = adapter([refused(230001)]);
    await invalid.a.sendText(CHAT, 'hi', 'u-4');
    expect(invalid.calls.map((c) => [c.payload.data.msg_type, c.payload.data.content])).toEqual([
      ['post', JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'md', text: 'hi' }]] } })],
      ['text', JSON.stringify({ text: 'hi' })],
    ]);
    const withdrawn = adapter([refused(230011)]);
    await withdrawn.a.sendText({ chatId: 'oc_team', threadId: 'omt_gone' }, 'hi', 'u-5');
    expect(withdrawn.calls.map((c) => [c.kind, c.payload.path?.message_id ?? c.payload.data.receive_id])).toEqual([
      ['reply', 'omt_gone'],
      ['create', 'oc_team'],
    ]);
  });

  it("sends a reply to its chat on the SDK's codes for a gone message too, 230017 and HTTP 404, but retries 230020 as the rate limit it is", async () => {
    const thread = { chatId: 'oc_team', threadId: 'omt_gone' };
    const where = (calls: Call[]) => calls.map((c) => [c.kind, c.payload.path?.message_id ?? c.payload.data.receive_id]);
    for (const err of [refused(230017), refused(230099, 404), Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: {}, headers: {} } })]) {
      const gone = adapter([err]);
      expect((await gone.a.sendText(thread, 'hi', 'u-9')).messageId).toBe('om_1');
      expect(where(gone.calls)).toEqual([
        ['reply', 'omt_gone'],
        ['create', 'oc_team'],
      ]);
      expect(gone.calls.map((c) => c.payload.data.uuid)).toEqual(['u-9', 'u-9']);
    }
    const limited = adapter([refused(230020)]);
    await limited.a.sendText(thread, 'hi', 'u-10');
    expect(where(limited.calls)).toEqual([
      ['reply', 'omt_gone'],
      ['reply', 'omt_gone'],
    ]);
    expect(limited.waits).toHaveLength(1);
    const card = adapter([refused(230017)]);
    await card.a.sendApprovalCard(thread, { approvalId: 'a_1', action: 'rm x', options: [{ optionId: 'allow', name: 'Allow' }], nonce: 'n' }, 'u-11');
    expect(where(card.calls)).toEqual([
      ['reply', 'omt_gone'],
      ['create', 'oc_team'],
    ]);
  });

  it('sends a text whose card of buttons Lark refuses without them, unless the bot is not in the chat', async () => {
    const button = { label: 'Unblock k_1', style: 'primary' as const, value: { kind: 'kanban' } };
    const fallback = adapter([refused(200621)]);
    expect((await fallback.a.sendText(CHAT, 'Blocked', 'u-6', [button])).messageId).toBe('om_1');
    expect(fallback.calls.map((c) => c.payload.data.msg_type)).toEqual(['interactive', 'post']);
    const outside = adapter([refused(230002)]);
    await expect(outside.a.sendText(CHAT, 'Blocked', 'u-7', [button])).rejects.toMatchObject({ code: 230002 });
    expect(outside.calls).toHaveLength(1);
  });
});

describe('LarkAdapter in a thread (spec §19.4, §19.7)', () => {
  const where = (calls: Call[]) => calls.map((c) => [c.kind, c.payload.path?.message_id ?? c.payload.data.receive_id]);

  it("reads the thread a send landed in from Lark's answer, and none when it has none", async () => {
    const threaded = adapter([{ thread_id: 'omt_new' }]);
    expect(await threaded.a.sendText({ chatId: 'oc_team', threadId: '', replyTo: 'om_cmd', replyInThread: true }, 'Created', 'u-1')).toEqual({
      messageId: 'om_1',
      deduped: false,
      threadId: 'omt_new',
    });
    expect(where(threaded.calls)).toEqual([['reply', 'om_cmd']]);
    const card = adapter([{ thread_id: 'omt_topic' }]);
    expect((await card.a.sendCard({ chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root' }, { markdown: 'x', buttons: [] }, 'u-2')).threadId).toBe(
      'omt_topic',
    );
    expect(where(card.calls)).toEqual([['reply', 'om_root']]);
    const dm = adapter([{ thread_id: '' }]);
    expect(await dm.a.sendCard({ chatId: 'on_alice', threadId: '', receiveIdType: 'union_id' }, { markdown: 'x', buttons: [] }, 'u-3')).toEqual({
      messageId: 'om_1',
      deduped: false,
    });
  });

  it('keeps a send that stays in its thread out of the chat: a withdrawn root, 230017 or an HTTP 404 reaches the caller', async () => {
    const target = { chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root', stayInThread: true };
    for (const err of [refused(230011), refused(230017), refused(230099, 404)]) {
      const gone = adapter([err]);
      await expect(gone.a.sendCard(target, { markdown: 'x', buttons: [] }, 'u-4')).rejects.toBeInstanceOf(ChannelError);
      expect(where(gone.calls)).toEqual([['reply', 'om_root']]);
    }
    const created = adapter([refused(230011)]);
    await expect(
      created.a.sendText({ chatId: 'oc_team', threadId: '', replyTo: 'om_cmd', replyInThread: true, stayInThread: true }, 'Created', 'u-5'),
    ).rejects.toMatchObject({ code: 230011, retryable: false });
    expect(where(created.calls)).toEqual([['reply', 'om_cmd']]);
    // Without it, a notice's reply to a gone root goes to the chat, as before.
    const notice = adapter([refused(230011)]);
    await notice.a.sendText({ chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root' }, 'Done', 'u-6');
    expect(where(notice.calls)).toEqual([
      ['reply', 'om_root'],
      ['create', 'oc_team'],
    ]);
  });
});

describe('LarkAdapter.sendApprovalCard', () => {
  it('posts the card with its uuid', async () => {
    const { a, calls } = adapter([]);
    await a.sendApprovalCard(CHAT, { approvalId: 'a_1', action: 'rm x', options: [{ optionId: 'allow', name: 'Allow' }], nonce: 'n' }, 'u-8');
    expect(calls[0]?.payload.data).toMatchObject({ msg_type: 'interactive', uuid: 'u-8' });
  });
});

describe('sendError', () => {
  it('makes a failure that never reached Lark retryable, and leaves an answer as Lark gave it', () => {
    expect(sendError(new Error('socket hang up'))).toMatchObject({ code: 0, retryable: true });
    expect(sendError(refused(230099))).toMatchObject({ code: 230099, retryable: false });
    expect(sendError(refused(99991400, 429))).toMatchObject({ code: 99991400, retryable: true });
    expect(sendError(new ChannelError(5, 'x', false))).toMatchObject({ code: 5, retryable: false });
  });
});
