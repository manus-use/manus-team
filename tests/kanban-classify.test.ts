import { describe, expect, it } from 'vitest';
import { classifyFailure, type FailureClass } from '../src/kanban/classify.js';
import type { TurnTerminal } from '../src/types.js';

/**
 * Real error strings, as agents and the CLI driver wrote them, with the class each
 * must get (spec §8.1). A new provider's wording is a new row.
 */
const CASES: ReadonlyArray<[TurnTerminal, string, FailureClass]> = [
  ['failed', 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'terminal_provider'],
  ['ambiguous', 'the agent exited with code 1: Error: 403 Forbidden', 'terminal_provider'],
  ['failed', 'Request failed with status code 401', 'terminal_provider'],
  ['failed', 'OpenAI: Incorrect API key provided. Invalid API key', 'terminal_provider'],
  ['failed', 'model "gpt-5.6-sol" not found', 'terminal_provider'],
  ['failed', 'The model `claude-x` does not exist or you do not have access to it.', 'terminal_provider'],
  ['ambiguous', 'error: model_not_found', 'terminal_provider'],
  ['ambiguous', 'the agent exited with code 1: 429 Too Many Requests', 'rate_limited'],
  ['failed', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', 'rate_limited'],
  ['failed', 'You exceeded your current quota, please check your plan and billing details.', 'rate_limited'],
  ['failed', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'rate_limited'],
  ['ambiguous', 'HTTP 503 Service Unavailable', 'rate_limited'],
  ['failed', 'Request failed with status code 502', 'rate_limited'],
  ['ambiguous', 'read ECONNRESET', 'rate_limited'],
  ['ambiguous', 'connect ETIMEDOUT 10.0.0.1:443', 'rate_limited'],
  ['failed', 'Request timed out.', 'rate_limited'],
  ['ambiguous', 'API Error: Connection error.', 'rate_limited'],
  ['failed', 'TypeError: fetch failed', 'rate_limited'],
  ['failed', 'ModelNotReadyException: Model is temporarily unavailable, please retry', 'rate_limited'],
  ['failed', "AccessDeniedException: You don't have access to the model with the specified model ID.", 'terminal_provider'],
  ['failed', 'ExpiredTokenException: The security token included in the request is expired', 'terminal_provider'],
  // The 400 of 2026-11-02: every request refused for three minutes, then fine.
  ['failed', 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Bad request"}}', 'failed'],
  // Not a provider wall either way: a 400 that killed the agent is a crash.
  ['ambiguous', 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}', 'crashed'],
  ['ambiguous', 'the agent exited without finishing its turn', 'crashed'],
  ['ambiguous', '', 'crashed'],
  ['failed', 'the agent reported a failed turn', 'failed'],
  ['failed', '', 'failed'],
  ['cancelled', '', 'failed'],
  // Numbers that are not statuses are not read as one.
  ['failed', 'tests failed: 512 passed, 3 failed (src/a.ts:401)', 'failed'],
  ['failed', 'error at line 512: unexpected token', 'failed'],
  // The agent's own tools failing are not the provider refusing it.
  ['failed', 'fatal: Authentication failed for https://example.invalid/repo.git', 'failed'],
  ['failed', 'Error: Test timed out in 5000ms.', 'failed'],
  ['ambiguous', 'API Error: 403 {"type":"error","error":{"type":"permission_error"}}', 'terminal_provider'],
];

describe('classifyFailure', () => {
  it.each(CASES)('%s with %j is %s', (terminal, text, expected) => {
    expect(classifyFailure(terminal, text)).toBe(expected);
  });

  it('reads the text before the terminal: a provider error that killed the agent is not a crash', () => {
    expect(classifyFailure('ambiguous', 'Error: 401 Unauthorized')).toBe('terminal_provider');
    expect(classifyFailure('ambiguous', 'rate limit exceeded')).toBe('rate_limited');
  });

  it('checks credentials before throttling: a 401 inside a retry message still blocks', () => {
    expect(classifyFailure('failed', 'retrying after 429... then: Error: 401 Unauthorized')).toBe('terminal_provider');
  });
});
