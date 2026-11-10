import { describe, expect, it } from 'vitest';
import { parseEnvFile } from '../src/dotenv.js';

/**
 * A deliberately small format. Anything outside it is an error naming the line,
 * not a guess -- and an error never quotes a value, because the values are the
 * secrets this file exists to hold.
 */
function values(text: string): Record<string, string> {
  const r = parseEnvFile(text, '.env');
  if ('error' in r) throw new Error(r.error);
  return r.values;
}

function error(text: string): string {
  const r = parseEnvFile(text, '.env');
  if (!('error' in r)) throw new Error('expected an error');
  return r.error;
}

describe('parseEnvFile', () => {
  it('reads KEY=value lines, skipping blank lines and comments', () => {
    expect(values('# tokens\n\nGH_TOKEN=abc\nAPI_URL = https://x.example/v1 \n')).toEqual({
      GH_TOKEN: 'abc',
      API_URL: 'https://x.example/v1',
    });
  });

  it('removes one pair of matching quotes', () => {
    expect(values(`A="has spaces"\nB='single'\nC="it's"`)).toEqual({
      A: 'has spaces',
      B: 'single',
      C: "it's",
    });
  });

  it('takes a dollar sign literally, because nothing is expanded', () => {
    expect(values('A=$HOME/x')).toEqual({ A: '$HOME/x' });
  });

  it('refuses a control character anywhere on a line, NUL included, naming the line only', () => {
    for (const c of ['\u0000', '\u0007', '\u001b', '\u007f', '\u000b']) {
      const message = error(`A=1\nB=secret${c}value\n`);
      expect(message).toBe('.env:2: the line holds a control character; only printable text and tabs are allowed');
    }
    expect(error('# a comment\u0000\n')).toMatch(/^\.env:1: the line holds a control character/);
    // A tab is text, and a CRLF line ending is a line ending.
    expect(values('A=x\ty\r\nB=2\r\n')).toEqual({ A: 'x\ty', B: '2' });
  });

  it('refuses export, naming the line', () => {
    expect(error('A=1\nexport B=2')).toMatch(/^\.env:2: `export` is not supported/);
  });

  it('refuses a line with no equals sign', () => {
    expect(error('A=1\njust text')).toMatch(/^\.env:2: expected KEY=value/);
  });

  it('refuses a name that is not a variable name, without quoting it', () => {
    const message = error('1A=x');
    expect(message).toMatch(/^\.env:1: the text before '=' is not a valid variable name/);
    expect(message).not.toContain('1A');
  });

  it('never quotes a malformed line, which may be a pasted secret', () => {
    const message = error('abc+def==xyz');
    expect(message).toMatch(/^\.env:1: the text before '=' is not a valid variable name/);
    expect(message).not.toContain('abc+def');
    expect(message).not.toContain('xyz');
  });

  it('refuses an unterminated quote', () => {
    expect(error('A="never closed')).toMatch(/^\.env:1: unterminated quote/);
  });

  it('refuses a variable set twice', () => {
    expect(error('A=1\nA=2')).toMatch(/^\.env:2: A is set twice/);
  });

  it('never puts a value in an error', () => {
    expect(error('A="sk-secret-value')).not.toContain('sk-secret-value');
    expect(error('A=sk-secret-value\nA=sk-other')).not.toContain('sk-');
  });
});
