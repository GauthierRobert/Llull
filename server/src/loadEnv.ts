/**
 * @layer server
 * @sideeffect loads `<repo>/.env` (then `server/.env`) into process.env before any module reads it.
 * Existing environment variables win; missing files are ignored. Skipped under tests.
 */
import fs from 'fs';
import path from 'path';

const ENV_FILE_CANDIDATES = [
  path.resolve(__dirname, '..', '..', '.env'),
  path.resolve(__dirname, '..', '.env'),
];

if (process.env['VITEST'] === undefined && process.env['TEST'] !== 'true') {
  for (const envFilePath of ENV_FILE_CANDIDATES) {
    if (fs.existsSync(envFilePath)) process.loadEnvFile(envFilePath);
  }
}
