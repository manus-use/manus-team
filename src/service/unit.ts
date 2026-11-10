import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

/**
 * The gateway as a persistent service: the launchd property list on macOS and
 * the systemd user unit on Linux, written by `mt service install`, and read
 * back by `mt service status`. Pure text in, text out; the commands that write
 * and load them are in `cli/service.ts`.
 *
 * Both run the built gateway, `node dist/main.js`, with the node that ran the
 * install, from the checkout, with PATH as it was at install time and MT_HOME
 * when it was set, and nothing else: no secret is ever written into either.
 * The gateway reads its secrets from `$MT_HOME/.env`.
 */

export interface ServiceSpec {
  label: string;
  /** The absolute path of node. */
  node: string;
  /** The absolute path of dist/main.js. */
  main: string;
  /** The working directory: the checkout. */
  checkout: string;
  /** PATH, as recorded at install time. */
  path: string;
  /** MT_HOME, when it was set at install time; else the service runs with the default home. */
  mtHome: string | undefined;
  /** Where stdout and stderr go, both. */
  log: string;
}

/** What a unit records: its spec less its label. */
export type Recorded = Omit<ServiceSpec, 'label'>;

const DEFAULT_LABEL = 'team.manus.gateway';
const DEFAULT_UNIT = 'manus-team';

/** Node's first argument in both units: a crash's stack names the TypeScript source, as `npm start` does. */
const NODE_FLAG = '--enable-source-maps';

/** Seconds launchd and systemd wait before starting the gateway again after it stopped. */
export const RESTART_DELAY_S = 30;

/**
 * The launchd label and the systemd unit name for a home: plain for the
 * default home, `~/.manus-team`, and with a hash of the home's path for any
 * other, so two homes are two services that never replace each other.
 */
export function serviceNames(userHome: string, mtHome: string): { label: string; unit: string } {
  const home = resolve(mtHome);
  if (home === resolve(join(userHome, '.manus-team'))) return { label: DEFAULT_LABEL, unit: `${DEFAULT_UNIT}.service` };
  const hash = createHash('sha256').update(home).digest('hex').slice(0, 10);
  return { label: `${DEFAULT_LABEL}.${hash}`, unit: `${DEFAULT_UNIT}-${hash}.service` };
}

/** A value with a character neither file can hold: any control character, a newline included. */
function checkValue(what: string, value: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${what} has a control character, which a service file cannot hold: ${JSON.stringify(value)}`);
  }
}

function checkSpec(spec: ServiceSpec): void {
  checkValue('the label', spec.label);
  checkValue('the node path', spec.node);
  checkValue('the path of dist/main.js', spec.main);
  checkValue('the checkout', spec.checkout);
  checkValue('PATH', spec.path);
  if (spec.mtHome !== undefined) checkValue('MT_HOME', spec.mtHome);
  checkValue('the log path', spec.log);
}

// ---------------------------------------------------------------------------
// launchd

export function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

const string = (value: string): string => `<string>${xmlEscape(value)}</string>`;

/**
 * The LaunchAgent. `KeepAlive` with `SuccessfulExit` false restarts the gateway
 * whenever it exits other than cleanly, as systemd's `Restart=on-failure` does;
 * a clean exit, after a SIGTERM, stays down. `ThrottleInterval` keeps a crash
 * loop to one start every RESTART_DELAY_S seconds.
 */
export function launchdPlist(spec: ServiceSpec): string {
  checkSpec(spec);
  const env: [string, string][] = [['PATH', spec.path]];
  if (spec.mtHome !== undefined) env.push(['MT_HOME', spec.mtHome]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- Written by mt service install. Run it again to rewrite this file; edits here are lost. -->',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${string(spec.label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    ${string(spec.node)}`,
    `    ${string(NODE_FLAG)}`,
    `    ${string(spec.main)}`,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  ${string(spec.checkout)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env.flatMap(([k, v]) => [`    <key>${xmlEscape(k)}</key>`, `    ${string(v)}`]),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    `  <integer>${RESTART_DELAY_S}</integer>`,
    // Standard, not Background: launchd gives a Background job low CPU and I/O
    // priority, which every agent the gateway starts would inherit.
    '  <key>ProcessType</key>',
    '  <string>Standard</string>',
    '  <key>StandardOutPath</key>',
    `  ${string(spec.log)}`,
    '  <key>StandardErrorPath</key>',
    `  ${string(spec.log)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** The value after `<key>name</key>` at this depth of the file this module writes, or undefined. */
function plistString(text: string, name: string): string | undefined {
  const m = new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`).exec(text);
  return m?.[1] === undefined ? undefined : xmlUnescape(m[1]);
}

/** What a plist written by `launchdPlist` records, or undefined for any other text. */
export function readPlist(text: string): Recorded | undefined {
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
  const env = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? '';
  const words = [...(args ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => xmlUnescape(m[1] ?? ''));
  const node = words[0];
  const main = words.length > 1 ? words[words.length - 1] : undefined;
  const checkout = plistString(text, 'WorkingDirectory');
  const log = plistString(text, 'StandardOutPath');
  const path = plistString(env, 'PATH');
  if (node === undefined || main === undefined || checkout === undefined || log === undefined || path === undefined) {
    return undefined;
  }
  return { node, main, checkout, path, mtHome: plistString(env, 'MT_HOME'), log };
}

// ---------------------------------------------------------------------------
// systemd

/** `%` is a specifier in every value systemd reads; `%%` is a percent sign. */
const percent = (value: string): string => value.replaceAll('%', '%%');

/**
 * A word in double quotes, as ExecStart= and Environment= read one: a backslash
 * and a double quote escaped, and `%` doubled. In ExecStart= `$` is doubled
 * too, which it would otherwise expand; Environment= takes `$` as it is.
 */
export function systemdQuote(value: string, opts: { dollar?: boolean } = {}): string {
  const quoted = percent(value.replaceAll('\\', '\\\\').replaceAll('"', '\\"'));
  return `"${opts.dollar === false ? quoted : quoted.replaceAll('$', '$$$$')}"`;
}

/** A path systemd reads as the rest of the line: its specifiers escaped; a space at either end would be trimmed. */
function systemdPath(what: string, value: string): string {
  if (value !== value.trim()) throw new Error(`${what} begins or ends with a space, which systemd would trim: ${JSON.stringify(value)}`);
  return percent(value);
}

/**
 * The user unit. `Restart=on-failure` restarts the gateway whenever it exits
 * other than cleanly, after RESTART_DELAY_S seconds, but for a configuration
 * error (exit 78, EX_CONFIG): that stays failed until it is fixed, where a
 * restart could only fail the same way again.
 */
export function systemdUnit(spec: ServiceSpec): string {
  checkSpec(spec);
  const env = [`PATH=${spec.path}`, ...(spec.mtHome === undefined ? [] : [`MT_HOME=${spec.mtHome}`])];
  return [
    '# Written by mt service install. Run it again to rewrite this file; edits here are lost.',
    '[Unit]',
    'Description=manus-team gateway',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${systemdQuote(spec.node)} ${systemdQuote(NODE_FLAG)} ${systemdQuote(spec.main)}`,
    `WorkingDirectory=${systemdPath('the checkout', spec.checkout)}`,
    ...env.map((e) => `Environment=${systemdQuote(e, { dollar: false })}`),
    `StandardOutput=append:${systemdPath('the log path', spec.log)}`,
    `StandardError=append:${systemdPath('the log path', spec.log)}`,
    'Restart=on-failure',
    `RestartSec=${RESTART_DELAY_S}`,
    'RestartPreventExitStatus=78',
    // SIGTERM to the gateway alone, so it drains and stops its agents itself; whatever is left is killed after the timeout.
    'KillMode=mixed',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** The double-quoted words of a line `systemdQuote` wrote, unescaped. */
function systemdWords(line: string, dollar = true): string[] {
  const words: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const word = (m[1] ?? '').replace(/\\(.)/g, '$1').replaceAll('%%', '%');
    words.push(dollar ? word.replaceAll('$$', () => '$') : word);
  }
  return words;
}

/** What a unit written by `systemdUnit` records, or undefined for any other text. */
export function readUnit(text: string): Recorded | undefined {
  const line = (key: string): string[] =>
    text
      .split('\n')
      .filter((l) => l.startsWith(`${key}=`))
      .map((l) => l.slice(key.length + 1));
  const words = systemdWords(line('ExecStart')[0] ?? '');
  const node = words[0];
  const main = words.length > 1 ? words[words.length - 1] : undefined;
  const checkout = line('WorkingDirectory')[0]?.replaceAll('%%', '%');
  const log = line('StandardOutput')[0]?.replace(/^append:/, '').replaceAll('%%', '%');
  const env = new Map(
    line('Environment')
      .flatMap((l) => systemdWords(l, false))
      .map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)] as const),
  );
  const path = env.get('PATH');
  if (node === undefined || main === undefined || checkout === undefined || log === undefined || path === undefined) {
    return undefined;
  }
  return { node, main, checkout, path, mtHome: env.get('MT_HOME'), log };
}
