/** check_mesh — pass / warn / fail verdict of one or more meshes for a purpose, with coded findings (07 MSH M0, FR-MSH-26, AF-20). Read-only. */

import type { MeshAnalysis } from '../../geometry/mesh/analysis';
import { resolveMeshEngine } from '../../geometry/mesh/engine';
import { minimumWallThickness } from '../../geometry/mesh/wallThickness';
import type { Vec3 } from '../../model/vectors';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import type { CommandResult } from '../types';
import {
  type NamedDefault,
  contextOf,
  engineOutcome,
  isCommandResult,
  isLoadFailure,
  loadSolidMesh,
  meshRejection,
  namedDefault,
  outwardMesh,
  withConventions,
} from './meshCommon';

type Purpose = 'print' | 'boolean' | 'fit' | 'export';
type Severity = 'fail' | 'warn';

interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly ids: string[];
  readonly where: Vec3 | null;
  readonly value: number;
  readonly limit: number;
  readonly unit: string;
  readonly message: string;
  readonly remediation: string;
}

/** Severity of a defect per purpose; a missing entry means the defect does not matter for that purpose. */
const SEVERITY: Readonly<Record<string, Readonly<Partial<Record<Purpose, Severity>>>>> = {
  MESH_CHECK_NOT_CLOSED: { print: 'fail', boolean: 'fail', fit: 'fail', export: 'warn' },
  MESH_CHECK_NON_MANIFOLD: { print: 'fail', boolean: 'fail', fit: 'warn', export: 'warn' },
  MESH_CHECK_INCONSISTENT_ORIENTATION: { print: 'fail', boolean: 'fail', fit: 'warn', export: 'warn' },
  MESH_CHECK_INVERTED: { print: 'fail', boolean: 'fail', fit: 'fail', export: 'warn' },
  MESH_CHECK_SELF_OVERLAP: { print: 'fail', boolean: 'fail', fit: 'warn', export: 'warn' },
  MESH_CHECK_DEGENERATE: { print: 'fail', boolean: 'fail', fit: 'warn', export: 'warn' },
  MESH_CHECK_SMALL_SHELLS: { print: 'warn', boolean: 'warn' },
  MESH_CHECK_WALL_THIN: { print: 'fail' },
  MESH_CHECK_TRIANGLES_ABOVE_LIMIT: { print: 'fail', boolean: 'fail', fit: 'fail', export: 'fail' },
};

const DEFAULT_SMALL_SHELL_FACES = 10;

function findingsOf(
  id: string,
  purpose: Purpose,
  analysis: MeshAnalysis,
  extra: {
    wall: { min: number; at: Vec3 | null } | null;
    minWall: number | undefined;
    maxTriangles: number | undefined;
    smallShellFaces: number;
    unit: string;
  },
): Finding[] {
  const found: Array<Omit<Finding, 'severity' | 'ids'>> = [];
  const loopCentroid = analysis.boundaryLoops[0]?.centroid ?? null;
  const none = { where: null, value: 0, limit: 0, unit: '' };
  if (analysis.boundaryEdges > 0) {
    found.push({
      code: 'MESH_CHECK_NOT_CLOSED',
      where: loopCentroid,
      value: analysis.boundaryEdges,
      limit: 0,
      unit: 'edges',
      message: `${analysis.boundaryEdges} open edge(s) in ${analysis.boundaryLoopCount} loop(s)`,
      remediation: 'fill_mesh_holes or repair_mesh mode=close_holes (later milestone), or repair_mesh mode=wrap now',
    });
  }
  if (analysis.nonManifoldEdgeCount > 0) {
    found.push({
      ...none,
      code: 'MESH_CHECK_NON_MANIFOLD',
      value: analysis.nonManifoldEdgeCount,
      unit: 'edges',
      message: `${analysis.nonManifoldEdgeCount} edge(s) shared by more than two faces`,
      remediation: 'repair_mesh mode=wrap rebuilds a manifold envelope',
    });
  }
  if (analysis.manifold && analysis.boundaryEdges === 0 && !analysis.orientationConsistent) {
    found.push({
      ...none,
      code: 'MESH_CHECK_INCONSISTENT_ORIENTATION',
      unit: 'edges',
      message: 'neighbouring faces disagree on orientation',
      remediation: 'repair_mesh mode=orient (later milestone) or mode=wrap',
    });
  }
  const inverted = analysis.shells.filter((shell) => shell.volume !== null && shell.volume < 0).length;
  if (inverted > 0 && analysis.orientationConsistent) {
    found.push({
      ...none,
      code: 'MESH_CHECK_INVERTED',
      value: inverted,
      unit: 'shells',
      message: `${inverted} closed shell(s) are wound inside-out (negative volume)`,
      remediation: 'repair_mesh mode=orient (later milestone) or mode=wrap',
    });
  }
  if ((analysis.selfIntersectionPairs ?? 0) > 0) {
    found.push({
      ...none,
      code: 'MESH_CHECK_SELF_OVERLAP',
      value: analysis.selfIntersectionPairs ?? 0,
      unit: 'pairs',
      message: `${analysis.selfIntersectionPairs} triangle pair(s) cross each other`,
      remediation: 'repair_mesh mode=wrap rebuilds a clean envelope',
    });
  }
  if (analysis.degenerateFaces + analysis.duplicateFaces > 0) {
    found.push({
      ...none,
      code: 'MESH_CHECK_DEGENERATE',
      value: analysis.degenerateFaces + analysis.duplicateFaces,
      unit: 'faces',
      message: `${analysis.degenerateFaces} degenerate and ${analysis.duplicateFaces} duplicate face(s)`,
      remediation: 'repair_mesh mode=clean (later milestone) or mode=wrap',
    });
  }
  const small = analysis.shellCount > 1 ? analysis.shells.filter((shell) => shell.faces <= extra.smallShellFaces).length : 0;
  if (small > 0) {
    found.push({
      ...none,
      code: 'MESH_CHECK_SMALL_SHELLS',
      value: small,
      limit: extra.smallShellFaces,
      unit: 'shells',
      message: `${small} shell(s) of at most ${extra.smallShellFaces} faces`,
      remediation: 'delete the stray pieces, or repair_mesh mode=wrap',
    });
  }
  if (extra.wall !== null && extra.minWall !== undefined && extra.wall.min < extra.minWall) {
    found.push({
      code: 'MESH_CHECK_WALL_THIN',
      where: extra.wall.at,
      value: extra.wall.min,
      limit: extra.minWall,
      unit: extra.unit,
      message: `thinnest wall ${extra.wall.min.toPrecision(6)} ${extra.unit} < ${extra.minWall} ${extra.unit}`,
      remediation: 'thicken the part, or offset_mesh with a positive distance',
    });
  }
  if (extra.maxTriangles !== undefined && analysis.faces > extra.maxTriangles) {
    found.push({
      ...none,
      code: 'MESH_CHECK_TRIANGLES_ABOVE_LIMIT',
      value: analysis.faces,
      limit: extra.maxTriangles,
      unit: 'triangles',
      message: `${analysis.faces} triangles > ${extra.maxTriangles}`,
      remediation: 'decimate_mesh (later milestone) a copy',
    });
  }
  return found.flatMap((finding) => {
    const severity = SEVERITY[finding.code]?.[purpose];
    return severity === undefined ? [] : [{ ...finding, severity, ids: [id] }];
  });
}

/**
 * @affects none (read-only); data = status, findings with codes / ids / location / value / limit, named tolerances, unverified flag
 * @invariant status is "fail" when any defect finding fails, "warn" when only warnings remain, else "pass"; the two notes about the check
 *   itself (MESH_CHECK_TOLERANCE_DEFAULTED, MESH_CHECK_INPUT_UNVERIFIED) are listed but never change the status
 * @failure unknown id / non-solid -> MESH_ENTITY_NOT_FOUND / MESH_NOT_A_MESH; over the engine cap -> MESH_ENGINE_CAP_EXCEEDED
 */
export const checkMesh = defineCommand({
  name: 'check_mesh',
  annotations: { readOnly: true },
  description:
    'Pass / warn / fail verdict for one or more meshes (or 3D solids) for a purpose: "print" (closed, manifold, consistently oriented, no ' +
    'crossing triangles, no degenerate faces, optional minimum wall thickness), "boolean" (same minus wall), "fit" (closed, right-side-out) or ' +
    '"export" (warnings only). Each finding has a stable code (MESH_CHECK_NOT_CLOSED, MESH_CHECK_NON_MANIFOLD, MESH_CHECK_INCONSISTENT_ORIENTATION, ' +
    'MESH_CHECK_INVERTED, MESH_CHECK_SELF_OVERLAP, MESH_CHECK_DEGENERATE, MESH_CHECK_SMALL_SHELLS, MESH_CHECK_WALL_THIN, ' +
    'MESH_CHECK_TRIANGLES_ABOVE_LIMIT), the entity ids, a location, the measured value and the limit with its unit, and the command that fixes ' +
    'it. data.unverified is true when an input is an unpinned import (MESH_CHECK_INPUT_UNVERIFIED); data.tolerances lists every limit used ' +
    'with its source. Lengths in document units. Read-only: end every mesh job with it.',
  params: z.object({
    ids: z.array(z.string()).min(1).max(100).describe('Ids of the meshes (or other 3D solids) to check.'),
    purpose: z
      .enum(['print', 'boolean', 'fit', 'export'])
      .describe('What the mesh is for; it sets which defects fail, warn or are ignored.'),
    minWallThickness: z
      .number()
      .positive()
      .optional()
      .describe(
        'purpose "print": smallest acceptable wall in document units; the check probes inward from the surface. Omit to skip the wall check.',
      ),
    maxTriangles: z.number().int().positive().optional().describe('Fail a mesh with more triangles than this.'),
    smallShellFaces: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('A shell of at most this many faces counts as a stray piece (when the mesh has several shells). Default 10.'),
    weldTolerance: z
      .number()
      .positive()
      .optional()
      .describe('Vertices closer than this (document units) are merged before checking. Default: 1e-6 x bounding-box diagonal.'),
  }),
  run: (doc, { ids, purpose, minWallThickness, maxTriangles, smallShellFaces, weldTolerance }, ctx): CommandResult => {
    const engine = resolveMeshEngine(contextOf(ctx).meshProcessing);
    const findings: Finding[] = [];
    const meshes: Array<Record<string, unknown>> = [];
    const defaults = new Map<string, NamedDefault>();
    const unverifiedIds: string[] = [];
    let provenance;
    for (const id of ids) {
      const loaded = loadSolidMesh(doc, id, weldTolerance, contextOf(ctx).meshAssets);
      if (isLoadFailure(loaded)) return meshRejection(doc, 'check_mesh', loaded.code, loaded.message, loaded.ids);
      const outcome = engineOutcome(
        doc,
        'check_mesh',
        engine.run({ mesh: loaded.mesh }, { op: 'analyze', weldTolerance: 0, selfIntersections: true, maxListed: 5 }),
        [id],
      );
      if (isCommandResult(outcome)) return outcome;
      const analysis = outcome.analysis as MeshAnalysis;
      provenance = outcome.provenance;
      const wall =
        purpose === 'print' && minWallThickness !== undefined && analysis.closed ? minimumWallThickness(outwardMesh(loaded.mesh)) : null;
      const own = findingsOf(id, purpose, analysis, {
        wall,
        minWall: minWallThickness,
        maxTriangles,
        smallShellFaces: smallShellFaces ?? DEFAULT_SMALL_SHELL_FACES,
        unit: doc.units,
      });
      findings.push(...own);
      if (loaded.weldDefaulted)
        defaults.set('weldTolerance', namedDefault('weldTolerance', loaded.weldTolerance, doc.units, 'llull default 1e-6 x bbox diagonal'));
      if (loaded.unverified) unverifiedIds.push(id);
      meshes.push({
        id,
        triangles: analysis.faces,
        status: own.some((f) => f.severity === 'fail') ? 'fail' : own.length > 0 ? 'warn' : 'pass',
      });
    }
    if (smallShellFaces === undefined)
      defaults.set('smallShellFaces', namedDefault('smallShellFaces', DEFAULT_SMALL_SHELL_FACES, 'faces', 'llull default'));
    const notes: Finding[] = [];
    if (defaults.has('weldTolerance')) {
      notes.push({
        code: 'MESH_CHECK_TOLERANCE_DEFAULTED',
        severity: 'warn',
        ids: [...ids],
        where: null,
        value: defaults.get('weldTolerance')?.value ?? 0,
        limit: 0,
        unit: doc.units,
        message: 'weldTolerance used its named default (1e-6 x bbox diagonal)',
        remediation: 'pass weldTolerance to state it',
      });
    }
    if (unverifiedIds.length > 0) {
      notes.push({
        code: 'MESH_CHECK_INPUT_UNVERIFIED',
        severity: 'warn',
        ids: unverifiedIds,
        where: null,
        value: unverifiedIds.length,
        limit: 0,
        unit: 'meshes',
        message: 'an input mesh has no pinned source sha256',
        remediation: 'import with sourceSha256 set to the file hash',
      });
    }
    const status = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.length > 0 ? 'warn' : 'pass';
    const all = [...findings, ...notes];
    const tolerances: Array<Record<string, unknown>> = [...defaults.values()].map((entry) => ({ ...entry }));
    if (minWallThickness !== undefined)
      tolerances.push({ name: 'minWallThickness', value: minWallThickness, unit: doc.units, source: 'caller', defaulted: false });
    const data = withConventions(
      doc,
      { purpose, status, findings: all, meshes, tolerances, ids },
      { unverified: unverifiedIds.length > 0, ...(provenance !== undefined ? { provenance } : {}), defaults: [...defaults.values()] },
    );
    const codes = [...new Set(findings.map((f) => f.code))];
    return report(
      doc,
      `check_mesh purpose=${purpose}: ${status.toUpperCase()} for ${ids.length} mesh(es)${codes.length > 0 ? ` — ${codes.join(', ')}` : ''}${unverifiedIds.length > 0 ? '; input unverified (no pinned sha256)' : ''}.`,
      data,
    );
  },
});
