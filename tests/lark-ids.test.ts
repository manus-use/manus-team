import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHAT_ID, THREAD_ID } from '../src/core/lark-ids.js';

/**
 * A chat's and a thread's id, as a terminal names them (kanban spec §22.1, the
 * cron spec §6.2): checked for shape, in one place the cron CLI, the
 * operator's board commands and the board's service share.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

describe('CHAT_ID and THREAD_ID', () => {
  it('take oc_ and omt_ with 1 to 64 letters and digits, and nothing else', () => {
    for (const ok of ['oc_a', 'oc_TEAM9', `oc_${'x'.repeat(64)}`]) expect(CHAT_ID.test(ok), ok).toBe(true);
    for (const no of ['oc_', 'oc_a-b', 'oc_a_b', ` oc_a`, 'oc_a\n', `oc_${'x'.repeat(65)}`, 'omt_a', 'chat']) expect(CHAT_ID.test(no), no).toBe(false);
    for (const ok of ['omt_a', 'omt_Topic7', `omt_${'x'.repeat(64)}`]) expect(THREAD_ID.test(ok), ok).toBe(true);
    for (const no of ['omt_', 'omt_a b', 'oc_a', `omt_${'x'.repeat(65)}`, 'thread']) expect(THREAD_ID.test(no), no).toBe(false);
  });

  it('are imported by the cron CLI, and no module of src/kanban imports src/cli', () => {
    expect(readFileSync(join(SRC, 'cli', 'cron.ts'), 'utf8')).toMatch(/import \{ CHAT_ID[^}]*\} from '\.\.\/core\/lark-ids\.js';/);
    expect(readFileSync(join(SRC, 'cli', 'cron.ts'), 'utf8')).not.toMatch(/const CHAT_ID =/);
    for (const name of readdirSync(join(SRC, 'kanban')).filter((n) => n.endsWith('.ts'))) {
      expect(readFileSync(join(SRC, 'kanban', name), 'utf8'), name).not.toMatch(/from '\.\.\/cli\//);
    }
  });
});
