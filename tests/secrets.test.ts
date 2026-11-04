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

  it('works on raw text, so a secret inside a longer one cannot hide the longer one', () => {
    addSecrets(['abcdefgh', 'abcdefgh-longer-secret-value']);
    expect(withholdSecretPrefix('k abcdefgh-longer-secr')).toBe('k ');
  });

  it('never cuts a complete secret part-way: the cut moves to its start', () => {
    // The tail of the complete one is the start of the other.
    addSecrets(['abcdefgh', 'efgh-other-value']);
    expect(withholdSecretPrefix('k abcdefgh')).toBe('k ');
  });

  it('keeps a complete secret that ends before the cut', () => {
    addSecrets(['abcdefgh', 'sk-test-123456']);
    expect(withholdSecretPrefix('k abcdefgh and sk-te')).toBe('k abcdefgh and ');
  });
});

describe('redactKnownSecrets: overlaps', () => {
  it('masks two secrets whose occurrences overlap as one span', () => {
    addSecrets(['abcdefgh12', '12345678xy']);
    expect(redactKnownSecrets('k abcdefgh12345678xy z')).toBe(`k ${MASK} z`);
  });

  it('masks overlapping occurrences of the same secret', () => {
    addSecrets(['abababab']);
    expect(redactKnownSecrets('k ababababab z')).toBe(`k ${MASK} z`);
  });
});

describe('addSecrets', () => {
  it('also knows a secret with its control characters stripped, as the escapers see it', () => {
    addSecrets(['sk-ctrl\u0007-abcdef']);
    expect(redactKnownSecrets('k sk-ctrl-abcdef')).toBe(`k ${MASK}`);
    removeSecrets(['sk-ctrl\u0007-abcdef']);
    expect(redactKnownSecrets('k sk-ctrl-abcdef')).toBe('k sk-ctrl-abcdef');
  });

  it('ignores a value containing the mask character', () => {
    addSecrets(['abc•defghij']);
    expect(redactKnownSecrets('k abc•defghij')).toBe('k abc•defghij');
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

  it('still walks an object or array under an identifying key', () => {
    addSecrets(['sk-test-123456']);
    expect(redactValues({ owner: { note: 'sk-test-123456' }, role: ['sk-test-123456'] })).toEqual({
      owner: { note: MASK },
      role: [MASK],
    });
  });

  it('leaves the keys a caller names as identifying alone, for that call only', () => {
    addSecrets(['implementer-12345']);
    const payload = { assignee: 'implementer-12345', taskId: 'implementer-12345', summary: 'implementer-12345' };
    expect(redactValues(payload, new Set(['assignee', 'taskId']))).toEqual({
      assignee: 'implementer-12345',
      taskId: 'implementer-12345',
      summary: MASK,
    });
    expect(redactValues(payload)).toEqual({ assignee: MASK, taskId: MASK, summary: MASK });
  });

  it('returns the input untouched when no secret is known', () => {
    const payload = { message: 'anything' };
    expect(redactValues(payload)).toBe(payload);
  });
});

describe('removeSecrets: reference-counted', () => {
  it('keeps a value masked while another registration holds it, as a configured secret equal to a token', () => {
    addSecrets(['shared-value-123']);
    addSecrets(['shared-value-123']);
    removeSecrets(['shared-value-123']);
    expect(redactKnownSecrets('k shared-value-123')).toBe(`k ${MASK}`);
    removeSecrets(['shared-value-123']);
    expect(redactKnownSecrets('k shared-value-123')).toBe('k shared-value-123');
  });

  it('counts a stripped form two values share', () => {
    addSecrets(['sk-ctrl\u0007-abcdef', 'sk-ctrl-abcdef']);
    removeSecrets(['sk-ctrl\u0007-abcdef']);
    expect(redactKnownSecrets('k sk-ctrl-abcdef')).toBe(`k ${MASK}`);
  });

  it('changes nothing when a value that was never added is removed', () => {
    addSecrets(['sk-test-123456']);
    removeSecrets(['other-value-123', 'sk-test-123456', 'sk-test-123456']);
    expect(redactKnownSecrets('k sk-test-123456')).toBe('k sk-test-123456');
    addSecrets(['sk-test-123456']);
    expect(redactKnownSecrets('k sk-test-123456')).toBe(`k ${MASK}`);
  });
});
