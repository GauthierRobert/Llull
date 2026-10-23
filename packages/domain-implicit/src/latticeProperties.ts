/** lattice_properties: strut counts and lengths, relative density closed form and measured, Maxwell count, TPMS wall and surface facts (05 IMP 4.4, 5.4, 5.5). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { resolveFieldEngine } from '@core/geometry/field/engine';
import type { Vec3 } from '@core/model/types';
import { refuseImplicit } from './codes';
import { compileField } from './compile';
import { quadratureVolume } from './measure';
import { type FieldNode, type StrutsNode, type TpmsNode, fieldOf, withField } from './model';
import { KNOWN_CLASS, strutBookkeeping, strutGeometry } from './struts';
import { TPMS_FACTS } from './tpms';

const TOLERANCE = 1e-6;
const MAX_BLOCK = 40;

type Box = { readonly min: Vec3; readonly max: Vec3 };

/** Whole cells per axis when `box` is a block of the lattice (min on the lattice, extents whole cells), else null. */
function wholeBlock(node: StrutsNode, box: Box): [number, number, number] | null {
  const counts = [0, 1, 2].map((axis) => {
    const cell = node.cellSize[axis] as number;
    const extent = ((box.max[axis] as number) - (box.min[axis] as number)) / cell;
    const offset = ((box.min[axis] as number) - (node.origin[axis] as number)) / cell;
    const whole = Math.abs(extent - Math.round(extent)) < TOLERANCE && Math.abs(offset - Math.round(offset)) < TOLERANCE;
    return whole ? Math.round(extent) : NaN;
  });
  return counts.every((c) => c >= 1 && c <= MAX_BLOCK) && node.rotation.every((r) => r === 0) ? (counts as [number, number, number]) : null;
}

/** Nodes and beams (both ends inside the closed block) of an aligned block of `counts` cells, in cell units. */
function blockCounts(node: StrutsNode, counts: readonly [number, number, number]): { nodes: number; beams: number } {
  const { set } = strutGeometry(node.cell, [1, 1, 1], 1, undefined);
  const inside = (p: Vec3): boolean => p.every((c, axis) => c > -TOLERANCE && c < (counts[axis] as number) + TOLERANCE);
  const key = (p: Vec3): string => p.map((c) => Math.round(c * 1e6)).join(',');
  const nodes = new Set<string>();
  const beams = new Set<string>();
  for (let i = 0; i <= counts[0]; i += 1)
    for (let j = 0; j <= counts[1]; j += 1)
      for (let k = 0; k <= counts[2]; k += 1)
        for (const beam of set.beams) {
          const [a, b] = [set.nodes[beam.a], set.nodes[beam.b]];
          if (a === undefined || b === undefined) continue;
          const [pa, pb]: [Vec3, Vec3] = [
            [a[0] + i, a[1] + j, a[2] + k],
            [b[0] + i, b[1] + j, b[2] + k],
          ];
          if (!inside(pa) || !inside(pb)) continue;
          nodes.add(key(pa));
          nodes.add(key(pb));
          beams.add([key(pa), key(pb)].sort().join('|'));
        }
  return { nodes: nodes.size, beams: beams.size };
}

function strutFacts(node: StrutsNode, box: Box | null): Record<string, unknown> {
  const book = strutBookkeeping(node.cell);
  const [ax, ay, az] = node.cellSize;
  const cellVolume = ax * ay * az;
  const lengths = strutGeometry(node.cell, node.cellSize, node.radius, undefined).lengths;
  const lengthPerCell = lengths.reduce((a, b) => a + b, 0);
  const block = box === null ? null : wholeBlock(node, box);
  const cells = box === null ? null : ((box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2])) / cellVolume;
  const counted = block === null ? null : blockCounts(node, block);
  const rho1 = (Math.PI * node.radius ** 2 * lengthPerCell) / cellVolume;
  const longest = Math.max(...lengths);
  const maxwell = book.beams - 3 * book.nodes + 6;
  return {
    cell: node.cell,
    cellSize: node.cellSize,
    cells: block === null ? cells : block[0] * block[1] * block[2],
    cellsExact: block !== null,
    beamsPerCell: book.beams,
    nodesPerCell: book.nodes,
    nodes: counted?.nodes ?? (cells === null ? null : book.nodes * cells),
    beams: counted?.beams ?? (cells === null ? null : book.beams * cells),
    countsExact: counted !== null,
    totalLength: cells === null ? null : lengthPerCell * cells,
    lengthPerCell,
    radiusMin: node.radius,
    radiusMax: Math.max(node.radius, node.nodeRadius ?? 0),
    slendernessMax: longest / (2 * node.radius),
    valence: { min: book.valenceMin, max: book.valenceMax },
    rho1,
    maxwell: {
      b: book.beams,
      j: book.nodes,
      M: maxwell,
      class: KNOWN_CLASS[node.cell],
      basis: 'class from the literature (Deshpande, Ashby, Fleck 2001); M = b - 3j + 6 is a necessary condition only',
    },
  };
}

function tpmsFacts(node: TpmsNode): Record<string, unknown> {
  const facts = TPMS_FACTS[node.kind];
  const smallest = Math.min(...node.cellSize);
  const volume = node.cellSize[0] * node.cellSize[1] * node.cellSize[2];
  const faces = node.form === 'sheet' ? 2 : 1;
  const thickness =
    node.form === 'network'
      ? null
      : node.normalize === 'gradient'
        ? { min: node.control.value, max: node.control.value }
        : {
            min: (2 * node.control.value) / ((2 * Math.PI * facts.gradOnSurface[1]) / smallest),
            max: (2 * node.control.value) / ((2 * Math.PI * facts.gradOnSurface[0]) / smallest),
          };
  return {
    kind: node.kind,
    form: node.form,
    cellSize: node.cellSize,
    control: node.control,
    normalized: node.normalize === 'gradient',
    relativeDensityTarget: node.relativeDensityTarget ?? null,
    thicknessMin: thickness?.min ?? null,
    thicknessMax: thickness?.max ?? null,
    specificSurface: (faces * facts.specificSurface * smallest ** 2) / volume,
    specificSurfaceNote:
      'nodal-surface area per cell volume (a = 1: ' +
      facts.specificSurface +
      '), doubled for a sheet (two faces); first order in the wall thickness',
    poreDiameterMax: null,
    notComputed: ['poreDiameterMax'],
  };
}

const MECHANICS_SOURCE = 'Gibson & Ashby, Cellular Solids (2nd ed., 1997): scaling exponent only; no coefficient is fitted';

/**
 * @affects none (read-only); data = per-cell and block bookkeeping, rho1 (closed form, no node overlap), rhoMeasured (low-discrepancy quadrature of one cell), Maxwell class
 * @invariant counts are exact for a block of whole cells aligned with the lattice origin (nodes / beams with both ends inside the block), otherwise per-cell values times the cell count; mechanics are opt-in and always flagged unverified + reviewRequired
 * @invariant field-engine-optional: reads ctx.fieldEngine when present, else the built-in TS engine (no kernel is needed)
 * @failure unknown id or not a lattice field -> IMP_FIELD_NOT_FOUND
 */
export const latticeProperties = defineCommand({
  name: 'lattice_properties',
  description:
    'Describe a lattice field (from add_strut_lattice or add_tpms_lattice). Struts: cells, nodes, beams (exact for a region that is a block of whole cells on the lattice), total length, radius range, slenderness, node valence, ' +
    'rho1 = pi r^2 L / cell volume (no node overlap), rhoMeasured (quadrature of one cell, includes overlap), and the Maxwell count b - 3j + 6 with the literature class (octet stretch-dominated, the others bending-dominated). ' +
    'TPMS: wall thickness range, specific surface, control. estimateMechanics adds a Gibson-Ashby scaling law marked unverified and reviewRequired (never a design value).',
  annotations: { readOnly: true },
  params: z.object({
    id: z.string().describe('Id of a lattice field (struts or tpms node).'),
    estimateMechanics: z.boolean().optional().describe('Add the scaling-law estimate of the stiffness (opt-in; unverified, needs review).'),
    resolution: z
      .number()
      .optional()
      .describe(
        'Quadrature cells along the smallest cell axis for rhoMeasured (integer 16..128, default 64; the error falls roughly with 1/resolution, 128 takes seconds).',
      ),
  }),
  run: (doc, { id, estimateMechanics, resolution = 64 }, ctx): CommandResult => {
    const node: FieldNode | undefined = fieldOf(doc, id);
    if (node === undefined || (node.op !== 'struts' && node.op !== 'tpms'))
      return refuseImplicit(
        doc,
        'lattice_properties',
        'IMP_FIELD_NOT_FOUND',
        `no lattice field '${id}' (give the id returned by add_strut_lattice / add_tpms_lattice)`,
        [id],
        ['params.id'],
      );
    const engine = resolveFieldEngine(ctx?.fieldEngine);
    const compiled = compileField(doc, id);
    if (!compiled.ok) return refuseImplicit(doc, 'lattice_properties', compiled.code, compiled.message, compiled.ids);
    const box = compiled.program.bounds;
    const bare: FieldNode =
      node.op === 'tpms'
        ? (({ region: clipped, map: wrapped, ...rest }) => (
            void clipped,
            void wrapped,
            { ...rest, rotation: [0, 0, 0] as Vec3, id: '__cell' }
          ))(node)
        : (({ region: clipped, ...rest }) => (void clipped, { ...rest, rotation: [0, 0, 0] as Vec3, id: '__cell' }))(node);
    const cellProgram = compileField(withField(doc, bare), '__cell');
    const cellBox: Box = {
      min: node.origin,
      max: [node.origin[0] + node.cellSize[0], node.origin[1] + node.cellSize[1], node.origin[2] + node.cellSize[2]],
    };
    const voxel = Math.min(...node.cellSize) / Math.min(128, Math.max(16, Math.round(resolution)));
    const measured = cellProgram.ok
      ? quadratureVolume(engine, cellProgram.program, null, cellBox, voxel)
      : { code: cellProgram.code, message: cellProgram.message };
    const rhoMeasured = 'code' in measured ? null : measured.volume / (node.cellSize[0] * node.cellSize[1] * node.cellSize[2]);
    const facts = node.op === 'struts' ? strutFacts(node, box) : tpmsFacts(node);
    const mechanics =
      estimateMechanics === true
        ? node.op === 'struts'
          ? {
              law: 'E/Es = C rho^n',
              exponent: KNOWN_CLASS[node.cell] === 'stretch' ? 1 : 2,
              coefficient: null,
              source: MECHANICS_SOURCE,
              unverified: true,
              reviewRequired: true,
              warning: 'IMP_MECHANICS_UNVERIFIED',
            }
          : {
              law: 'E/Es = C rho^n',
              exponent: null,
              coefficient: null,
              source: 'no verified law for TPMS in this version: test coupons',
              unverified: true,
              reviewRequired: true,
              warning: 'IMP_MECHANICS_UNVERIFIED',
            }
        : undefined;
    const data = {
      id,
      op: node.op,
      ...facts,
      rhoMeasured,
      rhoMeasuredNote:
        'solid fraction of one unrotated rectangular cell (rotation and any cylindrical map ignored), low-discrepancy quadrature (struts) / midpoint (TPMS); includes node overlap',
      ...(mechanics === undefined ? {} : { mechanics }),
      unit: doc.units,
      unverified: compiled.unverified || mechanics !== undefined,
      provenance: { method: 'closed form + quadrature of one cell', engine: engine.name, voxel, deterministic: true },
    };
    return report(
      doc,
      `lattice_properties: ${id} (${node.op === 'struts' ? node.cell : node.kind}) rho measured ${rhoMeasured === null ? 'n/a' : rhoMeasured.toPrecision(5)}${node.op === 'struts' ? `, rho1 ${(facts['rho1'] as number).toPrecision(5)}, ${String(facts['beamsPerCell'])} beams/cell` : ''}${mechanics === undefined ? '' : '; mechanics estimate is computed by llull, not approved: needs a qualified engineer'}.`,
      data,
    );
  },
});
