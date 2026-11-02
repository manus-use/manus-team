import { describe, expect, it } from 'vitest';
import { isReservedRoleName, nameProblem } from '../src/names.js';

/**
 * Role and workspace names become paths, assignee values typed in chat, and
 * keys stored in the database, so one grammar keeps all three safe: no `/` or
 * `..` to leave a directory, no `:` to look like a person's principal, one case
 * so two names cannot differ only by it.
 */
describe('nameProblem', () => {
  it('accepts lowercase letters, digits and hyphens, starting with a letter', () => {
    for (const name of ['default', 'implementer', 'docs-writer', 'r2', 'a'.repeat(40)]) {
      expect(nameProblem('role', name)).toBeUndefined();
    }
  });

  it('refuses anything else, and says why', () => {
    for (const name of ['Reviewer', '2fast', '../roles', 'a/b', 'a:b', 'a.b', '-x', '', 'a'.repeat(41)]) {
      expect(nameProblem('workspace', name)).toMatch(/workspace name .* must be lowercase/);
    }
  });
});

describe('isReservedRoleName', () => {
  it('reserves the driver ids, which old sessions store where a role name now goes', () => {
    expect(isReservedRoleName('acp')).toBe(true);
    expect(isReservedRoleName('structured-cli')).toBe(true);
    expect(isReservedRoleName('implementer')).toBe(false);
  });
});
