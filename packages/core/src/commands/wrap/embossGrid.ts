import type { CadDocument, Vec2 } from '../../model/types';
import { mapSegment2, sampleSegment, type PlaneSegment } from '../../geometry/planeSegments';
import type { CommandResult } from '../types';
import type { EmbossFail, EmbossGrid } from './embossRequest';
import type { ChartRegion, SketchOutline } from './sketchProfiles';

const MAX_INSTANCES = 2000;

export interface Gridded {
  readonly outlines: SketchOutline[];
  readonly regions: ChartRegion[];
}

const shifted = (chain: readonly PlaneSegment[], dx: number, dy: number): PlaneSegment[] =>
  chain.map((piece) => mapSegment2(piece, ([x, y]): Vec2 => [x + dx, y + dy]));

/** The lattice of a seed: one copy of every region per grid node. */
function repeated(regions: readonly ChartRegion[], grid: EmbossGrid): ChartRegion[] {
  const out: ChartRegion[] = [];
  for (let j = 0; j < grid.countY; j++)
    for (let i = 0; i < grid.countX; i++) {
      const [dx, dy] = [i * grid.pitchX, j * grid.pitchY];
      out.push(
        ...regions.map((region) => ({ outer: shifted(region.outer, dx, dy), holes: region.holes.map((hole) => shifted(hole, dx, dy)) })),
      );
    }
  return out;
}

export function repeatOnGrid(
  doc: CadDocument,
  grid: EmbossGrid,
  seedOutlines: readonly SketchOutline[],
  seedRegions: readonly ChartRegion[],
  fail: EmbossFail,
): Gridded | CommandResult {
  if (grid.countX * grid.countY > MAX_INSTANCES)
    return fail('WRP_PARAM_INVALID', `${grid.countX * grid.countY} instances exceed the limit of ${MAX_INSTANCES}`, ['grid']);
  const points = seedRegions.flatMap((region) => region.outer.flatMap((piece) => sampleSegment(piece, 9)));
  const extent: Vec2 = [
    Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1])) - Math.min(...points.map((p) => p[1])),
  ];
  if ((grid.countX > 1 && grid.pitchX < extent[0] * (1 - 1e-9)) || (grid.countY > 1 && grid.pitchY < extent[1] * (1 - 1e-9)))
    return fail(
      'WRP_PATTERN_OVERLAP',
      `the seed is ${extent[0].toPrecision(6)} x ${extent[1].toPrecision(6)} ${doc.units}: a pitch of ${grid.pitchX} x ${grid.pitchY} makes instances overlap`,
      ['grid'],
    );
  const regions = repeated(seedRegions, grid);
  const outlines = seedOutlines.map(
    (outline, k): SketchOutline =>
      k === 0
        ? { ...outline, regions, open: [], area: seedOutlines.reduce((sum, o) => sum + o.area, 0) * grid.countX * grid.countY }
        : { ...outline, regions: [], open: [], area: 0 },
  );
  return { outlines, regions };
}
