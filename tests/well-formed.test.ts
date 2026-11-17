import { describe, expect, it } from 'vitest';

/**
 * `String.prototype.isWellFormed`, which the DAG's checks use (workflows spec §5), is
 * in the build's lib: `ES2024.String` beside `ES2023`. A lone surrogate, which
 * JSON's `\ud800` escape can give, is no text.
 */
describe('isWellFormed', () => {
  it('tells text from a lone surrogate', () => {
    expect('vendor-eval'.isWellFormed()).toBe(true);
    expect('Évaluer 🙂'.isWellFormed()).toBe(true);
    expect('\ud800'.isWellFormed()).toBe(false);
    expect((JSON.parse('"a\\udc00b"') as string).isWellFormed()).toBe(false);
  });
});
