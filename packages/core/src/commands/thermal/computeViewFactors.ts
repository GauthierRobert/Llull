/** compute_view_factors: diffuse view-factor matrix between planar polygon surfaces by contour integration (PHY-03 TR-THM-20, V1-a/b). */

import { planarFacets } from '../../lib/planarFacets';
import { convertValue, isUnitFailure } from '../../lib/quantity';
import { segmentHitsTriangle } from '../../lib/segmentTriangle';
import { exchangeArea, facing, type Facet } from '../../lib/viewFactorContour';
import type { Vec3 } from '../../model/vectors';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { commandError, rejection, report } from '../noop';
import { toSi } from './units';

const RECIPROCITY_WARNING = 1e-3;
const ROW_SUM_TOLERANCE = 1e-3;
const MAX_FACETS = 400;
const PLANARITY_RELATIVE = 1e-6;

interface Finding {
  readonly code: string;
  readonly severity: 'warning';
  readonly message: string;
  readonly remediation: string;
}

const polygon = z.object({
  name: z.string().min(1).describe('Unique surface name, echoed in the result.'),
  vertices: z
    .array(vec3('Vertex [x, y, z] in lengthUnit.'))
    .min(3)
    .max(256)
    .describe(
      'Closed planar polygon, vertices in order, not repeating the first. The right-hand rule gives the EMITTING side: counter-clockwise seen from the side that radiates.',
    ),
  flip: z.boolean().optional().describe('Reverse the vertex order, i.e. emit from the other side. Default false.'),
});

const refuse = (doc: CadDocument, code: string, why: string, remediation: string, paths: readonly string[]): CommandResult =>
  rejection(doc, `compute_view_factors: ${code} — ${why}; no-op.`, commandError(code, remediation, [], paths));

const REMEDIATION_SURFACE = 'Give each surface a unique name and 3 or more coplanar vertices with non-zero area.';

const scaled = (vertices: readonly Vec3[], factor: number): Vec3[] =>
  vertices.map((v): Vec3 => [v[0] * factor, v[1] * factor, v[2] * factor]);

/**
 * @affects nothing — read-only; data { surfaces[], matrix[][], rowSums[], method, facetCounts[], reciprocityMaxError, findings[], closedCavity?, obstruction }
 * @invariant F[I][J] = sum_i sum_j A_i F_ij / A_I over facets that face each other (centroid test); the diagonal of planar surfaces is 0; no document change
 * @failure bad length unit / maxFacetSize -> THM_UNITS_MISMATCH; < 2 surfaces, duplicate names, non-planar or degenerate polygons -> THM_SURFACE_INVALID;
 *   more than 400 facets (surfaces + blockers) -> THM_FACET_LIMIT (rejections, document unchanged); reciprocity error > 1e-3 -> warning THM_VIEW_FACTOR_RECIPROCITY
 */
export const computeViewFactors = defineCommand({
  name: 'compute_view_factors',
  annotations: { readOnly: true },
  description:
    'Diffuse (Lambertian) view factors between planar polygon surfaces for radiation enclosures. Each surface is triangulated, refined until ' +
    'every facet edge is <= maxFacetSize, and the factors are the contour integral F_ij = 1/(2 pi A_i) ∮∮ ln r dl_i·dl_j (8-point Gauss-Legendre, ' +
    'exact along touching / collinear edges); facets that do not face each other contribute 0. Vertex order sets the emitting side ' +
    '(counter-clockwise seen from it; flip reverses). Returns data { surfaces[{name, areaM2, facets, normal}], matrix[I][J] = F from surface I to ' +
    'J, rowSums, reciprocityMaxError (max |A_I F_IJ − A_J F_JI| / max), facetCounts, method, findings[] }. With obstruction=true a facet pair is ' +
    'skipped when the segment between centroids crosses another facet (of any surface or blockers). closed=true checks that every row sums to ' +
    '1 ± 1e-3. Warns THM_VIEW_FACTOR_RECIPROCITY above 1e-3 (refine maxFacetSize). Read-only; surfaces are given explicitly (entity faces are not read). ' +
    'Next: use the matrix for a radiation network, or compare with thermal_analytic_check view_factor.',
  params: z.object({
    lengthUnit: z.string().describe("Length unit of every vertex and of maxFacetSize, e.g. 'm' or 'mm'."),
    surfaces: z.array(polygon).min(2).max(64).describe('The radiating surfaces (at least 2), each a planar polygon.'),
    maxFacetSize: z
      .object({
        value: z.number().describe('Largest facet edge length.'),
        unit: z.string().describe('Length unit of the edge, e.g. "mm".'),
      })
      .optional()
      .describe(
        'Refinement target { value, unit }: triangles are split in four until their longest edge is <= this. Omit for no refinement (exact for fully visible planar pairs).',
      ),
    obstruction: z
      .boolean()
      .optional()
      .describe('Account for shadowing by other facets and blockers (ray test between facet centroids). Default false.'),
    blockers: z
      .array(
        z.object({
          vertices: z
            .array(vec3('Vertex [x, y, z] in lengthUnit.'))
            .min(3)
            .max(256)
            .describe('Planar polygon that blocks rays but does not radiate.'),
        }),
      )
      .max(16)
      .optional()
      .describe('Extra opaque polygons (at most 16) used only when obstruction is true.'),
    closed: z
      .boolean()
      .optional()
      .describe('The surfaces form a closed enclosure: report whether every row sum is 1 within 1e-3. Default false.'),
  }),
  run: (doc, params): CommandResult => {
    const factor = convertValue(1, params.lengthUnit, 'm');
    if (isUnitFailure(factor)) {
      return refuse(
        doc,
        'THM_UNITS_MISMATCH',
        `lengthUnit '${params.lengthUnit}': ${factor.message}`,
        "Use a length unit such as 'm' or 'mm'.",
        ['lengthUnit'],
      );
    }
    let maxSize: number | undefined;
    if (params.maxFacetSize !== undefined) {
      const size = toSi('length', params.maxFacetSize);
      if (!size.ok)
        return refuse(
          doc,
          'THM_UNITS_MISMATCH',
          `maxFacetSize: ${size.reason}`,
          'Give maxFacetSize as { value, unit } with a length unit.',
          ['maxFacetSize'],
        );
      if (!(size.value > 0))
        return refuse(doc, 'THM_SURFACE_INVALID', 'maxFacetSize must be > 0', 'Give a positive maxFacetSize.', ['maxFacetSize']);
      maxSize = size.value;
    }
    const names = params.surfaces.map((s) => s.name);
    if (new Set(names).size !== names.length) {
      return refuse(doc, 'THM_SURFACE_INVALID', 'surface names must be unique', REMEDIATION_SURFACE, ['surfaces']);
    }
    const prepared = [];
    for (const [index, surface] of params.surfaces.entries()) {
      const built = planarFacets(scaled(surface.vertices, factor.value), surface.flip === true, maxSize, MAX_FACETS);
      if (built === undefined) {
        return refuse(
          doc,
          'THM_SURFACE_INVALID',
          `surfaces[${index}] '${surface.name}' is degenerate or cannot be triangulated`,
          REMEDIATION_SURFACE,
          [`surfaces[${index}]`],
        );
      }
      if (built.planarityError > PLANARITY_RELATIVE * Math.sqrt(built.area)) {
        return refuse(
          doc,
          'THM_SURFACE_INVALID',
          `surfaces[${index}] '${surface.name}' is not planar (off-plane ${built.planarityError.toPrecision(3)} m)`,
          REMEDIATION_SURFACE,
          [`surfaces[${index}]`],
        );
      }
      if (built.overBudget) {
        return refuse(
          doc,
          'THM_FACET_LIMIT',
          `surfaces[${index}] '${surface.name}' would exceed ${MAX_FACETS} facets`,
          'Increase maxFacetSize or simplify the surfaces.',
          ['maxFacetSize'],
        );
      }
      prepared.push(built);
    }
    const facetCounts = prepared.map((p) => p.facets.length);
    const total = facetCounts.reduce((a, b) => a + b, 0);
    if (total > MAX_FACETS) {
      return refuse(
        doc,
        'THM_FACET_LIMIT',
        `${total} facets exceed the limit of ${MAX_FACETS}`,
        'Increase maxFacetSize or simplify the surfaces.',
        ['maxFacetSize'],
      );
    }

    const owners: { facet: Facet; surface: number }[] = prepared.flatMap((p, surface) => p.facets.map((facet) => ({ facet, surface })));
    const blockerFacets: Facet[] = [];
    if (params.obstruction === true) {
      for (const [index, blocker] of (params.blockers ?? []).entries()) {
        const built = planarFacets(scaled(blocker.vertices, factor.value), false, undefined, MAX_FACETS);
        if (built === undefined) {
          return refuse(doc, 'THM_SURFACE_INVALID', `blockers[${index}] is degenerate`, REMEDIATION_SURFACE, [`blockers[${index}]`]);
        }
        blockerFacets.push(...built.facets);
      }
    }
    if (total + blockerFacets.length > MAX_FACETS) {
      return refuse(
        doc,
        'THM_FACET_LIMIT',
        `${total + blockerFacets.length} facets (surfaces + blockers) exceed the limit of ${MAX_FACETS}`,
        'Increase maxFacetSize, drop blockers or simplify the surfaces.',
        ['maxFacetSize'],
      );
    }
    const occluders: readonly Facet[] = params.obstruction === true ? [...owners.map((o) => o.facet), ...blockerFacets] : [];
    const blocked = (from: Facet, to: Facet): boolean =>
      occluders.some((other) => other !== from && other !== to && segmentHitsTriangle(from.centroid, to.centroid, other.corners));

    const count = prepared.length;
    const exchange = Array.from({ length: count }, () => new Array<number>(count).fill(0));
    for (const a of owners) {
      for (const b of owners) {
        if (a.surface === b.surface || !facing(a.facet, b.facet)) continue;
        if (blocked(a.facet, b.facet)) continue;
        const row = exchange[a.surface];
        if (row !== undefined) row[b.surface] = (row[b.surface] ?? 0) + exchangeArea(a.facet, b.facet);
      }
    }
    const areas = prepared.map((p) => p.area);
    const matrix = exchange.map((row, i) => row.map((value) => value / (areas[i] ?? 1)));
    const rowSums = matrix.map((row) => row.reduce((a, b) => a + b, 0));

    let reciprocityMaxError = 0;
    const findings: Finding[] = [];
    const offenders: string[] = [];
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const forward = exchange[i]?.[j] ?? 0;
        const backward = exchange[j]?.[i] ?? 0;
        const scale = Math.max(Math.abs(forward), Math.abs(backward));
        if (scale === 0) continue;
        const error = Math.abs(forward - backward) / scale;
        reciprocityMaxError = Math.max(reciprocityMaxError, error);
        if (error > RECIPROCITY_WARNING) offenders.push(`${names[i]}/${names[j]}`);
      }
    }
    if (reciprocityMaxError > RECIPROCITY_WARNING) {
      findings.push({
        code: 'THM_VIEW_FACTOR_RECIPROCITY',
        severity: 'warning',
        message: `reciprocity error ${reciprocityMaxError.toPrecision(3)} > ${RECIPROCITY_WARNING} for ${offenders.join(', ')}`,
        remediation: 'refine maxFacetSize',
      });
    }
    let closedCavity: { readonly ok: boolean; readonly maxDeviation: number } | undefined;
    if (params.closed === true) {
      const maxDeviation = Math.max(...rowSums.map((sum) => Math.abs(sum - 1)));
      closedCavity = { ok: maxDeviation <= ROW_SUM_TOLERANCE, maxDeviation };
      if (!closedCavity.ok) {
        findings.push({
          code: 'THM_VIEW_FACTOR_ROWSUM',
          severity: 'warning',
          message: `closed enclosure but a row sum deviates from 1 by ${maxDeviation.toPrecision(3)}`,
          remediation: 'close the gaps between the surfaces, check vertex order (emitting side) or refine maxFacetSize',
        });
      }
    }
    const data = {
      surfaces: prepared.map((p, i) => ({ name: names[i], areaM2: p.area, facets: p.facets.length, normal: p.normal })),
      matrix,
      rowSums,
      method: 'contour-integral, 8-point Gauss-Legendre, adaptive along edges, closed-form antiderivative of ln r',
      facetCounts,
      reciprocityMaxError,
      obstruction: params.obstruction === true,
      findings,
      ...(closedCavity !== undefined ? { closedCavity } : {}),
    };
    const warned = findings.length > 0 ? ` WARNING ${findings.map((f) => f.code).join(', ')}.` : '';
    return report(
      doc,
      `compute_view_factors: ${count} surfaces, ${total} facets; row sums ${rowSums.map((s) => s.toPrecision(5)).join(', ')}; reciprocity error ${reciprocityMaxError.toExponential(2)}.${warned}`,
      data,
    );
  },
});
