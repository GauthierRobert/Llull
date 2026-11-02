/** Fixtures of the plant 05 ISO M5 tests: the pack's S-501 line (SC-ISO-08) and a routed line with a support. */

import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply } from '../../../helpers/commandAssertions';
import { addTie, cs150Line } from '../piping/rteFixtures';

/** SC-ISO-08 line: DN80 with a 45 degree horizontal offset and two shoes. */
export function s501(): CadDocument {
  let doc = apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0 });
  doc = apply(doc, 'add_pipe_run', {
    points: [
      [0, 0, 2000],
      [2000, 0, 2000],
      [3000, 1000, 2000],
      [5000, 1000, 2000],
    ],
    dn: 80,
    line: 'S-501',
    service: 'steam condensate',
  });
  const pipeId = Object.values(doc.building?.elements ?? {}).find((element) => element.category === 'pipe')?.id as string;
  return apply(doc, 'add_pipe_support', {
    pipeId,
    at: [
      [1000, 0, 2000],
      [4000, 1000, 2000],
    ],
    type: 'shoe',
  });
}

export function routedWithSupport(): { doc: CadDocument; lineId: string } {
  const line = cs150Line(100, '7001');
  const a = addTie(line.doc, 'SP-A', [0, 0, 1000], [1, 0, 0]);
  let doc = apply(a.doc, 'add_level', { name: 'Grade', elevation: 0 });
  doc = apply(doc, 'route_pipe', { lineId: line.lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 6000 }] });
  doc = apply(doc, 'add_pipe_support', { runId: doc.plant?.piping?.runOrder[0], at: [[3000, 0, 1000]], type: 'guide' });
  return { doc, lineId: line.lineId };
}
