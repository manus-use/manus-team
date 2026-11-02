import { beforeEach, describe, expect, it } from 'vitest';
import {
  escapeMd,
  forDisplay,
  forMarkdown,
  forPlainText,
  mask,
  stripControl,
  truncate,
} from '../src/channel/escape.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';

const NUL = '\u0000';
const BEL = '\u0007';
const C1 = '\u009f';
const NONCHAR = '\ufffe';

/**
 * True when every `<` and `>` is escaped -- preceded by an odd-length run of
 * backslashes. An even run (including zero) is a literal backslash, or none,
 * followed by a live tag bracket.
 */
function bracketsInert(text: string): boolean {
  for (const m of text.matchAll(/(\\*)[<>]/g)) {
    if ((m[1] ?? '').length % 2 === 0) return false;
  }
  return true;
}

describe('forMarkdown', () => {
  // The agent's answer is markdown and should render as markdown. What it must
  // not do is open a Feishu tag, which is how a mention is spoofed.
  it('leaves the agent its markdown', () => {
    const text = 'validate **DAG-based pipelines**, _carefully_, with `code` and [docs](https://example.com)';
    expect(forMarkdown(text)).toBe(text);
  });

  it('leaves a fenced code block intact', () => {
    const text = '```ts\nconst x = a * b;\n```';
    expect(forMarkdown(text)).toBe(text);
  });

  it('neutralizes a mention tag', () => {
    expect(bracketsInert(forMarkdown('<at id=all></at>'))).toBe(true);
  });

  it('neutralizes the other tags too, not just mentions', () => {
    const out = forMarkdown('<font color="red">x</font> <text_tag>y</text_tag>');
    expect(bracketsInert(out)).toBe(true);
  });

  it('does not let a backslash in front of a bracket cancel its escape', () => {
    // `\<` naively escaped becomes `\\<`: an escaped backslash, then a live `<`.
    for (const input of ['\\<at id=all></at>', '\\\\<at id=all>', 'a\\>b']) {
      expect(bracketsInert(forMarkdown(input))).toBe(true);
    }
  });

  it('leaves backslashes that are not next to a bracket alone', () => {
    // The agent's own markdown escapes, like a literal asterisk, keep working.
    expect(forMarkdown('2 \\* 3 = 6')).toBe('2 \\* 3 = 6');
  });

  it('strips control characters, like the full escaper', () => {
    expect(forMarkdown(`a${NUL}b${BEL}c`)).toBe('abc');
  });
});

describe('escapeMd', () => {
  it('escapes angle brackets, which is the mention-injection vector', () => {
    // The whole reason this escaper exists: `<at id=all></at>` rendered raw is a
    // room-wide notification the gateway never authorized.
    const out = escapeMd('<at id=all></at>');
    // No unescaped `<` survives. Asserting on the absence of the substring `<at`
    // would fail on the correct output, since `\<at` still contains it.
    expect(out).not.toMatch(/(^|[^\\])</);
    expect(out).toBe('\\<at id=all\\>\\</at\\>');
  });

  it('escapes the backslash first, so other escapes are not doubled', () => {
    // If `\` were escaped last, `*` would become `\\*` -- a literal backslash and
    // an unescaped asterisk, i.e. the injection the escaper was meant to prevent.
    expect(escapeMd('*')).toBe('\\*');
    expect(escapeMd('\\*')).toBe('\\\\\\*');
  });

  it('never leaves raw markup behind, even applied twice', () => {
    const twice = escapeMd(escapeMd('**bold** <at id=all></at>'));
    expect(twice).not.toMatch(/(^|[^\\])\*/);
    expect(twice).not.toMatch(/(^|[^\\])</);
  });
});

describe('stripControl', () => {
  it('keeps tab, newline and carriage return', () => {
    expect(stripControl('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('drops C0, C1 and non-characters', () => {
    expect(stripControl(`a${NUL}b${BEL}c${C1}d${NONCHAR}e`)).toBe('abcde');
  });
});

describe('forDisplay', () => {
  it('strips before escaping, so a control byte cannot split an escape', () => {
    // Escaping first would insert `\*`, and stripping afterwards could remove a
    // character from inside the sequence it had just written.
    expect(forDisplay(`*${NUL}*`)).toBe('\\*\\*');
  });
});

describe('forPlainText', () => {
  it('strips control characters but adds no markdown escapes', () => {
    // plain_text has no markup to inject into, so escaping would only show the
    // user backslashes that are not in the agent's text.
    expect(forPlainText(`rm -rf * <at>${BEL}`)).toBe('rm -rf * <at>');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('always announces that it cut something', () => {
    const out = truncate('x'.repeat(200), 50);
    expect(out).toHaveLength(50);
    expect(out.endsWith('… (truncated)')).toBe(true);
  });
});

describe('mask', () => {
  it('reveals nothing usable', () => {
    expect(mask('abc')).toBe('****');
    expect(mask('supersecrettoken')).toBe('sup********');
    expect(mask('supersecrettoken')).not.toContain('secret');
  });
});

describe('the escapers mask known secrets before escaping', () => {
  beforeEach(() => {
    clearSecrets();
    addSecrets(['sk_live_abc123']);
  });

  it('forDisplay masks a secret that escaping would otherwise have changed', () => {
    // Escaping first would turn the `_` into `\_`, and the secret would no longer match.
    expect(forDisplay('key sk_live_abc123')).toBe(`key ${MASK}`);
  });

  it('forMarkdown masks and keeps the markdown', () => {
    expect(forMarkdown('**key** sk_live_abc123')).toBe(`**key** ${MASK}`);
  });

  it('forPlainText masks, even a secret with a control character inside it', () => {
    expect(forPlainText('sk_live_abc123')).toBe(MASK);
    // Stripped first, so the control character cannot stop the secret matching.
    expect(forPlainText('sk_live\u0007_abc123')).toBe(MASK);
  });
});
