#!/usr/bin/env node
import { readAll } from './cli/kanban.js';
import { runMt } from './cli/mt.js';

/** The `mt` executable. Everything it does is in `./cli`; this only wires the process to it. */
process.exitCode = await runMt(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  stdin: (maxBytes) => readAll(process.stdin, maxBytes),
});
