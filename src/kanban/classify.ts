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

/** An HTTP status, where the text says it is one: `status 429`, `Error: 401`, `HTTP 503`. */
function status(codes: string): RegExp {
  return new RegExp(`\\b(?:status(?: code)?|code|http|error)\\b[\\s:=#-]{0,4}(?:${codes})\\b`, 'i');
}

/** Credentials rejected, or the model unavailable: every retry would hit the same wall. */
const TERMINAL_PROVIDER: readonly RegExp[] = [
  status('401|403'),
  /\bunauthori[sz]ed\b/i,
  /\b(?:authentication_error|permission_error)\b/,
  /\binvalid[ _-]?api[ _-]?key\b/i,
  // Bedrock's wording for refused or expired credentials, and a spent balance.
  /\b(?:AccessDeniedException|ExpiredTokenException|UnrecognizedClientException)\b/,
  /\bcredit balance is too low\b/i,
  // Not "unavailable": "Model is temporarily unavailable" is the provider busy, not a wall.
  /\bmodel\b[^\n]{0,60}\b(?:not found|does not exist)\b/i,
  /\b(?:model_not_found|no such model|unknown model)\b/i,
];

/** Throttling, or a provider that is down for now. */
const RATE_LIMITED: readonly RegExp[] = [
  status('429|5\\d\\d'),
  /\brate[ _-]?limit/i,
  /\bquota\b/i,
  /\btoo many requests\b/i,
  /\boverloaded\b/i,
  /\b(?:internal server error|bad gateway|service unavailable|gateway timeout)\b/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/,
  /\b(?:connection reset|connection error|socket hang up|fetch failed|temporarily unavailable)\b/i,
  // The provider's timeouts, not a test's: "Test timed out in 5000ms" is an ordinary failure.
  /\b(?:request|connection|connect|socket|read|gateway) (?:timed out|timeout)\b/i,
];

export function classifyFailure(terminal: TurnTerminal, errorText: string): FailureClass {
  if (TERMINAL_PROVIDER.some((p) => p.test(errorText))) return 'terminal_provider';
  if (RATE_LIMITED.some((p) => p.test(errorText))) return 'rate_limited';
  if (terminal === 'ambiguous') return 'crashed';
  return 'failed';
}
