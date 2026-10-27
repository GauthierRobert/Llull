/**
 * `DocumentExtension.staleEntityIds` (TECHNICAL_SPEC 13.11.7): persistence accepts a dangling `order` entry only when an extension reports it as an
 * unrealised derived entity. A plugin that merely derives an id, and any other unknown id, still refuses the file.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { installPlugin } from '@core/plugins/host';

installPlugin({
  name: 'test-derives',
  toolset: 'test',
  commands: [],
  document: { validate: () => [], derivedEntityIds: () => new Set(['derived-1']), restore: (raw) => raw },
});
installPlugin({
  name: 'test-stale',
  toolset: 'test',
  commands: [],
  document: {
    validate: () => [],
    derivedEntityIds: () => new Set(['stale-1']),
    staleEntityIds: () => new Set(['stale-1']),
    restore: (raw) => raw,
  },
});

const withOrder = (...ids: string[]): string => serializeDocument({ ...createEmptyDocument(), order: ids });

describe('a dangling order entry', () => {
  it('is accepted when an extension reports it as unrealised', () => {
    expect(deserializeDocument(withOrder('stale-1')).order).toEqual(['stale-1']);
  });

  it('is refused when its extension only derives it, and when no extension knows it', () => {
    expect(() => deserializeDocument(withOrder('derived-1'))).toThrow(/order: 'derived-1' does not reference a known entity/);
    expect(() => deserializeDocument(withOrder('nobody-1'))).toThrow(/order: 'nobody-1' does not reference a known entity/);
  });
});
