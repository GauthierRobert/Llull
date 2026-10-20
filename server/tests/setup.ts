/** Server test setup: install the default domain plugins (as server/src/plugins.ts does), keep the PLM host away from the real home directory; crash reports go to a temp data dir. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installDefaultPlugins } from '@app/plugins';
import { configureHostForTests } from '../src/plm/hostConfig';

process.env['LLULL_DATA_DIR'] ??= mkdtempSync(path.join(tmpdir(), 'llull-server-test-data-'));

installDefaultPlugins();
// Production reads no environment for trust, test keys or the audit log; tests configure them in-process.
configureHostForTests({ auditDir: null, trustDir: mkdtempSync(path.join(tmpdir(), 'llull-test-trust-')) });
