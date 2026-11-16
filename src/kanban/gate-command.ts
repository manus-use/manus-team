import { redactKnownSecrets } from '../secrets.js';
import { stripControl } from '../text.js';

/**
 * What a gate's command may hold (spec §7.7, §10.1): shared by `KanbanService`'s
 * `addGate` and a workflow's checks (spec §21.4), so the pure workflow module
 * need not import the service.
 */

/**
 * Whether a gate command holds a known secret (spec §10.1): as written, with its
 * control characters stripped, as the escapers match it, and with the shell's
 * quotes and backslashes taken out, so `sk\$x` or `'sk''x'` -- which the shell
 * runs as the secret -- count as well. A backslash-newline, which the shell
 * removes, is taken out first, and that form is matched with its control
 * characters stripped too.
 */
export function holdsSecret(command: string): boolean {
  // A backslash-newline is a continuation the shell removes, so it goes before the quotes do.
  const unquoted = command.replace(/\\\r?\n/g, '').replace(/['"\\]/g, '');
  const forms = [command, stripControl(command), unquoted, stripControl(unquoted)];
  return forms.some((form) => redactKnownSecrets(form) !== form);
}
