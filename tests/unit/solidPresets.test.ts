import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { rotatedEntityBounds } from '@core/commands/sceneRotatedBounds';
import {
  SOLID_PRESETS,
  nextPlacement,
  solidCommandParams,
} from '@ui/components/toolbar/solidPresets';

function addPreset(doc: CadDocument, index: number): CadDocument {
  const preset = SOLID_PRESETS[index]!;
  return execute(doc, preset.command, solidCommandParams(preset, nextPlacement(doc))).document;
}

describe('solid presets', () => {
  it('every preset creates exactly one solid resting on the ground plane', () => {
    for (const preset of SOLID_PRESETS) {
      const result = execute(
        createEmptyDocument(),
        preset.command,
        solidCommandParams(preset, [0, 0, 0]),
      );
      expect(result.affected, preset.command).toHaveLength(1);
      const entity = result.document.entities[result.affected[0]!]!;
      expect(rotatedEntityBounds(entity).min[2], preset.command).toBeCloseTo(0, 6);
    }
  });

  it('drops the first solid at the origin', () => {
    expect(nextPlacement(createEmptyDocument())).toEqual([0, 0, 0]);
  });

  it('never overlaps existing solids and stays near the origin', () => {
    let doc = createEmptyDocument();
    for (let i = 0; i < 12; i++) doc = addPreset(doc, i % SOLID_PRESETS.length);
    const boxes = doc.order.map((id) => rotatedEntityBounds(doc.entities[id]!));
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        const A = boxes[a]!;
        const B = boxes[b]!;
        const overlapX = A.min[0] < B.max[0] && B.min[0] < A.max[0];
        const overlapY = A.min[1] < B.max[1] && B.min[1] < A.max[1];
        expect(overlapX && overlapY, `${a} vs ${b}`).toBe(false);
      }
    }
    for (const box of boxes) expect(Math.abs(box.min[0])).toBeLessThan(10);
  });

  it('falls back past the +X edge when the area around the origin is full', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [200, 200, 1] }).document;
    const [x, y, z] = nextPlacement(doc);
    expect(x).toBeGreaterThan(100);
    expect([y, z]).toEqual([0, 0]);
  });

  it('treats reserved drop points as occupied', () => {
    const doc = createEmptyDocument();
    const first = nextPlacement(doc);
    const second = nextPlacement(doc, [first]);
    expect(second).not.toEqual(first);
    expect(nextPlacement(doc, [first, second])).not.toEqual(second);
  });
});
