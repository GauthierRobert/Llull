/** A large randomized industrial building for the `check_clashes` broad-phase tests: steel members, pipes and equipment with clearance zones. */
import type { BuildingElement } from '@aec/building/types';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

/** `count` elements spread over a square of side `side` mm (density sets how many pairs overlap); ids and marks are deterministic. */
export function clashStressDocument(count: number, seed: number, side = 60_000): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'set_units', { units: 'mm' }).document;
  doc = execute(doc, 'add_level', { name: 'Ground', elevation: 0, height: 8000 }).document;
  const levelId = doc.building?.levelOrder[0] ?? 'level-1';
  const next = rng(seed);
  const elements: Record<string, BuildingElement> = {};
  const elementOrder: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `stress-${i}`;
    const [x, y, z] = [next() * side, next() * side, 200 + next() * 4000];
    const base = { id, mark: `S${i}`, entityIds: [], levelId };
    const kind = i % 4;
    const element: BuildingElement =
      kind === 0
        ? {
            ...base,
            category: 'member',
            role: 'beam',
            profile: 'IPE200',
            start: [x, y, z],
            end: [x + 800 + next() * 3000, y + next() * 600, z],
            roll: 0,
            material: 'S355',
          }
        : kind === 1
          ? {
              ...base,
              category: 'pipe',
              points: [
                [x, y, z],
                [x + next() * 3000, y, z],
                [x + next() * 3000, y + next() * 3000, z],
              ],
              diameter: 150,
              service: 'water',
              material: 'steel',
            }
          : kind === 2
            ? {
                ...base,
                category: 'equipment',
                name: `E${i}`,
                location: [x, y],
                angle: next() * 3,
                size: [1500, 1200, 2000],
                clearance: 600,
                weight: 0,
              }
            : {
                ...base,
                category: 'member',
                role: 'column',
                profile: 'IPE200',
                start: [x, y, 0],
                end: [x, y, z],
                roll: 0,
                material: 'S355',
              };
    elements[id] = element;
    elementOrder.push(id);
  }
  const building = doc.building;
  if (building === undefined) throw new Error('add_level created no building');
  return { ...doc, building: { ...building, elements, elementOrder } };
}
