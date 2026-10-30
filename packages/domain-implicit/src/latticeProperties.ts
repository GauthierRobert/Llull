/** lattice_properties: strut counts and lengths, relative density closed form and measured, Maxwell count, TPMS wall / pore / surface facts, mechanics (05 IMP 4.4, 5.4, 5.5, FR-IMP-31, 34). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { resolveFieldEngine } from '@core/geometry/field/engine';
import type { FieldEngine } from '@core/geometry/field/engineTypes';
import type { FieldProgram } from '@core/geometry/field/program';
import type { CadDocument, Vec3 } from '@core/model/types';
import { refuseImplicit } from './codes';
import { compileField } from './compile';
import { latticeCut } from './beamLattice';
import { bareCell, cellPhaseMeasures, measuredSpecificSurface, nodalSurfaceProgram, strutFacts, tpmsFacts } from './latticeFacts';
import { lawRange } from './lawRange';
import { latticeMechanics } from './mechanics';
import { quadratureVolume } from './measure';
import { type CellMap, type FieldNode, type StrutsNode, type TpmsNode, fieldOf } from './model';
import { surfaceMapOf } from './surfaceMap';
import { KNOWN_CLASS, strutGeometry } from './struts';
import { TPMS_FACTS } from './tpms';

type Box = { readonly min: Vec3; readonly max: Vec3 };

/** Radii (from the map's axis or centre) of region samples: a 24^3 grid over the region box, the points where the region field is <= 0. */
function regionRadii(
  map: Exclude<CellMap, { kind: 'surface_uv' }>,
  box: Box,
  region: FieldProgram | null,
  engine: FieldEngine,
): number[] | null {
  const n = 24;
  const points: number[] = [];
  const spots: Vec3[] = [];
  for (let k = 0; k < n; k += 1)
    for (let j = 0; j < n; j += 1)
      for (let i = 0; i < n; i += 1) {
        const p: Vec3 = [0, 1, 2].map(
          (axis) =>
            (box.min[axis] as number) + ((([i, j, k][axis] as number) + 0.5) / n) * ((box.max[axis] as number) - (box.min[axis] as number)),
        ) as unknown as Vec3;
        spots.push(p);
        points.push(...p);
      }
  const answer = region === null ? null : engine.evaluate(region, Float64Array.from(points), false);
  if (answer?.failure !== undefined) return null;
  const values = answer === null ? null : answer.values;
  const length = map.kind === 'cylindrical' ? Math.hypot(...map.axis) : 1;
  return spots.flatMap((p, index) => {
    if (values !== null && (values[index] as number) > 0) return [];
    const d = [p[0] - map.origin[0], p[1] - map.origin[1], p[2] - map.origin[2]];
    if (map.kind === 'spherical') return [Math.hypot(...d)];
    const along = ((d[0] as number) * map.axis[0] + (d[1] as number) * map.axis[1] + (d[2] as number) * map.axis[2]) / length;
    return [Math.sqrt(Math.max(Math.hypot(...d) ** 2 - along ** 2, 0))];
  });
}

/** Ratio of the longest to the shortest edge of a mapped cell over the radii the region spans (1 = undistorted cells), or null without a map / region. */
function mapStretch(
  doc: CadDocument,
  node: TpmsNode | StrutsNode,
  box: Box | null,
  region: FieldProgram | null,
  engine: FieldEngine,
): { min: number; max: number } | null {
  const map = node.map;
  if (map === undefined || box === null) return null;
  if (map.kind === 'surface_uv') {
    const made = surfaceMapOf(doc, map);
    return made.ok ? made.data.stretch : null;
  }
  const radii = (regionRadii(map, box, region, engine) ?? []).filter((r) => r > 1e-9);
  if (radii.length === 0) return null;
  const sizes = (rho: number): number[] =>
    map.kind === 'cylindrical'
      ? [(2 * Math.PI * rho) / map.cellsAround, node.cellSize[2], map.radialCellSize]
      : [(2 * Math.PI * rho) / map.cellsAround, (Math.PI * rho) / map.cellsPolar, map.radialCellSize];
  const aspects = [Math.min(...radii), Math.max(...radii)].map((rho) => Math.max(...sizes(rho)) / Math.min(...sizes(rho)));
  return { min: Math.min(...aspects), max: Math.max(...aspects) };
}

interface Lattice {
  readonly node: StrutsNode | TpmsNode;
  readonly facts: Record<string, unknown>;
  readonly mechanicsInput: { rho1: number | null; cellClass: 'stretch' | 'bending' | null; radius: number | null };
}

function describeLattice(
  doc: CadDocument,
  node: StrutsNode | TpmsNode,
  engine: FieldEngine,
  box: Box | null,
  resolution: number,
  cellProgram: ReturnType<typeof compileField>,
): Lattice | string {
  if (node.op === 'struts') {
    const radius = lawRange(engine, doc, node.radius, box);
    if (radius === null) return `the graded strut radius '${String(node.radius)}' cannot be ranged: the lattice has no finite region`;
    const facts = strutFacts(node, box, radius);
    const cut = latticeCut(doc, node, engine);
    facts['danglingStruts'] = typeof cut === 'string' ? null : cut.dangling;
    facts['cutBeams'] =
      typeof cut === 'string'
        ? { available: false, reason: cut }
        : { available: true, ...cut, note: 'dangling = beams with exactly one end inside the region; the region trims them' };
    const mean = (radius.min + radius.max) / 2;
    return {
      node,
      facts,
      mechanicsInput: { rho1: (facts['rho1'] as number | null) ?? null, cellClass: KNOWN_CLASS[node.cell], radius: mean },
    };
  }
  const value = lawRange(engine, doc, node.control.value, box);
  if (value === null) return `the graded control '${String(node.control.value)}' cannot be ranged: the lattice has no finite region`;
  const table = TPMS_FACTS[node.kind].specificSurface;
  const volume = node.cellSize[0] * node.cellSize[1] * node.cellSize[2];
  const measured = table === null ? measuredSpecificSurface(engine, nodalSurfaceProgram(node), node.cellSize, 48) : null;
  const surface =
    table !== null
      ? { perVolume: (table * Math.min(...node.cellSize) ** 2) / volume, source: `reference table, a = 1: ${table}` }
      : { perVolume: measured ?? NaN, source: 'measured: mesh area of the nodal surface of one cell at 48 voxels per edge' };
  const phases = cellProgram.ok ? cellPhaseMeasures(engine, cellProgram.program, node, resolution) : null;
  const facts = tpmsFacts(node, value, surface, phases);
  return { node, facts, mechanicsInput: { rho1: null, cellClass: null, radius: null } };
}

/**
 * @affects none (read-only); data = per-cell and block bookkeeping, rho1 (closed form, no node overlap), rhoMeasured (low-discrepancy quadrature of one cell), Maxwell class, TPMS wall / pore / surface, optional mechanics
 * @invariant counts are exact for a block of whole cells aligned with the lattice origin (nodes / beams with both ends inside the block), otherwise per-cell values times the cell count; mechanics are opt-in and always flagged unverified + reviewRequired
 * @invariant field-engine-optional: reads ctx.fieldEngine when present, else the built-in TS engine (no kernel is needed)
 * @failure unknown id or not a lattice field -> IMP_FIELD_NOT_FOUND; a graded law over an unbounded lattice -> IMP_FIELD_UNBOUNDED
 */
export const latticeProperties = defineCommand({
  name: 'lattice_properties',
  description:
    'Describe a lattice field (from add_strut_lattice or add_tpms_lattice). Struts: cells, nodes, beams (exact for a region that is a block of whole cells on the lattice), total length, radius range (graded laws are ranged over the region), slenderness, node valence, ' +
    'rho1 = pi r^2 L / cell volume (no node overlap), rhoMeasured (quadrature of one cell, includes overlap), and the Maxwell count b - 3j + 6 with the class (octet stretch-dominated, the others bending-dominated). ' +
    'TPMS: control range, wall thickness (declared and measured by the distance transform, +-resolution), largest pore diameter, specific surface (table for gyroid / P / diamond, measured mesh area for the others), cell stretch of a cylindrical / spherical map. ' +
    'estimateMechanics adds the affine stretch-only stiffness of a strut cell (exact for the octet truss, an upper bound for bending-dominated cells) and the Gibson-Ashby law E/Es = C rho^n with the exponent of the class and the coefficient YOU give in scaling; ' +
    'baseMaterial {youngModulusMpa, source} turns the ratio into MPa. Always unverified and reviewRequired: never a design value.',
  annotations: { readsMeshTriangles: true, readOnly: true },
  params: z.object({
    id: z.string().describe('Id of a lattice field (struts or tpms node).'),
    estimateMechanics: z.boolean().optional().describe('Add the stiffness estimate (opt-in; unverified, needs review).'),
    baseMaterial: z
      .object({
        youngModulusMpa: z.number().describe('Young modulus Es of the solid material in MPa (> 0).'),
        source: z.string().describe('Where Es comes from (data sheet, coupon test, ...). Required.'),
      })
      .optional()
      .describe('Solid material for the stiffness in MPa; without it only ratios E/Es are given.'),
    scaling: z
      .object({
        exponent: z.number().describe('Exponent n of E/Es = C rho^n (1 stretch-dominated, 2 bending-dominated for strut lattices).'),
        coefficient: z.number().describe('Coefficient C (from coupon tests or a cited source; llull ships no table).'),
      })
      .optional()
      .describe(
        'Your Gibson-Ashby scaling law; without a coefficient no E is computed. Required for TPMS lattices (no verified law is built in).',
      ),
    resolution: z
      .number()
      .optional()
      .describe(
        'Samples along the smallest cell axis (integer 16..128, default 64) for rhoMeasured and the TPMS thickness analysis (nodes are capped by the engine: 2^21 for the TS engine); the error falls roughly with 1/resolution.',
      ),
  }),
  run: (doc, { id, estimateMechanics, baseMaterial, scaling, resolution = 64 }, ctx): CommandResult => {
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
    const cellProgram = bareCell(doc, node);
    const cellBox: Box = {
      min: node.origin,
      max: [node.origin[0] + node.cellSize[0], node.origin[1] + node.cellSize[1], node.origin[2] + node.cellSize[2]],
    };
    const samples = Math.min(128, Math.max(16, Math.round(resolution)));
    const voxel = Math.min(...node.cellSize) / samples;
    const measured = cellProgram.ok
      ? quadratureVolume(engine, cellProgram.program, null, cellBox, voxel)
      : { code: cellProgram.code, message: cellProgram.message };
    const rhoMeasured = 'code' in measured ? null : measured.volume / (node.cellSize[0] * node.cellSize[1] * node.cellSize[2]);
    const described = describeLattice(doc, node, engine, box, samples, cellProgram);
    if (typeof described === 'string')
      return refuseImplicit(doc, 'lattice_properties', 'IMP_FIELD_UNBOUNDED', described, [id], ['params.id']);
    const regionCompiled = node.region === undefined ? null : compileField(doc, node.region);
    const stretch =
      node.op === 'tpms' || node.op === 'struts'
        ? mapStretch(doc, node, box, regionCompiled?.ok === true ? regionCompiled.program : null, engine)
        : null;
    const rho = rhoMeasured ?? described.mechanicsInput.rho1;
    const mechanics =
      estimateMechanics === true && rho !== null
        ? latticeMechanics({
            rho,
            cellClass: described.mechanicsInput.cellClass,
            strut:
              node.op === 'struts' && described.mechanicsInput.radius !== null
                ? {
                    set: strutGeometry(node.cell, node.cellSize, described.mechanicsInput.radius, undefined).set,
                    cell: node.cellSize,
                    rho1:
                      (Math.PI *
                        described.mechanicsInput.radius ** 2 *
                        strutGeometry(node.cell, node.cellSize, 1, undefined).lengths.reduce((a, b) => a + b, 0)) /
                      (node.cellSize[0] * node.cellSize[1] * node.cellSize[2]),
                  }
                : null,
            baseMaterial,
            scaling,
          })
        : undefined;
    const data = {
      id,
      op: node.op,
      ...described.facts,
      ...(stretch === null ? {} : { cellStretchMin: stretch.min, cellStretchMax: stretch.max }),
      rhoMeasured,
      rhoMeasuredNote:
        'solid fraction of one unrotated rectangular cell (rotation and any cell map ignored), low-discrepancy quadrature (struts) / midpoint (TPMS); includes node overlap',
      ...(mechanics === undefined ? {} : { mechanics }),
      unit: doc.units,
      unverified: compiled.unverified || mechanics !== undefined,
      provenance: { method: 'closed form + quadrature of one cell', engine: engine.name, voxel, deterministic: true },
    };
    return report(
      doc,
      `lattice_properties: ${id} (${node.op === 'struts' ? node.cell : node.kind}) rho measured ${rhoMeasured === null ? 'n/a' : rhoMeasured.toPrecision(5)}${node.op === 'struts' && typeof described.facts['rho1'] === 'number' ? `, rho1 ${described.facts['rho1'].toPrecision(5)}, ${String(described.facts['beamsPerCell'])} beams/cell` : ''}${mechanics === undefined ? '' : '; mechanics estimate is computed by llull, not approved: needs a qualified engineer'}.`,
      data,
    );
  },
});
