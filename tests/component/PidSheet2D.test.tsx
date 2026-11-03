import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { PidModel } from '@aec/index';
import { apply } from '../helpers/commandAssertions';
import { PID_PALETTE_DARK, PID_PALETTE_LIGHT, defaultPidSheet, pidSheetItems } from '@ui/viewport/2d/pidSheetItems';

function authored(): PidModel | undefined {
  let doc = apply(createEmptyDocument(), 'create_pid_sheet', { number: 'PID-001' });
  doc = apply(doc, 'add_pid_equipment', { sheet: 'PID-001', class: 'Tank', tag: 'T-101', at: [100, 100] });
  doc = apply(doc, 'add_pid_instrument', { sheet: 'PID-001', tag: 'PI-201', at: [200, 200], location: 'local_panel' });
  return doc.plant?.pid;
}

describe('pidSheetItems (2D P&ID branch helper)', () => {
  it('is empty without a P&ID model', () => {
    expect(defaultPidSheet(undefined)).toBeUndefined();
    expect(pidSheetItems(undefined, PID_PALETTE_DARK)).toEqual([]);
  });

  it('maps the first sheet to layer-coloured primitives', () => {
    const pid = authored();
    expect(defaultPidSheet(pid)?.number).toBe('PID-001');
    const items = pidSheetItems(pid, PID_PALETTE_DARK);
    expect(items.length).toBeGreaterThan(0);
    const equipment = items.filter((i) => i.primitive.layer === 'PID-EQPT');
    const instruments = items.filter((i) => i.primitive.layer === 'PID-INST');
    expect(equipment.length).toBeGreaterThan(0);
    expect(equipment.every((i) => i.color === PID_PALETTE_DARK.equipment)).toBe(true);
    expect(instruments.every((i) => i.color === PID_PALETTE_DARK.instrument)).toBe(true);
    expect(pidSheetItems(pid, PID_PALETTE_LIGHT)[0]?.color).not.toBe(items[0]?.color);
  });

  it('drops hidden layers', () => {
    const items = pidSheetItems(authored(), PID_PALETTE_DARK, (layer) => layer !== 'PID-EQPT');
    expect(items.some((i) => i.primitive.layer === 'PID-EQPT')).toBe(false);
    expect(items.some((i) => i.primitive.layer === 'PID-INST')).toBe(true);
  });
});
