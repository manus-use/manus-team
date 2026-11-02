/**
 * The format of a role's `.env`.
 *
 * `KEY=value` lines, blank lines, and comments starting with `#`. A value may be
 * wrapped in one pair of single or double quotes, which are removed. Nothing is
 * expanded, there is no `export`, and there are no multi-line values. Anything
 * else is an error naming the line: a guess at what an unusual line meant is how
 * a secret ends up half-read.
 *
 * Errors name lines and valid keys, never values or other line text -- the
 * values are secrets, and a malformed line may be one.
 */

export type EnvFileResult = { values: Record<string, string> } | { error: string };

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvFile(text: string, source: string): EnvFileResult {
  const values: Record<string, string> = {};
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    const at = `${source}:${i + 1}`;
    if (line === '' || line.startsWith('#')) continue;

    if (line.startsWith('export ')) {
      return { error: `${at}: \`export\` is not supported; write NAME=value` };
    }
    const eq = line.indexOf('=');
    if (eq <= 0) return { error: `${at}: expected KEY=value` };

    const key = line.slice(0, eq).trim();
    if (!VARIABLE_NAME.test(key)) {
      // Not even the name is quoted: a line that is not KEY=value may be the
      // secret itself, a pasted token whose own '=' padding looks like a separator.
      return {
        error: `${at}: the text before '=' is not a valid variable name (letters, digits, '_'; not starting with a digit)`,
      };
    }

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length < 2 || value[value.length - 1] !== quote) {
        return { error: `${at}: unterminated quote` };
      }
      value = value.slice(1, -1);
    }

    if (Object.hasOwn(values, key)) return { error: `${at}: ${key} is set twice` };
    values[key] = value;
  }

  return { values };
}
