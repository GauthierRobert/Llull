/**
 * Process entry of the `llull` CLI (launched by `server/bin/llull.cjs`). A local run with
 * `--timeout` is supervised (`supervisor.ts`): the CLI re-runs itself as a child and kills the child's whole process
 * tree shortly after the deadline. Everything else loads `cliProcess.ts` directly.
 */

import { supervise, supervisedTimeout } from './supervisor';

const seconds = supervisedTimeout(process.argv.slice(2), process.env);
if (seconds !== undefined) supervise(seconds);
else void import('./cliProcess');
