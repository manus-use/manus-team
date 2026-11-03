import { describe, expect, it } from 'vitest';
import { resolveTaskWorkspace } from '../src/kanban/workspace.js';

describe('resolveTaskWorkspace', () => {
  it("uses the task's own workspace first", () => {
    expect(resolveTaskWorkspace({ own: 'docs', roleWorkspace: 'ops', upstream: ['web'] })).toEqual({
      workspace: 'docs',
    });
  });

  it("uses a role's explicit workspace over its parents'", () => {
    // A docs-writer with workspace: docs works in docs whatever its parents were.
    expect(resolveTaskWorkspace({ own: null, roleWorkspace: 'docs', upstream: ['web'] })).toEqual({
      workspace: 'docs',
    });
  });

  it("uses the parents' workspace when they share one", () => {
    // So a downstream review reviews where the work was done.
    expect(resolveTaskWorkspace({ own: null, roleWorkspace: undefined, upstream: ['web', 'web'] })).toEqual({
      workspace: 'web',
    });
  });

  it('ignores parents whose workspace was never fixed', () => {
    expect(resolveTaskWorkspace({ own: null, roleWorkspace: undefined, upstream: [null, 'web'] })).toEqual({
      workspace: 'web',
    });
    expect(resolveTaskWorkspace({ own: null, roleWorkspace: undefined, upstream: [null] })).toEqual({
      workspace: 'default',
    });
  });

  it('refuses to guess when the parents disagree, naming their workspaces', () => {
    expect(resolveTaskWorkspace({ own: null, roleWorkspace: undefined, upstream: ['web', 'api', 'web'] })).toEqual({
      conflict: ['api', 'web'],
    });
  });

  it('falls back to default with nothing else to go on', () => {
    expect(resolveTaskWorkspace({ own: null, roleWorkspace: undefined, upstream: [] })).toEqual({
      workspace: 'default',
    });
  });
});
