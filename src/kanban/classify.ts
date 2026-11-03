import type { TurnTerminal } from '../types.js';

/**
 * Why a run's turn failed, when the run did not report and the dispatcher did not
 * cancel it (spec §8.1). One pure function over the turn's terminal and the text
 * of that turn's errors, so a new provider's wording is a test case and a line.
 *
 * Checked in order, first match wins. **Text before terminal**: the CLI driver
 * reports any process that exits without a finish line as `ambiguous`, with the
 * stderr tail in the error, so a 429 or a 401 that kills the agent early arrives
 * as an ambiguous terminal with a provider error in it. Classed by terminal
 * alone, a quota wall would count as a crash and a revoked credential would be
 * retried.
 *
 * **400 is an ordinary failure.** On 2026-11-02 a provider returned 400 to every
 * request for about three minutes, then recovered with nothing changed; blocking
 * on it would have turned a blip into a task waiting on a person.
 */

export type FailureClass = 'terminal_provider' | 'rate_limited' | 'crashed' | 'failed';

/**
 * An HTTP status, where the text says it is one: `status 429`, `Error: 401`, `HTTP 503`.
 * Not a count that follows `error`: "Error: 503 tests passed" is a test run's tally.
 */
function status(codes: string): RegExp {
  return new RegExp(
    `\\b(?:status(?: code)?|code|http|error)\\b[\\s:=#-]{0,4}(?:${codes})\\b` +
      '(?!\\s+(?:tests?|passed|failed|files?|errors?|warnings?|lines?|items?|of)\\b)',
    'i',
  );
}

/** Credentials rejected, or the model unavailable: every retry would hit the same wall. */
const TERMINAL_PROVIDER: readonly RegExp[] = [
  // A 401 says "unauthorized" for itself; the bare word is as often a test's name.
  status('401|403'),
  /\b(?:authentication_error|permission_error)\b/,
  /\binvalid[ _-]?api[ _-]?key\b/i,
  // Bedrock's wording for refused or expired credentials, and the AWS SDK's for none at all.
  /\b(?:AccessDeniedException|ExpiredToken(?:Exception)?|UnrecognizedClientException|InvalidSignatureException)\b/,
  /\bCould not load credentials from any providers\b/i,
  // An expired token only where it is the SSO session's: a test's JWT expires too.
  /\btoken is expired\b[^\n]{0,80}\bSSO session\b|\bSSO Token\b[^\n]{0,80}\bis expired\b/i,
  // The Claude CLI's login that is gone, and an account that is gone.
  /\bOAuth token (?:has been )?(?:revoked|expired)\b/i,
  /\borganization has been disabled\b/i,
  /\bcredit balance is too low\b/i,
  // A model id directly after "model", and not a file (`model.py`) or a command
  // (`model: command not found`). Not "unavailable": "Model is temporarily
  // unavailable" is the provider busy, not a wall.
  /\bmodel\b[:\s]+(?!command\b)["'`(]?[\w.:@-]+(?<!\.[a-z]{1,4})["'`)]?\s+(?:not found|does not exist)\b/i,
  /\b(?:model_not_found|no such model)\b/i,
  /\bunknown model\b\s*[:"'`]/i,
  /\bnot_found_error\b[^\n]{0,80}\bmodel\b/,
  /\bissue with the selected model\b/i,
  /\bmodel identifier is invalid\b/i,
  /\bon-demand throughput isn['’]?t supported\b/i,
];

/** Throttling, or a provider that is down for now. */
const RATE_LIMITED: readonly RegExp[] = [
  status('429|5\\d\\d'),
  /\brate[ _-]?limit/i,
  /\brate exceeded\b/i,
  // A subscription's usage window (the Claude CLI's), which resets on its own.
  /\b(?:usage|5-hour|weekly) limit (?:reached|exceeded)\b|\bhit your limit\b/i,
  // Only a quota that is spent: "Cannot find name 'quota'" is a compiler's.
  /\b(?:quota[ _-]?exceeded|insufficient[ _-]?quota|exceeded (?:your |the )?(?:current )?quota)\b|QuotaExceeded/i,
  /\btoo many requests\b/i,
  /\boverloaded\b/i,
  /\b(?:internal server error|bad gateway|service unavailable|gateway timeout)\b/i,
  // Bedrock's throttling and its own outages.
  /(?:Throttling|ServiceUnavailable|InternalServer|ModelNotReady|ModelTimeout|ServiceQuotaExceeded)Exception/,
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_\w+)\b/,
  /\b(?:connection reset|connection error|connection refused|socket hang up|fetch failed|temporarily unavailable)\b/i,
  /\b(?:other side closed|socket disconnected|stream disconnected|error sending request|premature close)\b/i,
  // The provider's timeouts, not a test's: "Test timed out in 5000ms" is an ordinary
  // failure, and so is a "read timeout" of the agent's own; a read from the network
  // that timed out is `read ETIMEDOUT`.
  /\b(?:request|connection|connect|socket|gateway) (?:timed out|timeout)\b/i,
  // bytesec's own retries, all spent (`attempt=5/5`): the provider would not answer.
  /\bmodel-retry\b.*\battempt=(\d+)\/\1\b/,
];

export function classifyFailure(terminal: TurnTerminal, errorText: string): FailureClass {
  if (TERMINAL_PROVIDER.some((p) => p.test(errorText))) return 'terminal_provider';
  if (RATE_LIMITED.some((p) => p.test(errorText))) return 'rate_limited';
  if (terminal === 'ambiguous') return 'crashed';
  return 'failed';
}
