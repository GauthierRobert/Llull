import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { formatLength } from '@core/commands/units';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence';
import { __resetIdCounter } from '@lib/id';

describe('set_units command', () => {
  beforeEach(() => __resetIdCounter());

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  it('sets units to in with precision 2', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_units', { units: 'in', displayPrecision: 2 });

    expect(result.affected).toHaveLength(0);
    expect(result.document.units).toBe('in');
    expect(result.document.displayPrecision).toBe(2);
    expect(result.summary).toBe('Units set to in, precision 2.');
  });

  it('sets only units, leaves displayPrecision unchanged', () => {
    const doc = createEmptyDocument(); // defaults: mm, 3
    const result = execute(doc, 'set_units', { units: 'ft' });

    expect(result.document.units).toBe('ft');
    expect(result.document.displayPrecision).toBe(3);
  });

  it('sets only displayPrecision, leaves units unchanged', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_units', { displayPrecision: 0 });

    expect(result.document.units).toBe('mm');
    expect(result.document.displayPrecision).toBe(0);
  });

  it('accepts all valid unit values', () => {
    const doc = createEmptyDocument();
    for (const unit of ['mm', 'cm', 'm', 'in', 'ft'] as const) {
      const result = execute(doc, 'set_units', { units: unit });
      expect(result.document.units).toBe(unit);
      expect(result.affected).toHaveLength(0);
    }
  });

  it('is pure — input document is never mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'set_units', { units: 'in', displayPrecision: 2 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // ---------------------------------------------------------------------------
  // Failure paths (graceful no-ops)
  // ---------------------------------------------------------------------------

  it('rejects an invalid unit string — no-op, affected:[]', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_units', { units: 'km' as never });

    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('km');
  });

  it('rejects negative displayPrecision — no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_units', { displayPrecision: -1 });

    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('-1');
  });

  it('rejects non-integer displayPrecision — no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_units', { displayPrecision: 2.5 });

    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('2.5');
  });

  it('no-op when neither units nor displayPrecision provided', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_units', {});

    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });
});

// ---------------------------------------------------------------------------
// formatLength helper
// ---------------------------------------------------------------------------

describe('formatLength', () => {
  it('formats with document units and displayPrecision', () => {
    const doc = createEmptyDocument(); // mm, precision 3
    expect(formatLength(doc, 12.5)).toBe('12.500 mm');
  });

  it('respects a custom precision', () => {
    const doc = { ...createEmptyDocument(), units: 'in' as const, displayPrecision: 2 };
    expect(formatLength(doc, 12.5)).toBe('12.50 in');
  });

  it('rounds to displayPrecision decimal places', () => {
    const doc = { ...createEmptyDocument(), units: 'mm' as const, displayPrecision: 1 };
    expect(formatLength(doc, 12.567)).toBe('12.6 mm');
  });

  it('precision 0 produces an integer-looking string', () => {
    const doc = { ...createEmptyDocument(), units: 'm' as const, displayPrecision: 0 };
    expect(formatLength(doc, 3.7)).toBe('4 m');
  });
});

// ---------------------------------------------------------------------------
// Persistence round-trip
// ---------------------------------------------------------------------------

describe('persistence — units + displayPrecision', () => {
  it('round-trips units and displayPrecision through serialize/deserialize', () => {
    const doc = { ...createEmptyDocument(), units: 'in' as const, displayPrecision: 4 };
    const json = serializeDocument(doc);
    const restored = deserializeDocument(json);

    expect(restored.units).toBe('in');
    expect(restored.displayPrecision).toBe(4);
  });

  it('deserializing an older document without units/displayPrecision defaults to mm/3', () => {
    // Simulate a legacy document serialized before the units fields existed.
    const doc = createEmptyDocument();
    const envelope = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    const inner = envelope['document'] as Record<string, unknown>;
    delete inner['units'];
    delete inner['displayPrecision'];
    const legacyJson = JSON.stringify(envelope);

    const restored = deserializeDocument(legacyJson);
    expect(restored.units).toBe('mm');
    expect(restored.displayPrecision).toBe(3);
  });

  it('deserializing a document with an invalid unit value defaults to mm', () => {
    const doc = createEmptyDocument();
    const envelope = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    const inner = envelope['document'] as Record<string, unknown>;
    inner['units'] = 'parsec';
    const badJson = JSON.stringify(envelope);

    const restored = deserializeDocument(badJson);
    expect(restored.units).toBe('mm');
  });
});
