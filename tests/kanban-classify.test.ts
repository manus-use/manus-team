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
  // A test's assertion on a status: the expected code, not the provider's answer.
  ['failed', 'AssertionError: expected status code 403 but got 200', 'failed'],
  ['failed', 'AssertionError: expected status 401, got 200', 'failed'],
  ['failed', 'expected response status 429 to equal 200', 'failed'],
  // The agent's own tools failing are not the provider refusing it.
  ['failed', 'fatal: Authentication failed for https://example.invalid/repo.git', 'failed'],
  ['failed', 'Error: Test timed out in 5000ms.', 'failed'],
  ['ambiguous', 'API Error: 403 {"type":"error","error":{"type":"permission_error"}}', 'terminal_provider'],

  // A subscription's usage window: throttling, not a failure of the task.
  ['ambiguous', 'Claude AI usage limit reached|1762200000', 'rate_limited'],
  ['failed', '5-hour limit reached ∙ resets 3pm', 'rate_limited'],
  ['failed', 'Claude usage limit reached. Your limit will reset at 3pm', 'rate_limited'],
  // Bedrock's throttling and its own outages.
  ['failed', 'ThrottlingException: Rate exceeded', 'rate_limited'],
  ['failed', 'ServiceUnavailableException: Bedrock is unable to process your request.', 'rate_limited'],
  ['failed', 'InternalServerException: The server encountered an error processing your request.', 'rate_limited'],
  ['failed', 'ModelTimeoutException', 'rate_limited'],
  ['failed', 'ModelNotReadyException: Model is not ready', 'rate_limited'],
  ['failed', 'ServiceQuotaExceededException', 'rate_limited'],
  ['failed', 'Error code: 429 - insufficient_quota', 'rate_limited'],
  ['failed', 'insufficient_quota', 'rate_limited'],
  // The network between the agent and the provider.
  ['ambiguous', 'getaddrinfo ENOTFOUND api.example.invalid', 'rate_limited'],
  ['ambiguous', 'write EPIPE', 'rate_limited'],
  ['ambiguous', 'connect ENETUNREACH 10.0.0.1:443', 'rate_limited'],
  ['ambiguous', 'connect EHOSTUNREACH 10.0.0.1:443', 'rate_limited'],
  ['ambiguous', 'read ECONNABORTED', 'rate_limited'],
  ['ambiguous', 'UND_ERR_HEADERS_TIMEOUT', 'rate_limited'],
  ['ambiguous', 'SocketError: other side closed', 'rate_limited'],
  ['ambiguous', 'Client network socket disconnected before secure TLS connection was established', 'rate_limited'],
  ['ambiguous', 'Error: Premature close', 'rate_limited'],
  ['failed', 'Connection refused', 'rate_limited'],
  ['failed', 'stream disconnected before completion: error sending request for url (https://api.example.invalid/v1)', 'rate_limited'],
  // bytesec's own retries, spent: the provider would not answer.
  ['failed', 'Error [model-retry] attempt failed attempt=5/5 retryable=true', 'rate_limited'],
  // ...but an attempt with retries left is not the last word.
  ['failed', 'Error [model-retry] attempt failed attempt=2/5 retryable=true', 'failed'],

  // A model that does not exist, or that this account cannot use.
  ['failed', 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-9"}}', 'terminal_provider'],
  [
    'failed',
    "There's an issue with the selected model (claude-x). It may not exist or you may not have access to it.",
    'terminal_provider',
  ],
  ['failed', 'ValidationException: The provided model identifier is invalid.', 'terminal_provider'],
  [
    'failed',
    "ValidationException: Invocation of model ID anthropic.model-x with on-demand throughput isn't supported.",
    'terminal_provider',
  ],
  ['failed', 'Unknown model: claude-x', 'terminal_provider'],
  // Credentials that are gone.
  ['ambiguous', 'OAuth token revoked · Please run /login', 'terminal_provider'],
  ['failed', 'CredentialsProviderError: Could not load credentials from any providers', 'terminal_provider'],
  ['failed', 'ExpiredToken: The security token included in the request is expired', 'terminal_provider'],
  ['failed', 'InvalidSignatureException: The request signature we calculated does not match', 'terminal_provider'],
  ['failed', 'Token is expired. To refresh this SSO session run aws sso login with the corresponding profile.', 'terminal_provider'],
  ['failed', 'Error loading SSO Token: Token for my-sso is expired', 'terminal_provider'],
  ['failed', 'This organization has been disabled.', 'terminal_provider'],
  // An expired token that is not the provider's: a test's own JWT.
  ['failed', 'AssertionError: jwt Token is expired in the fixture', 'failed'],

  // Files, commands and fields named "model" are not the provider's model.
  ['failed', "error: path 'src/model.py' does not exist in 'HEAD'", 'failed'],
  ['failed', 'sh: model: command not found', 'failed'],
  ['failed', 'Error: file models/model.ts not found', 'failed'],
  ['failed', 'model src/model.py not found', 'failed'],
  ['failed', 'unknown model field "foo" in schema', 'failed'],
  // A test about authorization is not the provider refusing.
  ['failed', 'Test "handles unauthorized users" failed', 'failed'],
  // Words that only look like throttling.
  ['failed', 'Error: 503 tests passed', 'failed'],
  ['failed', "Cannot find name 'quota'", 'failed'],
  ['failed', 'read timeout in test fixture', 'failed'],
  ['ambiguous', 'read ETIMEDOUT', 'rate_limited'],
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
