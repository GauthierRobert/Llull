/**
 * @layer server
 * @sideeffect loads `<repo>/.env` (then `server/.env`) into process.env before any module reads it.
 * Existing environment variables win; missing files are ignored. Skipped under tests.
 */
import fs from 'fs';
import path from 'path';
import { isTestRun } from './env';

const ENV_FILE_CANDIDATES = [
  path.resolve(__dirname, '..', '..', '.env'),
  path.resolve(__dirname, '..', '.env'),
];

if (!isTestRun()) {
  for (const envFilePath of ENV_FILE_CANDIDATES) {
    if (fs.existsSync(envFilePath)) process.loadEnvFile(envFilePath);
  }
}
