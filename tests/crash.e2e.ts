import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The crash handlers in a real process (spec §10.1): a secret in an error that
 * nothing caught is printed masked, and the process exits 1, as Node would.
 */

const LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const SECRETS = new URL('../src/secrets.ts', import.meta.url).href;
const CRASH = new URL('../src/crash.ts', import.meta.url).href;

/** Run a module that registers a secret, installs the handlers, then does `then`. */
function crash(then: string): Promise<{ code: number | null; stderr: string }> {
  const code = [
    `import { addSecrets } from ${JSON.stringify(SECRETS)};`,
    `import { installCrashHandlers } from ${JSON.stringify(CRASH)};`,
    "addSecrets(['sk-crash-1234567890']);",
    'installCrashHandlers();',
    then,
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', LOADER, '--input-type=module', '-e', code], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (stderr += d));
    child.once('error', reject);
    child.once('close', (status) => resolve({ code: status, stderr }));
  });
}

describe('a crash, in a real process', () => {
  it('prints an uncaught exception masked, and exits 1', async () => {
    const r = await crash("setTimeout(() => { throw new Error('key sk-crash-1234567890 rejected'); }, 10);");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^uncaught exception: Error: key •••• rejected\n {4}at /);
    expect(r.stderr).not.toContain('sk-crash');
  });

  it('prints an unhandled rejection masked, and exits 1', async () => {
    const r = await crash("Promise.reject(new Error('token sk-crash-1234567890'));");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^unhandled rejection: Error: token ••••\n/);
    expect(r.stderr).not.toContain('sk-crash');
  });
});
