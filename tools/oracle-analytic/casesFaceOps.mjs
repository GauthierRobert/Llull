// SC-F1 face operations: split body (any kernel), push-pull, draft and split face (exact kernel).
import { BOTH, EXACT_ONLY, addCase } from './caseKit.mjs';
import { box, part } from './formulas.mjs';

export function faceOpCases(out) {
  const slab = box([20, 10, 6]);
  addCase(out, {
    family: 'split',
    name: 'split-body-box-z',
    description: '20x10x6 block split by the plane z = 1 into two bodies',
    formula: 'V = abc; A = 2(ab + bc + ca) + 2 ab (the two new cut faces); centroid and bbox unchanged',
    kernels: BOTH,
    bodies: 2,
    p: part(slab.v, slab.a + 2 * 20 * 10, slab.c, slab.min, slab.max),
    actions: [
      { command: 'add_box', params: { size: [20, 10, 6] }, as: 'a' },
      { command: 'split_body', params: { id: '$a', plane: { origin: [0, 0, 1], normal: [0, 0, 1] } } },
    ],
  });
  const cube = box([10, 10, 10]);
  addCase(out, {
    family: 'split',
    name: 'split-body-cube-diagonal',
    description: '10 mm cube split through its centre by the vertical diagonal plane (normal [1, 1, 0])',
    formula: 'V = a^3; the cut is a 10 sqrt2 x 10 rectangle: A = 6 a^2 + 2 * 100 sqrt2',
    kernels: BOTH,
    bodies: 2,
    p: part(cube.v, cube.a + 2 * 100 * Math.SQRT2, cube.c, cube.min, cube.max),
    actions: [
      { command: 'add_box', params: { size: [10, 10, 10] }, as: 'a' },
      { command: 'split_body', params: { id: '$a', plane: { origin: [0, 0, 0], normal: [1, 1, 0] } } },
    ],
  });
  addCase(out, {
    family: 'pushpull',
    name: 'push-pull-top-out',
    description: 'top face of a 10 mm cube pulled out by 5',
    formula: 'a 10 x 10 x 15 box from z = -5 to 10: V = 1500, A = 2*100 + 4*150, centroid z = 2.5',
    kernels: EXACT_ONLY,
    p: box([10, 10, 15], [0, 0, 2.5]),
    actions: [
      { command: 'add_box', params: { size: [10, 10, 10] }, as: 'a' },
      { command: 'push_pull_face', params: { id: '$a', faceNear: [0, 0, 5], distance: 5 } },
    ],
  });
  addCase(out, {
    family: 'pushpull',
    name: 'push-pull-top-in',
    description: 'top face of a 10 mm cube pushed in by 3',
    formula: 'a 10 x 10 x 7 box from z = -5 to 2: V = 700, A = 2*100 + 4*70, centroid z = -1.5',
    kernels: EXACT_ONLY,
    p: box([10, 10, 7], [0, 0, -1.5]),
    actions: [
      { command: 'add_box', params: { size: [10, 10, 10] }, as: 'a' },
      { command: 'push_pull_face', params: { id: '$a', faceNear: [0, 0, 5], distance: -3 } },
    ],
  });
  const theta = (5 * Math.PI) / 180;
  addCase(out, {
    family: 'draft',
    name: 'draft-one-side-5deg',
    description: 'the x+ side of a 10 mm cube drafted 5 degrees along +z about the bottom face (the part narrows toward the pull)',
    formula: 'removed wedge = w h^2 tan(theta) / 2 = 10 * 100 * tan(5 deg) / 2; bbox unchanged (the side keeps its bottom edge)',
    kernels: EXACT_ONLY,
    area: null,
    centroid: false,
    p: part(1000 - (10 * 100 * Math.tan(theta)) / 2, null, [0, 0, 0], cube.min, cube.max),
    actions: [
      { command: 'add_box', params: { size: [10, 10, 10] }, as: 'a' },
      { command: 'draft_faces', params: { id: '$a', facesNear: [[5, 0, 0]], angle: 5, pull: [0, 0, 1] } },
    ],
  });
  addCase(out, {
    family: 'pushpull',
    name: 'split-face-then-push-half',
    description: 'top face of a 20x10x10 block split at x = 0, then its x > 0 half pulled up by 4',
    formula: 'V = 2000 + 10*10*4; A = 1000 + 4 * 10*4 (front, back, end and the step face); centroid = (400 (5, 0, 7)) / 2400',
    kernels: EXACT_ONLY,
    p: part(2400, 1160, [(400 * 5) / 2400, 0, (400 * 7) / 2400], [-10, -5, -5], [10, 5, 9]),
    actions: [
      { command: 'add_box', params: { size: [20, 10, 10] }, as: 'a' },
      { command: 'split_face', params: { id: '$a', facesNear: [[5, 0, 5]], plane: { origin: [0, 0, 0], normal: [1, 0, 0] } }, as: 'b' },
      { command: 'push_pull_face', params: { id: '$b', faceNear: [5, 0, 5], distance: 4 } },
    ],
  });
}
