import { ConfigError, gatewayHome } from './config.js';
import { installCrashHandlers } from './crash.js';
import { main } from './index.js';
import { redactKnownSecrets } from './secrets.js';
import { rotateOwnLog } from './service/log.js';

/**
 * The executable. Everything it does is turn a failure into an exit code.
 *
 * `src/index.ts` is importable -- tests build a gateway and never want a process
 * that installs signal handlers or exits -- so the boundary between "a library
 * that wires a gateway" and "a service" is this file, and nothing else.
 *
 * A configuration mistake prints one line and no stack. It is the failure an
 * operator hits most often, always at the first deploy, and a 40-frame trace
 * buries the name of the variable they forgot.
 *
 * Both writes are masked, but only for the secrets known by then: the secrets in
 * the gateway's .env as soon as it is read, and the rest once loadTeam has
 * returned, so an error from loadConfig or loadTeam itself can mask only the
 * first. None names a value.
 *
 * So is a crash, from the first line: an uncaught exception or an unhandled
 * rejection is printed through the masker, not by Node, and exits 1.
 */
installCrashHandlers();
// Run as a service, the log launchd or systemd opened is bounded at each start (service/log.ts).
try {
  rotateOwnLog(gatewayHome(process.env));
} catch (err) {
  process.stderr.write(`note: the service log was not rotated: ${redactKnownSecrets(String(err))}\n`);
}
try {
  await main();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`configuration error: ${redactKnownSecrets(err.message)}\n`);
    process.exit(78); // EX_CONFIG, so a supervisor can tell this from a crash.
  }
  process.stderr.write(
    `failed to start: ${redactKnownSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err))}\n`,
  );
  process.exit(1);
}
