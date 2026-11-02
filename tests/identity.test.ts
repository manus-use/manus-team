import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from '../src/identity.js';

/**
 * The product's name lives in one constant, and the package name must agree
 * with it. Two copies of a name drift: the old one kept surviving in the
 * strings the gateway sends to Lark and to agents after the docs had moved on.
 */
describe('product identity', () => {
  it('is manus-team', () => {
    expect(PRODUCT_NAME).toBe('manus-team');
  });

  it('matches the package name', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string;
    };
    expect(pkg.name).toBe(PRODUCT_NAME);
  });
});
