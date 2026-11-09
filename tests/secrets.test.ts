import { beforeEach, describe, expect, it } from 'vitest';
import {
  MASK,
  addSecrets,
  clearSecrets,
  redactKnownSecrets,
  redactValues,
  removeSecrets,
  withholdSecretPrefix,
  withholdSecretSuffix,
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

describe('withholdSecretSuffix', () => {
  it('drops leading text that is the end of a secret, four characters or longer', () => {
    addSecrets(['sk-test-123456']);
    expect(withholdSecretSuffix('3456 is the key')).toBe(' is the key');
    expect(withholdSecretSuffix('456 is the key')).toBe('456 is the key');
    expect(withholdSecretSuffix('nothing here')).toBe('nothing here');
  });

  it('works on raw text, so a secret inside a longer one cannot hide the longer one', () => {
    addSecrets(['longer-secret-value', 'longer-secret-value-abcdefgh']);
    expect(withholdSecretSuffix('ret-value-abcdefgh k')).toBe(' k');
  });

  it('never cuts a complete secret part-way: the cut moves to its end', () => {
    // The start of the complete one is the end of the other.
    addSecrets(['abcdefgh', 'other-value-abcd']);
    expect(withholdSecretSuffix('abcdefgh k')).toBe(' k');
  });

  it('keeps a complete secret that starts after the cut', () => {
    addSecrets(['abcdefgh', 'sk-test-123456']);
    expect(withholdSecretSuffix('3456 and abcdefgh k')).toBe(' and abcdefgh k');
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

/**
 * The characters that show nothing: the bidi controls, the zero-width
 * characters and the direction marks. Split by one, a secret still reads whole
 * on screen, so it is matched as if they were not there; text outside a secret
 * keeps them, since a joined emoji and right-to-left text need them.
 */
const INVISIBLES: Array<[string, string]> = [
  ['a left-to-right embedding', '\u202A'],
  ['a right-to-left embedding', '\u202B'],
  ['a pop', '\u202C'],
  ['a left-to-right override', '\u202D'],
  ['a right-to-left override', '\u202E'],
  ['a left-to-right isolate', '\u2066'],
  ['a right-to-left isolate', '\u2067'],
  ['a first-strong isolate', '\u2068'],
  ['a pop of an isolate', '\u2069'],
  ['a zero-width space', '\u200B'],
  ['a zero-width non-joiner', '\u200C'],
  ['a zero-width joiner', '\u200D'],
  ['a byte order mark', '\uFEFF'],
  ['a left-to-right mark', '\u200E'],
  ['a right-to-left mark', '\u200F'],
  ['an Arabic letter mark', '\u061C'],
];

describe('redactKnownSecrets: invisible characters', () => {
  it.each(INVISIBLES)('masks a secret split by %s, the character with it', (_name, c) => {
    addSecrets(['sk-live-1234567890']);
    expect(redactKnownSecrets(`key sk-live-12${c}34567890 end`)).toBe(`key ${MASK} end`);
    expect(redactKnownSecrets(`key ${c}sk-live-${c}${c}1234567890${c}`)).toBe(`key ${c}${MASK}${c}`);
  });

  it('keeps them in text outside a secret: a joined emoji, a mark in right-to-left text', () => {
    addSecrets(['sk-live-1234567890']);
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const hebrew = 'שלום\u200F 42';
    expect(redactKnownSecrets(`${family} ${hebrew} sk-live-1234567890`)).toBe(`${family} ${hebrew} ${MASK}`);
    expect(redactKnownSecrets(`${family} ${hebrew}`)).toBe(`${family} ${hebrew}`);
  });

  it('masks two secrets touching but for an invisible character as one span', () => {
    addSecrets(['abcdefgh12', 'zyxwvuts98']);
    expect(redactKnownSecrets('k abcdefgh12\u200Bzyxwvuts98 z')).toBe(`k ${MASK} z`);
  });

  it('masks a secret registered with an invisible character, however it is written', () => {
    addSecrets(['sk-zw\u200B-abcdefgh']);
    expect(redactKnownSecrets('k sk-zw\u200B-abcdefgh')).toBe(`k ${MASK}`);
    expect(redactKnownSecrets('k sk-zw-abcdefgh')).toBe(`k ${MASK}`);
    expect(redactKnownSecrets('k sk-zw-abc\u2066defgh')).toBe(`k ${MASK}`);
  });

  it('withholds the start of a secret split by one while it streams, and the end of one when cut', () => {
    addSecrets(['sk-test-123456']);
    expect(withholdSecretPrefix('the key is sk-t\u200Be')).toBe('the key is ');
    expect(withholdSecretSuffix('t-12\u200B3456 and more')).toBe(' and more');
  });

  it('never cuts inside a secret complete on screen, for one that holds an invisible character itself', () => {
    // Found by fuzzing: the cut as written falls inside the secret as it reads on screen.
    const prefixSecret = '$\u202A$(?*[\\[$$(';
    addSecrets([prefixSecret]);
    const streamed = '$\u202A\u2069\u200C$\u202A$(?\u2068*[\u2069\\[\u200C$\u202A$(';
    const kept = withholdSecretPrefix(streamed);
    expect(kept).toBe('$\u202A\u2069\u200C');
    expect(redactKnownSecrets(kept)).not.toMatch(/[(?*[\\]/);
    clearSecrets();
    addSecrets(['321133\u202E21']);
    const tail = withholdSecretSuffix('3\u202E2113321 x');
    expect(tail).toBe(' x');
    expect(redactKnownSecrets(tail)).not.toMatch(/[123]/);
  });
});
