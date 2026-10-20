/**
 * Shell / plane-stress results (05 §5.7, decision for open question 7). CalculiX expands S* / CPS* elements into 3D volume elements and, by
 * default, writes the .frd on the EXPANDED nodes (new node numbers). The expanded nodes are found geometrically, not by number: for every mesh
 * node of a 2D part the nodes at x + (1/2 - offset) t n (top fibre) and x - (1/2 + offset) t n (bottom fibre) are looked up among the .frd node
 * coordinates (n = averaged element normal, within t / 4). The mesh node then carries the mean of both (membrane value: displacement of the
 * midsurface, membrane stress) and the stress of each fibre in the extra fields `STRESS_TOP` / `STRESS_BOT`. Values written on the original node
 * numbers (an `OUTPUT=2D` file) are kept as they are when no expanded node is found.
 */

import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { add3, cross3, len3, normalize3, scale3, sub3 } from '@lib/vec3';
import { buildDeckContext } from '../decks/context';
import { SHELL_OFFSET } from './meshGeometry';

type Steps = FeResultsArtifact['steps'];

/** Element types of 2D parts (shells and plane stress). */
export const PLANAR_TYPES: ReadonlySet<string> = new Set(['S3', 'S4', 'S6', 'S8', 'CPS3', 'CPS4', 'CPS6', 'CPS8']);
/** An expanded node matches a fibre point within this fraction of the thickness. */
const MATCH_FRACTION = 0.25;
const VALUE_WIDTH = 12;

/** Node coordinates of the `2C` block of a CalculiX .frd (fixed columns: id in 4-13, then 12-character values). */
export function parseFrdNodes(text: string): Map<number, Vec3> {
  const nodes = new Map<number, Vec3>();
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s+2C/.test(line)) inBlock = true;
    else if (inBlock && line.startsWith(' -3')) inBlock = false;
    else if (inBlock && line.startsWith(' -1')) {
      const id = Number.parseInt(line.slice(3, 13), 10);
      const cell = (k: number): number => Number.parseFloat(line.slice(13 + k * VALUE_WIDTH, 13 + (k + 1) * VALUE_WIDTH));
      const point: Vec3 = [cell(0), cell(1), cell(2)];
      if (Number.isFinite(id) && point.every(Number.isFinite)) nodes.set(id, point);
    }
  }
  return nodes;
}

/** Area-weighted unit normal at every node of the 2D blocks, with the thickness and offset of its part (analysis units). */
function planarNodes(
  doc: CadDocument,
  analysisId: string,
  mesh: FeMeshArtifact,
): Map<number, { readonly normal: Vec3; readonly thickness: number; readonly offset: number }> {
  if (!mesh.blocks.some((block) => PLANAR_TYPES.has(block.type))) return new Map();
  const ctx = buildDeckContext(doc, analysisId, mesh);
  const coordinates = new Map(mesh.nodes.map(([id, x, y, z]) => [id, [x, y, z] as Vec3]));
  const sums = new Map<number, { normal: Vec3; thickness: number; offset: number }>();
  for (const block of mesh.blocks) {
    if (!PLANAR_TYPES.has(block.type) || ctx === null) continue;
    const idealization = ctx.analysis.parts[block.entityId];
    const thickness =
      idealization?.kind === 'shell' && typeof idealization.thickness === 'number'
        ? idealization.thickness
        : idealization?.kind === 'plane_stress'
          ? idealization.thickness
          : 0;
    const offset = idealization?.kind === 'shell' ? SHELL_OFFSET[idealization.offset] : 0;
    for (const [, a = 0, b = 0, c = 0, ...rest] of block.elements) {
      const corners = block.type.endsWith('4') || block.type.endsWith('8') ? [a, b, c, rest[0] ?? c] : [a, b, c];
      const points = corners.map((node): Vec3 => coordinates.get(node) ?? [0, 0, 0]);
      const [p0 = [0, 0, 0], p1 = [0, 0, 0], p2 = [0, 0, 0]] = points;
      const normal = cross3(sub3(p1, p0), sub3(p2, p0));
      for (const node of [a, b, c, ...rest]) {
        const sum = sums.get(node) ?? { normal: [0, 0, 0], thickness: thickness * ctx.lengthToAnalysis, offset };
        sum.normal = add3(sum.normal, normal);
        sums.set(node, sum);
      }
    }
  }
  return new Map([...sums].map(([node, sum]) => [node, { ...sum, normal: len3(sum.normal) > 0 ? normalize3(sum.normal) : sum.normal }]));
}

/** Nearest-point lookup over the .frd nodes with a uniform grid of `cell` size. */
function nearestFinder(nodes: ReadonlyMap<number, Vec3>, cell: number): (point: Vec3, tolerance: number) => number | null {
  const key = (point: Vec3): string => point.map((value) => Math.floor(value / cell)).join(',');
  const grid = new Map<string, number[]>();
  for (const [id, point] of nodes) {
    const bucket = grid.get(key(point));
    if (bucket === undefined) grid.set(key(point), [id]);
    else bucket.push(id);
  }
  return (point, tolerance) => {
    let best: number | null = null;
    let bestDistance = tolerance;
    const [i, j, k] = point.map((value) => Math.floor(value / cell));
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (let dk = -1; dk <= 1; dk++)
          for (const id of grid.get(`${(i ?? 0) + di},${(j ?? 0) + dj},${(k ?? 0) + dk}`) ?? []) {
            const distance = len3(sub3(nodes.get(id) ?? point, point));
            if (distance <= bestDistance) {
              best = id;
              bestDistance = distance;
            }
          }
    return best;
  };
}

/**
 * Result steps on the mesh nodes for a mesh with 2D parts (unchanged steps when it has none).
 * @invariant only mesh node ids remain in every field; STRESS_TOP / STRESS_BOT exist iff a 2D node was matched to its expanded fibres
 * @failure a 2D node with neither its own expanded fibre nodes (candidates: non-mesh node numbers, each used once) nor STRESS under its own number -> FEA_SHELL_RESULTS_UNMAPPED
 */
export function mapShellResults(
  doc: CadDocument,
  analysisId: string,
  mesh: FeMeshArtifact,
  steps: Steps,
  frdText: string,
): { readonly steps: Steps } | { readonly code: string; readonly message: string } {
  const planar = planarNodes(doc, analysisId, mesh);
  if (planar.size === 0) return { steps };
  // Candidates are expanded nodes only (numbers that are not mesh nodes: never a solid node or a node of another part), each used once.
  const meshNodeIds = new Set(mesh.nodes.map(([id]) => id));
  const frdNodes = new Map([...parseFrdNodes(frdText)].filter(([id]) => !meshNodeIds.has(id)));
  let thinnest = Infinity;
  for (const node of planar.values()) if (node.thickness > 0) thinnest = Math.min(thinnest, node.thickness);
  const find = nearestFinder(frdNodes, Number.isFinite(thinnest) ? thinnest : 1);
  const coordinates = new Map(mesh.nodes.map(([id, x, y, z]) => [id, [x, y, z] as Vec3]));
  const fibres = new Map<number, readonly [top: number, bottom: number]>();
  const taken = new Set<number>();
  const unmapped: number[] = [];
  const ownStress = steps[0]?.fields['STRESS']?.values ?? {};
  for (const [node, { normal, thickness, offset }] of planar) {
    const x = coordinates.get(node) ?? [0, 0, 0];
    const tolerance = MATCH_FRACTION * thickness;
    const top = thickness > 0 ? find(add3(x, scale3(normal, (0.5 - offset) * thickness)), tolerance) : null;
    const bottom = thickness > 0 ? find(sub3(x, scale3(normal, (0.5 + offset) * thickness)), tolerance) : null;
    if (top !== null && bottom !== null && top !== bottom && !taken.has(top) && !taken.has(bottom)) {
      fibres.set(node, [top, bottom]);
      taken.add(top);
      taken.add(bottom);
    } else if (!Object.hasOwn(ownStress, String(node))) unmapped.push(node);
  }
  if (unmapped.length > 0)
    return {
      code: 'FEA_SHELL_RESULTS_UNMAPPED',
      message: `${unmapped.length} shell / plane-stress node(s) (first ${unmapped.slice(0, 5).join(', ')}) have no expanded fibre nodes of their own in the .frd (a kink, or a node shared with another part) and no STRESS under their own number`,
    };
  const meshIds = mesh.nodes.map(([id]) => String(id));
  const mapped = steps.map((step) => {
    const fields: Record<string, { components: readonly string[]; values: Record<string, readonly number[]> }> = {};
    for (const [name, field] of Object.entries(step.fields)) {
      const values: Record<string, readonly number[]> = {};
      const topValues: Record<string, readonly number[]> = {};
      const bottomValues: Record<string, readonly number[]> = {};
      for (const id of meshIds) {
        const pair = fibres.get(Number(id));
        const top = pair === undefined ? undefined : field.values[String(pair[0])];
        const bottom = pair === undefined ? undefined : field.values[String(pair[1])];
        if (top !== undefined && bottom !== undefined) {
          values[id] = top.map((value, index) => (value + (bottom[index] ?? value)) / 2);
          topValues[id] = top;
          bottomValues[id] = bottom;
        } else if (Object.hasOwn(field.values, id)) values[id] = field.values[id] ?? [];
      }
      fields[name] = { components: field.components, values };
      if (name === 'STRESS' && Object.keys(topValues).length > 0) {
        fields.STRESS_TOP = { components: field.components, values: topValues };
        fields.STRESS_BOT = { components: field.components, values: bottomValues };
      }
    }
    return { ...step, fields };
  });
  return { steps: mapped };
}
