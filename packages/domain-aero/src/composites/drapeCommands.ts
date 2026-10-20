/** drape_ply, check_producibility: fishnet drape shear of plies on their tool face (06 CMP M3, FR-CMP-40..42). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { type PlyDrapeResult, autoStepLength, drapePly } from './drape/plyDrape';
import { assessPly, limitsOf } from './drape/producibility';
import { isUnverified } from '@lib/laminate/provenance';
import { compositesOf, findPart, findPly, pliesOf } from './state';

const overrides = {
  stepLength: z
    .number()
    .describe('Fishnet cell size, document length units; default the ply drape.stepLength, else the outline diagonal / 200; must be > 0.')
    .optional(),
  lockingAngle: z
    .number()
    .describe('Locking (maximum) shear, degrees in (0, 90]; default the material lockingAngle (no built-in default exists).')
    .optional(),
  warningShear: z.number().describe('Warning shear, degrees; default the material warningShear.').optional(),
};

const badNumbers = (values: Record<string, number | undefined>): string | null => {
  for (const [name, value] of Object.entries(values))
    if (value !== undefined && !(Number.isFinite(value) && value > 0)) return `${name} must be a number > 0`;
  return null;
};

const NODE_PAGE = 5000;

/**
 * @affects nothing (read-only)
 * @invariant pin-jointed net of inextensible tows seeded at the ply seed (default the pole / face centre) with geodesic generators along the fibre and across it; shear = |90 deg - crossing angle| of the cell ending at a node; deterministic; each cut piece is draped separately
 * @failure unknown part / ply -> CMP_REF_MISSING; no locking angle on the material nor in params -> CMP_DRAPE_LIMIT_MISSING; step estimate above 1.5 million nodes -> CMP_PARAM_INVALID
 */
export const drapePlyCommand = defineCommand({
  name: 'drape_ply',
  annotations: { readOnly: true },
  description:
    'Kinematic (fishnet, Mack & Taylor) drape of a ply on its tool face: a pin-jointed net of inextensible tows of step `stepLength` seeded at the ' +
    'ply seed (drape.seed, default the pole of a sphere cap / the centre of a NURBS sheet) with two geodesic generators, the warp along the fibre ' +
    'direction and the weft across it, filled outward. Works on every tool face kind (plane, cylinder, cone, sphere cap, nurbs_surface sheet). ' +
    'Each node reports its shear, the absolute deviation of the tow crossing angle from 90 degrees. Returns the maximum shear and where, the number of ' +
    'nodes over the warning and the locking angle (material lockingAngle / warningShear or the params), the area of the cells over the lock and the ' +
    'over-lock regions (largest first, with centroid). A ply cut by darts or splices (split_ply) is draped piece by piece. Chart distances of a ' +
    'sphere cap and a NURBS sheet are not metric away from the centre: lengths here are measured on the surface. `output` "nodes" adds the net ' +
    'nodes (page with `offset`). Purely kinematic: no fabric mechanics, friction or tool contact. Read-only; the result is computed by llull and not approved.',
  params: z.object({
    ply: z.string().describe('Ply id, or ply name (with `part`).'),
    part: z.string().describe('Part id or name; needed only when `ply` is a name.').optional(),
    ...overrides,
    output: z.enum(['summary', 'nodes']).describe('"summary" (default) or "nodes" (adds the net nodes).').optional(),
    offset: z
      .number()
      .describe('With output "nodes": first node index of the page (integer, default 0); pages hold 5000 nodes.')
      .optional(),
  }),
  run: (doc, { ply: plyRef, part: partRef, stepLength, lockingAngle, warningShear, output = 'summary', offset = 0 }): CommandResult => {
    const model = compositesOf(doc);
    const part = partRef === undefined ? null : findPart(model, partRef);
    if (partRef !== undefined && part === null)
      return refuseCmp(doc, 'drape_ply', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const ply = model.plies[plyRef] ?? (part === null ? null : findPly(model, part.id, plyRef));
    const owner = ply === null || ply === undefined ? undefined : model.parts[ply.partId];
    if (ply === null || ply === undefined || owner === undefined)
      return refuseCmp(doc, 'drape_ply', 'CMP_REF_MISSING', `no ply '${plyRef}'`, part === null ? [] : [part.id], ['params.ply']);
    const invalid = badNumbers({ stepLength, lockingAngle, warningShear });
    if (invalid !== null) return refuseCmp(doc, 'drape_ply', 'CMP_PARAM_INVALID', invalid, [ply.id]);
    const material = model.materials[ply.materialName];
    if (material === undefined)
      return refuseCmp(doc, 'drape_ply', 'CMP_REF_MISSING', `ply "${ply.name}" uses unknown material '${ply.materialName}'`, [ply.id]);
    const limits = limitsOf(material, { lockingAngle, warningShear });
    if (limits.lock === undefined)
      return refuseCmp(
        doc,
        'drape_ply',
        'CMP_DRAPE_LIMIT_MISSING',
        `material "${material.name}" has no lockingAngle and none was given`,
        [ply.id],
        ['params.lockingAngle'],
      );
    const drape: PlyDrapeResult = drapePly(owner, ply, { stepLength, limits, allowOverLock: true });
    if (!drape.ok) return refuseCmp(doc, 'drape_ply', drape.code, drape.message, [ply.id], ['params.stepLength']);
    const summaries = drape.pieces.map((piece) => piece.summary);
    const worst = summaries.reduce((a, b) => (b.maxShearDeg > a.maxShearDeg ? b : a));
    const total = (pick: (s: (typeof summaries)[number]) => number | null): number => summaries.reduce((sum, s) => sum + (pick(s) ?? 0), 0);
    const nodesOverLock = total((s) => s.nodesOverLock);
    const nodesOverWarning = limits.warning === undefined ? null : total((s) => s.nodesOverWarning);
    const areaOverLock = total((s) => s.areaOverLock);
    const nodes =
      output === 'nodes'
        ? drape.pieces
            .flatMap((piece) =>
              [...piece.net.nodes.values()].sort((a, b) => a.i - b.i || a.j - b.j).map((node) => ({ piece: piece.index, node })),
            )
            .map(({ piece, node }) => ({
              piece,
              i: node.i,
              j: node.j,
              point: node.hit.point.map(sig),
              flatChart: node.hit.uv.map(sig),
              shearDeg: sig(node.shear),
              overLock: node.shear > (limits.lock as number),
            }))
        : null;
    const start = Math.max(0, Math.floor(offset));
    return report(
      doc,
      `drape_ply: ply "${ply.name}" on part "${owner.name}" (${owner.surface.type} face), ${drape.pieces.length} piece(s), step ${sig(drape.stepLength)} ${doc.units}: max shear ${sig(worst.maxShearDeg)} deg, ${nodesOverLock} node(s) over the ${limits.lock} deg lock${nodesOverWarning === null ? '' : `, ${nodesOverWarning} over the ${limits.warning} deg warning`}, ${sig(areaOverLock)} ${doc.units}^2 over lock. Kinematic model, computed by llull and not approved.`,
      {
        part: owner.id,
        ply: ply.id,
        surface: owner.surface.type,
        pieceCount: drape.pieces.length,
        lengthUnit: doc.units,
        stepLength: {
          value: sig(drape.stepLength),
          unit: doc.units,
          source:
            stepLength !== undefined ? 'param' : ply.drape?.stepLength !== undefined ? 'ply.drape.stepLength' : 'outline diagonal / 200',
          defaulted: stepLength === undefined && ply.drape?.stepLength === undefined,
        },
        limits: { lockingAngleDeg: limits.lock, warningShearDeg: limits.warning ?? null },
        maxShearDeg: sig(worst.maxShearDeg),
        coverage: sig(Math.min(...drape.pieces.map((piece) => piece.coverage))),
        maxShearNode: worst.maxShearNode === null ? null : { ...worst.maxShearNode, point: worst.maxShearNode.point.map(sig) },
        nodesOverWarning,
        nodesOverLock,
        areaOverLock: sig(areaOverLock),
        overLockRegions: summaries
          .flatMap((s) => s.overLockRegions)
          .map((r) => ({ ...r, maxShearDeg: sig(r.maxShearDeg), centroid: r.centroid.map(sig) })),
        pieces: drape.pieces.map((piece) => ({
          index: piece.index,
          seed: piece.seedUv.map(sig),
          nodeCount: piece.net.nodes.size,
          measuredNodes: piece.summary.measuredNodes,
          maxShearDeg: sig(piece.summary.maxShearDeg),
          truncated: piece.net.stats.truncated,
          coverage: sig(piece.coverage),
          failedNodes: { outside: piece.net.stats.outside, inverted: piece.net.stats.inverted },
        })),
        ...(nodes === null ? {} : { nodes: nodes.slice(start, start + NODE_PAGE), nodeTotal: nodes.length, nodeOffset: start }),
        unverified: isUnverified(material),
        reviewRequired: true,
        reviewReason: 'kinematic drape computed by llull, not approved: validate against a forming trial before cutting material',
        provenance: {
          method: 'pin-jointed net (fishnet), geodesic generators, Newton node solve on the tool surface',
          reference: 'Mack & Taylor 1956; Hazzidakis / Chebyshev net identity',
          inputs: { part: owner.id, ply: ply.id },
        },
      },
    );
  },
});

/**
 * @affects nothing (read-only)
 * @invariant developable faces (plane, cylinder, cone) are exact with zero shear unless a ply asks for the kinematic drape; each doubly curved ply is draped with the material limits
 * @failure unknown part / ply -> CMP_REF_MISSING; no locking angle -> a failing CMP_DRAPE_LIMIT_MISSING finding for that ply
 */
export const checkProducibility = defineCommand({
  name: 'check_producibility',
  annotations: { readOnly: true },
  description:
    'Producibility check of the plies of a composite part: drapes every ply on a doubly curved tool face (sphere cap, nurbs_surface; developable ' +
    'faces are exact with zero shear) and compares the fishnet shear with the material lockingAngle and warningShear. Per ply it reports the maximum ' +
    'shear, nodes over the warning / lock angle, the area over the lock and findings: CMP_PRODUCIBILITY_OVER_LOCK (fail: flat patterns are refused ' +
    'unless allowOverLock), CMP_PRODUCIBILITY_NEAR_LOCK (warning), CMP_DRAPE_LIMIT_MISSING (fail: no locking angle exists for the material; ' +
    'no default is used), with suggested darts or splices at the over-lock regions. `stepLength`, `lockingAngle`, `warningShear` override as in ' +
    'drape_ply. Read-only; computed by llull, not approved.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    plies: z.array(z.string().describe('Ply id or name.')).describe('Plies to check; default all plies of the part.').optional(),
    ...overrides,
  }),
  run: (doc, { part: partRef, plies: selection, stepLength, lockingAngle, warningShear }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'check_producibility', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const invalid = badNumbers({ stepLength, lockingAngle, warningShear });
    if (invalid !== null) return refuseCmp(doc, 'check_producibility', 'CMP_PARAM_INVALID', invalid, [part.id]);
    const chosen = selection === undefined ? pliesOf(model, part.id) : selection.map((ref) => findPly(model, part.id, ref));
    const missing = (selection ?? []).filter((_, i) => chosen[i] === null);
    if (missing.length > 0)
      return refuseCmp(
        doc,
        'check_producibility',
        'CMP_REF_MISSING',
        `unknown ply(ies) ${missing.join(', ')}`,
        [part.id],
        ['params.plies'],
      );
    const plies = chosen.flatMap((ply) => (ply === null || ply.partId !== part.id ? [] : [ply]));
    if (plies.length === 0)
      return refuseCmp(doc, 'check_producibility', 'CMP_NO_PLIES', `part "${part.name}" has no plies to check`, [part.id], ['params.part']);
    const cache = new Map<string, PlyDrapeResult>();
    const results = plies.map((ply) => {
      const material = model.materials[ply.materialName];
      if (material === undefined) return { error: `ply "${ply.name}" uses unknown material '${ply.materialName}'` };
      return assessPly(part, ply, material, { lockingAngle, warningShear, stepLength }, (p, q, limits) => {
        const key = JSON.stringify([q.boundary, q.cuts, q.orientation, q.drape, stepLength, limits]);
        const cached = cache.get(key);
        if (cached !== undefined) return cached;
        const fresh = drapePly(p, q, { stepLength, limits, allowOverLock: true });
        cache.set(key, fresh);
        return fresh;
      });
    });
    const failed = results.find((r): r is { error: string } => 'error' in r);
    if (failed !== undefined) return refuseCmp(doc, 'check_producibility', 'CMP_PARAM_INVALID', failed.error, [part.id]);
    const assessed = results as Exclude<(typeof results)[number], { error: string }>[];
    const findings = assessed.flatMap((r) => r.findings);
    const status = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.length > 0 ? 'warn' : 'pass';
    return report(
      doc,
      `check_producibility: part "${part.name}": ${status}; ${plies.length} ply(ies) checked, ${findings.filter((f) => f.severity === 'fail').length} failing, ${findings.filter((f) => f.severity === 'warn').length} warning(s)${findings.length > 0 ? `: ${[...new Set(findings.map((f) => f.code))].join(', ')}` : ''}.`,
      {
        part: part.id,
        status,
        autoStepLength: sig(autoStepLength(part)),
        plies: assessed,
        unverified: plies.some((ply) => {
          const material = model.materials[ply.materialName];
          return material !== undefined && isUnverified(material);
        }),
        reviewRequired: true,
        reviewReason: 'kinematic drape computed by llull, not approved',
        provenance: { method: 'fishnet drape shear vs material locking angle', reference: 'Mack & Taylor 1956', inputs: { part: part.id } },
      },
    );
  },
});
