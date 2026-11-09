import { afterEach, describe, expect, it } from 'vitest';
import { parseKanban } from '../src/kanban/chat-parse.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';

/** `/kanban` as typed in chat (spec §9.1): what follows the command, parsed. */

afterEach(() => {
  clearSecrets();
});

describe('/kanban task new', () => {
  it('takes the title from the first line, fields from labelled lines in any order, and the rest as the body', () => {
    const r = parseKanban(
      [
        'task new  Write the release notes ',
        'assignee: docs-writer',
        'The notes cover 0.4.',
        'Workspace: docs',
        'parent: k_a, k_b',
        'parent: k_c',
        'outcome: notes merged',
        'verify: a reviewer reads them',
        'constraints: no marketing words',
        'boundaries: docs/ only',
        'stop when: the changelog is missing',
        '  outcome: an indented line stays body',
        'reviewer: reviewer',
      ].join('\n'),
    );
    expect(r).toEqual({
      ok: true,
      command: {
        verb: 'new',
        title: 'Write the release notes',
        body: 'The notes cover 0.4.\n  outcome: an indented line stays body',
        assignee: 'docs-writer',
        reviewer: 'reviewer',
        workspace: 'docs',
        parents: ['k_a', 'k_b', 'k_c'],
        contract: {
          outcome: 'notes merged',
          verification: 'a reviewer reads them',
          constraints: 'no marketing words',
          boundaries: 'docs/ only',
          stop_when: 'the changelog is missing',
        },
      },
    });
  });

  it('takes a title alone, and a title on the line after the verb', () => {
    expect(parseKanban('task new Tidy the wiki')).toEqual({
      ok: true,
      command: { verb: 'new', title: 'Tidy the wiki', body: '', parents: [], contract: {} },
    });
    expect(parseKanban('task NEW\nTidy the wiki\n\n\nWhat it is about.')).toMatchObject({
      ok: true,
      command: { title: 'Tidy the wiki', body: 'What it is about.' },
    });
  });

  it('reads a CRLF or a lone CR as a line break', () => {
    expect(parseKanban('task new Notes\r\nassignee: docs-writer\rThe body.')).toMatchObject({
      ok: true,
      command: { title: 'Notes', assignee: 'docs-writer', body: 'The body.' },
    });
  });

  it('refuses no title, a field line where the title goes, a field given twice, and a field with no value', () => {
    expect(parseKanban('task new')).toMatchObject({ ok: false, usage: expect.stringContaining('Put the title on the first line') });
    expect(parseKanban('task new\nassignee: docs-writer\nWrite it')).toMatchObject({
      ok: false,
      usage: expect.stringContaining('The first line is the title, before any field line.'),
    });
    expect(parseKanban('task new t\nassignee: a\nassignee: b')).toEqual({ ok: false, usage: '`assignee:` is given twice.' });
    expect(parseKanban('task new t\nverify:')).toEqual({ ok: false, usage: '`verify:` needs a value.' });
    expect(parseKanban('task new t\nparent: ,,,')).toEqual({ ok: false, usage: '`parent:` needs a value.' });
  });

  it('reads `stop when:` with any run of spaces or tabs between its words', () => {
    expect(parseKanban('task new t\nstop  when: the build is red\nStop\twhen: twice')).toEqual({
      ok: false,
      usage: '`stop when:` is given twice.',
    });
    expect(parseKanban('task new t\nstop \t when: the build is red')).toMatchObject({
      ok: true,
      command: { contract: { stop_when: 'the build is red' }, body: '' },
    });
  });

  it('passes over zero-width characters before a verb, before a field label and around its colon', () => {
    const zw = ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff'];
    for (const z of zw) {
      expect(parseKanban(`${z}task ${z}new Notes\n${z}assignee${z}: ${z}docs-writer\n${z}workspace: docs\nThe body.`)).toEqual({
        ok: true,
        command: {
          verb: 'new',
          title: 'Notes',
          body: 'The body.',
          assignee: 'docs-writer',
          workspace: 'docs',
          parents: [],
          contract: {},
        },
      });
    }
    expect(parseKanban('\u200btask \u2060show k_1')).toEqual({ ok: true, command: { verb: 'show', taskId: 'k_1' } });
  });
});

describe('the other /kanban commands', () => {
  it('parses each, with its task ids and text', () => {
    expect(parseKanban('')).toEqual({ ok: true, command: { verb: 'help' } });
    expect(parseKanban('help')).toEqual({ ok: true, command: { verb: 'help' } });
    expect(parseKanban('task list')).toEqual({ ok: true, command: { verb: 'list', filter: undefined } });
    expect(parseKanban('task list Blocked')).toEqual({ ok: true, command: { verb: 'list', filter: 'blocked' } });
    expect(parseKanban('task list all')).toEqual({ ok: true, command: { verb: 'list', filter: 'all' } });
    expect(parseKanban('task show k_1')).toEqual({ ok: true, command: { verb: 'show', taskId: 'k_1' } });
    expect(parseKanban('task stop k_1')).toEqual({ ok: true, command: { verb: 'stop', taskId: 'k_1' } });
    expect(parseKanban('task archive k_1')).toEqual({ ok: true, command: { verb: 'archive', taskId: 'k_1' } });
    expect(parseKanban('task assign k_1 reviewer')).toEqual({
      ok: true,
      command: { verb: 'assign', taskId: 'k_1', assignee: 'reviewer' },
    });
    // A person, whose name may hold a space, is kept whole, to be found among the message's mentions.
    expect(parseKanban('task assign k_1 @Alice Smith')).toEqual({
      ok: true,
      command: { verb: 'assign', taskId: 'k_1', assignee: '@Alice Smith' },
    });
    expect(parseKanban('task link k_1 k_2')).toEqual({ ok: true, command: { verb: 'link', parentId: 'k_1', childId: 'k_2' } });
    expect(parseKanban('task workspace k_1 docs')).toEqual({
      ok: true,
      command: { verb: 'workspace', taskId: 'k_1', workspace: 'docs' },
    });
    expect(parseKanban('task comment k_1 use the 2024 numbers\nnot 2023')).toEqual({
      ok: true,
      command: { verb: 'comment', taskId: 'k_1', text: 'use the 2024 numbers\nnot 2023' },
    });
    expect(parseKanban('task unblock k_1')).toEqual({ ok: true, command: { verb: 'unblock', taskId: 'k_1', comment: undefined } });
    expect(parseKanban('task unblock k_1 the key is in the vault now')).toEqual({
      ok: true,
      command: { verb: 'unblock', taskId: 'k_1', comment: 'the key is in the vault now' },
    });
  });

  it('keeps a gate command as written, after an optional timeout', () => {
    expect(parseKanban("gate add k_1 test -f notes.md && grep -q '0.4' notes.md")).toEqual({
      ok: true,
      command: { verb: 'gate add', taskId: 'k_1', command: "test -f notes.md && grep -q '0.4' notes.md", timeoutS: undefined },
    });
    expect(parseKanban('gate add k_1 --timeout 60 curl -fsS https://example.invalid/health')).toEqual({
      ok: true,
      command: { verb: 'gate add', taskId: 'k_1', command: 'curl -fsS https://example.invalid/health', timeoutS: 60 },
    });
    expect(parseKanban('gate add k_1 --timeout=45 make check')).toEqual({
      ok: true,
      command: { verb: 'gate add', taskId: 'k_1', command: 'make check', timeoutS: 45 },
    });
    expect(parseKanban('gate list k_1')).toEqual({ ok: true, command: { verb: 'gate list', taskId: 'k_1' } });
    expect(parseKanban('gate remove k_1 3')).toEqual({ ok: true, command: { verb: 'gate remove', taskId: 'k_1', gateId: 3 } });
  });

  it("reads a person's reports on their own task, the summary or the reason as written", () => {
    expect(parseKanban('task done k_1 the page is up\nlinks checked')).toEqual({
      ok: true,
      command: { verb: 'done', taskId: 'k_1', text: 'the page is up\nlinks checked' },
    });
    expect(parseKanban('task done k_1')).toEqual({ ok: true, command: { verb: 'done', taskId: 'k_1', text: '' } });
    expect(parseKanban('task approve k_1')).toEqual({ ok: true, command: { verb: 'approve', taskId: 'k_1', text: '' } });
    expect(parseKanban('task block k_1 which wiki?')).toEqual({ ok: true, command: { verb: 'block', taskId: 'k_1', text: 'which wiki?' } });
    expect(parseKanban('task changes k_1 cite the sources')).toEqual({
      ok: true,
      command: { verb: 'changes', taskId: 'k_1', text: 'cite the sources' },
    });
    for (const text of ['task done', 'task approve', 'task block k_1', 'task changes k_1  ', 'task review']) {
      expect(parseKanban(text)).toMatchObject({ ok: false, usage: expect.stringMatching(/^Usage: `\/kanban /) });
    }
  });

  it("reads a review's reviewer from a reviewer: line, anywhere in it, once", () => {
    expect(parseKanban('task review k_1 drafted the notes\nREVIEWER: @Bob Lee\nsee the wiki page')).toEqual({
      ok: true,
      command: { verb: 'review', taskId: 'k_1', summary: 'drafted the notes\nsee the wiki page', reviewer: '@Bob Lee' },
    });
    // A name at the end of the summary is the summary's.
    expect(parseKanban('task review k_1 asked the reviewer')).toEqual({
      ok: true,
      command: { verb: 'review', taskId: 'k_1', summary: 'asked the reviewer' },
    });
    // Indented, by spaces, tabs or a zero-width character a paste left: still the reviewer line.
    for (const indent of ['  ', '\t', ' \t ', '\u200b', '\u200b  ', '  \u200b', '\t\u2060 \ufeff']) {
      expect(parseKanban(`task review k_1 drafted the notes\n${indent}reviewer: @Bob Lee`)).toEqual({
        ok: true,
        command: { verb: 'review', taskId: 'k_1', summary: 'drafted the notes', reviewer: '@Bob Lee' },
      });
    }
    expect(parseKanban('task review k_1 x\nreviewer:')).toEqual({ ok: false, usage: '`reviewer:` needs a value.' });
    expect(parseKanban('task review k_1 x\nreviewer: a\nreviewer: b')).toEqual({ ok: false, usage: '`reviewer:` is given twice.' });
  });

  it('answers a wrong command line with its usage, and an unknown one escaped', () => {
    for (const text of [
      'task show',
      'task show k_1 k_2',
      'task assign k_1',
      'task link k_1',
      'task workspace k_1',
      'task comment k_1',
      'task unblock',
      'task list soon',
      'task list ready now',
      'gate',
      'gate add k_1',
      'gate add k_1 --timeout 0 true',
      'gate add k_1 --timeout x true',
      'gate add k_1 --timeout',
      'gate add k_1 --timeout=',
      'gate add k_1 --timeout= 30 true',
      'gate add k_1 --timeout=x true',
      'gate add k_1 --TIMEOUT 30',
      'gate add k_1 --timeout\n30 true',
      'gate add k_1 --timeout 30 --timeout 40 true',
      'gate add --timeout 30 make check',
      'gate add --timeout=30 make check',
      'gate remove k_1 one',
      'gate remove k_1 0',
    ]) {
      expect([text, parseKanban(text)]).toEqual([text, { ok: false, usage: expect.stringMatching(/^Usage: `\/kanban /) }]);
    }
    expect(parseKanban('frob_nicate k_1')).toEqual({
      ok: false,
      usage: 'Unknown `/kanban` command `frob\\_nicate`. `/kanban help` lists them.',
    });
  });

  it('takes a task command only after task: the old form, without it, is an unknown command', () => {
    for (const [text, verb] of <Array<[string, string]>>[
      ['new Write the release notes\nassignee: docs-writer', 'new'],
      ['list', 'list'],
      ['show k_1', 'show'],
      ['assign k_1 reviewer', 'assign'],
      ['link k_1 k_2', 'link'],
      ['workspace k_1 docs', 'workspace'],
      ['comment k_1 hello', 'comment'],
      ['unblock k_1', 'unblock'],
      ['stop k_1', 'stop'],
      ['archive k_1', 'archive'],
      ['done k_1', 'done'],
      ['block k_1 which wiki?', 'block'],
      ['review k_1', 'review'],
      ['approve k_1', 'approve'],
      ['changes k_1 cite the sources', 'changes'],
      ['NEW x', 'NEW'],
    ]) {
      expect(parseKanban(text)).toEqual({ ok: false, usage: `Unknown \`/kanban\` command \`${verb}\`. \`/kanban help\` lists them.` });
    }
    // In any case, as the other verbs are; and help, board and gate stay where they were.
    expect(parseKanban('TASK Show k_1')).toEqual({ ok: true, command: { verb: 'show', taskId: 'k_1' } });
    expect(parseKanban('task\nshow k_1')).toEqual({ ok: true, command: { verb: 'show', taskId: 'k_1' } });
    expect(parseKanban('help')).toEqual({ ok: true, command: { verb: 'help' } });
    expect(parseKanban('board list')).toEqual({ ok: true, command: { verb: 'board list', archived: false } });
    expect(parseKanban('gate list k_1')).toEqual({ ok: true, command: { verb: 'gate list', taskId: 'k_1' } });
  });

  it('answers task with no verb, or one it does not take, with the verbs it takes', () => {
    const takes =
      '`/kanban task` takes new, list, show, assign, link, workspace, comment, unblock, stop, archive, done, block, review, approve or changes. `/kanban help` lists them.';
    expect(parseKanban('task')).toEqual({ ok: false, usage: takes });
    expect(parseKanban('task   ')).toEqual({ ok: false, usage: takes });
    for (const text of ['task help', 'task board list', 'task gate list k_1', 'task task new x']) {
      expect(parseKanban(text)).toEqual({ ok: false, usage: takes });
    }
    expect(parseKanban('task frob_nicate k_1')).toEqual({ ok: false, usage: takes });
  });

  it('echoes an unknown verb masked and cut to 80 characters, on a character boundary', () => {
    // An emoji straddling the cut is dropped whole.
    const long = `${'a'.repeat(78)}\u{1F600}${'b'.repeat(200)}`;
    expect(parseKanban(long)).toEqual({
      ok: false,
      usage: `Unknown \`/kanban\` command \`${'a'.repeat(78)}…\`. \`/kanban help\` lists them.`,
    });
    // Masked before it is cut, so no start of a secret shows at the cut.
    addSecrets(['sk-verb-12345678']);
    expect(parseKanban(`${'c'.repeat(75)}sk-verb-12345678`)).toEqual({
      ok: false,
      usage: `Unknown \`/kanban\` command \`${'c'.repeat(75)}${MASK}\`. \`/kanban help\` lists them.`,
    });
  });
});
