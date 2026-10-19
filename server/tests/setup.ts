/** Server test setup: install the default domain plugins (as server/src/plugins.ts does); crash reports go to a temp data dir. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installDefaultPlugins } from '@app/plugins';

process.env['LLULL_DATA_DIR'] ??= mkdtempSync(path.join(tmpdir(), 'llull-server-test-data-'));

installDefaultPlugins();
