import { mtCommand, npmCommand, shQuote } from './shell.js';

/**
 * The blocks `mt update` prints for a person to type (spec §20.6, §20.7,
 * §20.9): the steps back, the steps forward, and the commands to finish going
 * back by hand. Each names mt as `'<node>' '<checkout>/dist/mt.js'` and npm by
 * its path, with the node's directory first on PATH, every path quoted as
 * install.sh quotes one, and starts with `export MT_HOME='<home>'` when the
 * home is not the default: the service, the home and the database are found
 * from it.
 */

export interface AdvicePaths {
  node: string;
  npm: string;
  checkout: string;
  /** The gateway's home. */
  home: string;
  /** Whether the home is set, not the default: then each block exports it. */
  homeSet: boolean;
  /** The database the gateway opens. */
  db: string;
  /** Whether a service is installed; else a gateway started by hand is restarted by hand. */
  service: boolean;
}

function header(p: AdvicePaths): string[] {
  return p.homeSet ? [`export MT_HOME=${shQuote(p.home)}`] : [];
}

const build = (p: AdvicePaths): string => `${npmCommand(p.node, p.npm, 'ci')} && ${npmCommand(p.node, p.npm, 'run build')}`;

/**
 * The steps back (spec §20.9): stop the gateway, the old commit and its build,
 * the backup restored over the database with its `-wal` and `-shm` removed,
 * and start it. With no backup the restore is left out. With `checkVersion`,
 * when the service started again on its own during the update, a check after
 * the stop reads the database's version again before anything goes back.
 */
export function stepsBack(p: AdvicePaths, opts: { old: string; backup: string | undefined; checkVersion?: number | null }): string[] {
  const mt = mtCommand(p.node, p.checkout);
  const check =
    opts.checkVersion === undefined
      ? []
      : [
          `${mt} service check  # it should print ${opts.checkVersion === null ? '"no database"' : `"at version ${opts.checkVersion}"`}: ` +
            'if it does, or prints "database: unknown (...)", or nothing, go on; if it prints another version, follow the steps forward instead',
        ];
  const restore = opts.backup === undefined ? [] : [`rm -f ${shQuote(`${p.db}-wal`)} ${shQuote(`${p.db}-shm`)}`, `cp ${shQuote(opts.backup)} ${shQuote(p.db)}`];
  return [
    ...header(p),
    p.service ? `${mt} service stop` : '# stop the gateway, if it runs',
    `cd ${shQuote(p.checkout)}`,
    ...check,
    `git reset --keep ${opts.old}`,
    build(p),
    ...restore,
    p.service ? `${mt} service start` : '# then start it',
  ];
}

/** The steps forward (spec §20.6): the new tree made whole, checked, and started. */
export function stepsForward(p: AdvicePaths): string[] {
  const mt = mtCommand(p.node, p.checkout);
  return [
    ...header(p),
    `cd ${shQuote(p.checkout)}`,
    build(p),
    `${mt} service check`,
    p.service ? `${mt} service restart` : '# restart the gateway (stop it if it runs, then start it)',
  ];
}

/** The commands to finish going back by hand (spec §20.7), the reset among them when it is what failed. */
export function finishByHand(p: AdvicePaths, opts: { reset: string | undefined }): string[] {
  return [
    ...header(p),
    `cd ${shQuote(p.checkout)}${opts.reset === undefined ? '' : ` && git reset --keep ${opts.reset}`} && ${build(p)}`,
  ];
}
