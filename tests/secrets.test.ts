import { beforeEach, describe, expect, it } from 'vitest';
import {
  MASK,
  addSecrets,
  clearSecrets,
  redactKnownSecrets,
  redactValues,
  removeSecrets,
  withholdSecretPrefix,
} from '../src/secrets.js';

beforeEach(() => clearSecrets());

describe('redactKnownSecrets', () => {
  it('replaces every occurrence of a known secret', () => {
    addSecrets(['sk-test-123456']);
    expect(redactKnownSecrets('a sk-test-123456 b sk-test-123456')).toBe(`a ${MASK} b ${MASK}`);
  });

  it('ignores values shorter than 8 characters, which are not secrets', () => {
    addSecrets(['true', '1', 'short7!']);
    expect(redactKnownSecrets('true 1 short7!')).toBe('true 1 short7!');
  });

  it('masks the longer of two overlapping secrets whole', () => {
    addSecrets(['abcdefgh', 'abcdefgh-longer']);
    expect(redactKnownSecrets('x abcdefgh-longer y')).toBe(`x ${MASK} y`);
  });

  it('stops masking a secret once it is removed', () => {
    addSecrets(['token-abcdefgh']);
    removeSecrets(['token-abcdefgh']);
    expect(redactKnownSecrets('token-abcdefgh')).toBe('token-abcdefgh');
  });
});

describe('withholdSecretPrefix', () => {
  it('drops trailing text that is the start of a secret, four characters or longer', () => {
    addSecrets(['sk-test-123456']);
    expect(withholdSecretPrefix('the key is sk-te')).toBe('the key is ');
    expect(withholdSecretPrefix('the key is sk-')).toBe('the key is sk-');
    expect(withholdSecretPrefix('nothing here')).toBe('nothing here');
  });
});

describe('redactValues', () => {
  it('masks string values at any depth, value by value, and leaves identifying keys alone', () => {
    addSecrets(['secret-"quoted"-value']);
    const out = redactValues({
      approvalId: 'secret-"quoted"-value',
      message: 'got secret-"quoted"-value',
      nested: { list: ['secret-"quoted"-value', 3, true, null] },
    });
    expect(out).toEqual({
      approvalId: 'secret-"quoted"-value',
      message: `got ${MASK}`,
      nested: { list: [MASK, 3, true, null] },
    });
  });

  it('returns the input untouched when no secret is known', () => {
    const payload = { message: 'anything' };
    expect(redactValues(payload)).toBe(payload);
  });
});
