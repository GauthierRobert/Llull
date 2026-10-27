/** A host that runs one `llull-compute` job the way the backend does, for tests that kill it hard: `tsx holdJob.ts <binary> <job folder>`. */
import { createComputeRunner } from '../../src/native/computeJob';

const [binary, folder] = process.argv.slice(2);
void createComputeRunner(process.env, binary ?? null)
  .run(['meshops'], folder ?? '', 120_000)
  .then(() => process.exit(0));
