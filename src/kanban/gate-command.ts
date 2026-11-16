import { MASK, redactKnownSecrets } from '../secrets.js';
import { stripControl } from '../text.js';
import { GATE_LIMITS } from './types.js';

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

/**
 * Why a gate a workflow or a DAG puts on a task could not be added, as `addGate`
 * would refuse it (spec §21.4, §21.5), or undefined: a command, not blank, with
 * no NUL, of at most 4 KiB, holding neither the mask nor a known secret, and a
 * timeout from 1 to 600 s. Said after the gate's place, as `<place> <problem>`.
 */
export function gateProblem(gate: { command: string; timeoutS: number }): string | undefined {
  const { command } = gate;
  if (command.trim() === '') return 'is a command, and this one is blank';
  if (command.includes('\0')) return 'holds a NUL, which no command can';
  const size = Buffer.byteLength(command, 'utf8');
  if (size > GATE_LIMITS.commandBytes) return `is ${size} bytes; a gate command may be at most ${GATE_LIMITS.commandBytes}`;
  if (command.includes(MASK)) {
    return `holds the mask ${MASK}: it was copied from masked output, and a masked command would run broken; write the command out again`;
  }
  if (holdsSecret(command)) {
    return (
      'holds a known secret, and a gate is stored and run as written: ' +
      "pass the value through the role's environment and name it in the command, as $NAME"
    );
  }
  if (!Number.isSafeInteger(gate.timeoutS) || gate.timeoutS < 1 || gate.timeoutS > GATE_LIMITS.maxTimeoutS) {
    return `has a timeout of ${String(gate.timeoutS)} s; a gate's timeout is a whole number of seconds, from 1 to ${GATE_LIMITS.maxTimeoutS}`;
  }
  return undefined;
}

/** Why a task's gates together could not be added, or undefined: at most 20, and 600 s together (spec §7.7). */
export function gatesProblem(gates: readonly { timeoutS: number }[]): string | undefined {
  if (gates.length > GATE_LIMITS.perTask) return `has ${gates.length} gates; a task may have at most ${GATE_LIMITS.perTask}`;
  const total = gates.reduce((sum, g) => sum + g.timeoutS, 0);
  if (total > GATE_LIMITS.totalTimeoutS) {
    return `has gates that would take up to ${total} s together; at most ${GATE_LIMITS.totalTimeoutS} s, since a report waits for them`;
  }
  return undefined;
}
