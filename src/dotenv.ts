import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { ConfigError } from './config.js';

/**
 * The format of a role's `.env`, and of the gateway's own (`gateway-env.ts`).
 *
 * `KEY=value` lines, blank lines, and comments starting with `#`. A value may be
 * wrapped in one pair of single or double quotes, which are removed. Nothing is
 * expanded, there is no `export`, there are no multi-line values, and there is
 * no control character but the tab (a NUL is one). Anything else is an error naming the line: a guess at what an unusual line meant is how
 * a secret ends up half-read.
 *
 * Errors name lines and valid keys, never values or other line text -- the
 * values are secrets, and a malformed line may be one.
 */

export type EnvFileResult = { values: Record<string, string> } | { error: string };

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** C0 controls but the tab, and DEL. A CR before the LF is the line ending, removed by the split. */
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export function parseEnvFile(text: string, source: string): EnvFileResult {
  const values: Record<string, string> = {};
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const at = `${source}:${i + 1}`;
    // Before anything else, comments included: a NUL or an escape in a value is
    // a pasted mistake, cut short or rewritten by whatever reads it next, and a
    // terminal would act on one in an error that quoted it.
    if (CONTROL.test(raw)) {
      return { error: `${at}: the line holds a control character; only printable text and tabs are allowed` };
    }
    const line = raw.trim();
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

/**
 * A `.env` file's text, or undefined when there is none: a role's, or the
 * gateway's. The files the gateway reads secrets from, so each is checked at
 * every point where it could leak or travel: it must be a regular file (a
 * symlink could point anywhere), owned by the gateway's user, and readable by
 * nobody else. A loose mode is refused, not fixed: a file that was readable may
 * already have been read, and tightening it quietly hides that.
 *
 * `what` names the file in the symlink refusal: "a role's .env".
 */
export function readPrivateEnvFile(path: string, what: string): string | undefined {
  // Opened once and checked on that descriptor, so the file that passes the
  // checks is the file that is read. O_NOFOLLOW refuses a symlink at the open
  // itself; O_NONBLOCK keeps a FIFO from hanging the open before fstat sees it.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') {
      throw new ConfigError(`${path} is a symlink; ${what} must be a regular file, so it cannot point anywhere else`);
    }
    throw new ConfigError(`cannot inspect ${path}: ${(err as Error).message}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ConfigError(`${path} is not a regular file`);
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new ConfigError(`${path} is owned by another user; it must belong to the user the gateway runs as`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new ConfigError(
        `${path} can be read or written by other users (mode ${(stat.mode & 0o777).toString(8)}); ` +
          'it must be readable and writable only by its owner (for example 0600). The gateway does not change it itself: a file that was readable may already have been read.',
      );
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
