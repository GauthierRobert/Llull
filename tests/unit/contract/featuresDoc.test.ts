/**
 * SC-Q5: docs/FEATURES.md is generated from the registry and must not go stale. `npm run features` rewrites it (this suite with
 * LLULL_WRITE_FEATURES=1); otherwise the committed file must equal the generated text (line endings ignored).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listCommands } from '@core/commands/registry';
import { featuresMarkdown } from '../../../scripts/featuresDoc';

const FEATURES_FILE = path.resolve(__dirname, '../../../docs/FEATURES.md');
const lf = (text: string): string => text.replace(/\r\n/g, '\n');

describe('docs/FEATURES.md', () => {
  const generated = featuresMarkdown();
  if (process.env['LLULL_WRITE_FEATURES'] === '1') writeFileSync(FEATURES_FILE, generated);

  it('lists every registered command once, with its toolset section', () => {
    for (const def of listCommands()) expect(generated.split(`| \`${def.name}\` |`).length - 1).toBe(1);
    expect(generated).toMatch(/^## 3d$/m);
    expect(generated).toMatch(/\| `mass_properties` \| .+ \| read-only \|/);
    expect(generated).toMatch(/\| `shell_solid` \| .+ \| kernel \|/);
  });

  it('is up to date (regenerate with: npm run features)', () => {
    expect(lf(readFileSync(FEATURES_FILE, 'utf8'))).toBe(lf(generated));
  });
});
