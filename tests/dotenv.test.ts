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

  it('refuses export, naming the line', () => {
    expect(error('A=1\nexport B=2')).toMatch(/^\.env:2: `export` is not supported/);
  });

  it('refuses a line with no equals sign', () => {
    expect(error('A=1\njust text')).toMatch(/^\.env:2: expected KEY=value/);
  });

  it('refuses a name that is not a variable name', () => {
    expect(error('1A=x')).toMatch(/^\.env:1: "1A" is not a valid variable name/);
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
