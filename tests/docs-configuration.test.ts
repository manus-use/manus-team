import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { ConfigError, GATEWAY_ENV_NAMES, loadConfig } from '../src/config.js';
import { loadRoleDir } from '../src/roles.js';

/**
 * docs/configuration.md, kept true to the parser.
 *
 * Its reference must list every key the config file accepts, and nothing else.
 * src/config.ts has no exported list of keys: each section passes its own list
 * to `reject`, inline, and a key unknown to a section is refused with that list,
 * `unknown setting <key> (known: a, b, c)`. So the keys are found by asking the
 * parser, as an operator who mistypes one does: a file with a key no section
 * knows is loaded at each level, and the refusal names the keys there. A key
 * whose value is refused some other way, as not a string or not a list, holds a
 * value rather than a section. A level whose entries are names the operator
 * picks, as `workspaces:` is, refuses no name: it is found by going one level
 * further, and is written `<name>` in the reference, as both the plain form and
 * the mapping. A key added to any section's list is then missing from the
 * reference here, with no list in this test to update.
 *
 * A role's config.yaml is found the same way, through `loadRoleDir`.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const read = (doc: string): string => readFileSync(join(REPO, doc), 'utf8');
const GUIDE = 'docs/configuration.md';

/** A key no section knows, and one that looks like no credential. */
const PROBE = 'zz_unknown';
/** The name a probe gives an entry of a level of names. */
const NAME = 'probe';

type Loader = (yaml: string) => void;

/** `value` nested under `path`, `<name>` given as the probe's name. */
function nest(path: readonly string[], value: unknown): unknown {
  return path.reduceRight<unknown>((inner, key) => ({ [key === '<name>' ? NAME : key]: inner }), value);
}

/** The keys the parser knows at `path`, or undefined when what is there is not a section. */
function knownAt(load: Loader, path: readonly string[]): string[] | undefined {
  const at = [...path, PROBE].map((k) => (k === '<name>' ? NAME : k)).join('.');
  try {
    load(stringify(nest(path, { [PROBE]: 1 })));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const m = /unknown setting (\S+) \(known: ([^)]*)\)/.exec(err.message);
    if (m !== null && m[1] === at) return (m[2] ?? '').split(', ');
    return undefined;
  }
  throw new Error(`a file with ${at} loaded`);
}

/** Every key the parser accepts under `path`, as the reference writes them. */
function acceptedKeys(load: Loader, path: readonly string[] = []): string[] {
  const known = knownAt(load, path);
  if (known !== undefined) return known.flatMap((key) => acceptedKeys(load, [...path, key]));
  if (path.length > 0 && knownAt(load, [...path, '<name>']) !== undefined) {
    const named = [...path, '<name>'];
    return [named.join('.'), ...acceptedKeys(load, named)];
  }
  return [path.join('.')];
}

const gatewayLoad: Loader = (yaml) => {
  loadConfig({ MT_HOME: '/nonexistent/mt-home', LARK_APP_SECRET: 'app-secret-value' }, () => yaml);
};

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

function roleDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'docs-configuration-'));
  roots.push(root);
  const dir = join(root, 'roles', 'analyst');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function roleLoad(dir: string): Loader {
  return (yaml) => {
    writeFileSync(join(dir, 'config.yaml'), yaml);
    loadRoleDir('analyst', dir, {}, new Set(['default']));
  };
}

/** The lines of a markdown file from `heading` to the next heading of its level or higher. */
function section(text: string, heading: string): string[] {
  const lines = text.split('\n');
  const at = lines.indexOf(heading);
  if (at === -1) throw new Error(`no ${heading}`);
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const end = lines.findIndex((l, i) => i > at && /^#+ /.test(l) && (/^#+/.exec(l)?.[0].length ?? 0) <= level);
  return lines.slice(at + 1, end === -1 ? undefined : end);
}

/** The reference's tables: the key in each row's first cell, and every variable named in a row, by subsection. */
function reference(): { keys: Map<string, string[]>; variables: Set<string> } {
  const keys = new Map<string, string[]>();
  const variables = new Set<string>();
  let heading = '';
  for (const line of section(read(GUIDE), '## 7. Full reference')) {
    if (line.startsWith('### ')) heading = line.slice(4);
    if (!line.startsWith('| `')) continue;
    const key = /^\| `([^`]+)`/.exec(line)?.[1] ?? '';
    keys.set(heading, [...(keys.get(heading) ?? []), key]);
    for (const m of line.matchAll(/`((?:MT|LARK)_[A-Z0-9_]+(?:<NAME>)?)`/g)) variables.add(m[1] ?? '');
  }
  return { keys, variables };
}

const NOT_FILE_KEYS = new Set(['Environment only', "A role's config.yaml"]);

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

describe("docs/configuration.md's reference", () => {
  it('lists every key the config file accepts, and only those', () => {
    const parser = sorted(acceptedKeys(gatewayLoad));
    // A sanity check on the probe itself: a section, a level of names and a subsection are each found.
    expect(parser).toEqual(expect.arrayContaining(['lark.appId', 'workspaces.<name>.isolated', 'kanban.wake.per_hour', 'cron.tz']));
    const documented = sorted([...reference().keys].filter(([h]) => !NOT_FILE_KEYS.has(h)).flatMap(([, k]) => k));
    expect(documented).toEqual(parser);
  });

  it("lists every key a role's config.yaml accepts, and only those", () => {
    const parser = sorted(acceptedKeys(roleLoad(roleDir())));
    expect(parser).toEqual(expect.arrayContaining(['max_running', 'agent.skills']));
    expect(sorted(reference().keys.get("A role's config.yaml") ?? [])).toEqual(parser);
  });

  it('names every variable the gateway reads its settings from, and only those', () => {
    expect(sorted(reference().variables)).toEqual(sorted([...GATEWAY_ENV_NAMES, 'MT_AGENT_ENV_<NAME>']));
  });

  it('is the one table: the README keeps none of its rows', () => {
    const readme = section(read('README.md'), '### Configuration');
    expect(readme.filter((l) => /^\| `(kanban|auth|agent|lark|cron)\./.test(l))).toEqual([]);
    expect(readme.join('\n')).toContain('(docs/configuration.md)');
  });
});

describe("docs/configuration.md's messages", () => {
  const guide = read(GUIDE);

  /** The message `load` refuses `yaml` with, its file's path dropped. */
  function refusal(load: () => void): string {
    try {
      load();
    } catch (err) {
      if (err instanceof ConfigError) return err.message;
      throw err;
    }
    throw new Error('it loaded');
  }

  it("quotes the refusal of a gateway name in a role's .env", () => {
    const dir = roleDir();
    writeFileSync(join(dir, 'config.yaml'), 'agent:\n  command: claude-agent-acp\n');
    writeFileSync(join(dir, '.env'), 'LARK_APP_ID=cli_xxxxxxxxxxxxxxxx\n');
    chmodSync(join(dir, '.env'), 0o600);
    const message = refusal(() => loadRoleDir('analyst', dir, {}, new Set(['default'])));
    expect(message).toBe(`${join(dir, '.env')}: LARK_APP_ID may not be set in a role's .env: it belongs to the gateway`);
    expect(guide).toContain(`.env: LARK_APP_ID may not be set in a role's .env: it belongs to the gateway`);
  });

  it('quotes the refusal of a value in passEnv, and of an empty entry', () => {
    const dir = roleDir();
    const load = roleLoad(dir);
    const path = join(dir, 'config.yaml');
    const value = refusal(() => load('agent:\n  command: claude-agent-acp\n  passEnv: [LARK_APP_ID=cli_xxxxxxxxxxxxxxxx]\n'));
    expect(value).toBe(`${path}: agent.passEnv must not forward LARK_APP_ID=cli_xxxxxxxxxxxxxxxx: it belongs to the gateway`);
    expect(guide).toContain('config.yaml: agent.passEnv must not forward LARK_APP_ID=cli_xxxxxxxxxxxxxxxx: it belongs to the gateway');
    const empty = refusal(() => load('agent:\n  command: claude-agent-acp\n  passEnv:\n    -\n'));
    expect(empty).toBe(`${path}: agent.passEnv[0] must be a non-empty string`);
    expect(guide).toContain('config.yaml: agent.passEnv[0] must be a non-empty string');
  });

  it('quotes the refusal of a misspelled key', () => {
    const message = refusal(() => gatewayLoad('kanban:\n  max_runing: 2\n'));
    const quoted = message.slice(message.indexOf(': ') + 2);
    expect(quoted.startsWith('unknown setting kanban.max_runing')).toBe(true);
    expect(guide).toContain(`config.yaml: ${quoted}`);
  });
});

/** GitHub's anchor for a heading. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

function anchors(doc: string): Set<string> {
  return new Set(read(doc).split('\n').flatMap((l) => (/^#+ /.test(l) ? [slug(l.replace(/^#+ /, ''))] : [])));
}

describe('docs/configuration.md as a document', () => {
  it('has links that resolve, to files and to their headings', () => {
    const text = read(GUIDE).replace(/```[\s\S]*?```/g, '');
    const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? '').filter((l) => !/^[a-z]+:/.test(l));
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) {
      const [file = '', anchor] = link.split('#');
      const target = file === '' ? GUIDE : join(dirname(GUIDE), file);
      expect(existsSync(join(REPO, target)), link).toBe(true);
      if (anchor !== undefined) expect(anchors(target).has(anchor), link).toBe(true);
    }
  });

  it("is linked from the README's configuration and its reading list, by anchors that resolve", () => {
    const readme = read('README.md');
    expect(section(readme, '## Where to read more').join('\n')).toContain('(docs/configuration.md)');
    for (const m of readme.matchAll(/\]\(docs\/configuration\.md#([^)]+)\)/g)) expect(anchors(GUIDE).has(m[1] ?? ''), m[0]).toBe(true);
    for (const m of readme.matchAll(/\]\(#([^)]+)\)/g)) expect(anchors('README.md').has(m[1] ?? ''), m[0]).toBe(true);
  });

  it('writes no long dash', () => {
    expect(read(GUIDE).includes('—')).toBe(false);
  });
});
