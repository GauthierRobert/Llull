/**
 * The vortex-lattice model shared by `analyze_vortex_lattice` (TS solve up to VLM_TS_PANEL_CAP panels) and the host transport
 * `vortex_lattice_solve` (influence build + dense LU in `llull-compute panel` above it): params, lattice resolution and the result data.
 */

import { z } from '@core/commands/schema';
import type { CadDocument } from '@core/model/types';
import { sig } from '../shared/results';
import { parseNaca } from './naca';
import { thinAirfoil } from './panelMethod';
import { panelCount } from './vlmKernel';
import { buildLattice, loftSections, type Lattice, type LatticeSection, type LatticeSurface } from './vlmLattice';
import { alphaLoads, stability, stripLoading, trefftzBasis, type LatticeBasis, type LatticeReference, type TrefftzBasis } from './vlmLoads';

/** Largest lattice the TypeScript path solves (dense LU, measured ≈ 1.2 s at this size on the reference laptop; above: the native transport). */
export const VLM_TS_PANEL_CAP = 1000;
/** Largest lattice the native transport accepts (dense n × n f64 matrix: 20 000² × 8 B = 3.2 GB). */
export const VLM_NATIVE_PANEL_CAP = 20_000;
const RAD = Math.PI / 180;

const point3 = z.tuple([z.number(), z.number(), z.number()]);

export const vortexLatticeParams = z.object({
  surfaces: z
    .array(
      z.object({
        name: z.string().describe('Surface name, e.g. "wing", "htail".'),
        loftId: z
          .string()
          .optional()
          .describe(
            'Id of a loft_sections solid: each ring is a section (leading edge = least x, trailing edge = largest x, world frame).',
          ),
        sections: z
          .array(
            z.object({
              leadingEdge: point3.describe('Leading-edge point [x, y, z] (x downstream, y spanwise, z up), same length unit everywhere.'),
              chord: z.number().describe('Chord length, >= 0 (0 only at a pointed tip, e.g. an elliptic planform).'),
              incidenceDeg: z.number().optional().describe('Section incidence (twist), degrees, nose up positive. Default 0.'),
            }),
          )
          .optional()
          .describe('Explicit sections root to tip (alternative to loftId), at least 2.'),
        mirror: z
          .boolean()
          .optional()
          .describe(
            'Add the mirror image about y = 0 (a half wing given root to tip). Default true, except false for a surface on y = 0 (fin) or one already spanning both sides (full-span loft).',
          ),
        spanwisePanels: z.number().int().optional().describe('Spanwise panels per side, 1..200. Default 12.'),
        chordwisePanels: z.number().int().optional().describe('Chordwise panels, 1..50. Default 4.'),
        spacing: z.enum(['cosine', 'uniform']).optional().describe('Spanwise spacing: cosine (default, clustered at the tips) or uniform.'),
        naca: z
          .string()
          .optional()
          .describe('Section NACA designation: its thin-airfoil zero-lift angle is applied as a camber incidence.'),
        zeroLiftAngleDeg: z.number().optional().describe('Section zero-lift angle, degrees (overrides naca). Default 0 (flat plate).'),
      }),
    )
    .describe('Lifting surfaces (1..8): wing, tails, canards; each from loftId or sections. The first is the main wing (reference).'),
  alphasDeg: z.array(z.number()).optional().describe('Angles of attack in degrees within -20..20, at most 31. Default [0, 5].'),
  referenceArea: z.number().optional().describe('Reference area S. Default: planform area of the first surface (both sides).'),
  referenceChord: z.number().optional().describe('Reference chord for Cm. Default: mean aerodynamic chord of the first surface.'),
  referencePoint: point3
    .optional()
    .describe('Moment reference point = centre of gravity [x, y, z] (static margin measured from it). Default [0, 0, 0].'),
});

export type VortexLatticeParams = z.infer<typeof vortexLatticeParams>;

export interface VortexLatticeModel {
  readonly params: VortexLatticeParams;
  readonly lattice: Lattice;
  readonly reference: LatticeReference;
  readonly alphas: readonly number[];
  readonly names: readonly string[];
  readonly zeroLift: readonly { readonly valueDeg: number; readonly source: string }[];
}

export interface VlmRefusal {
  readonly code: string;
  readonly message: string;
  readonly paths: readonly string[];
}

const refusal = (code: string, message: string, paths: readonly string[]): VlmRefusal => ({ code, message, paths });
export const isVlmRefusal = (value: VortexLatticeModel | VlmRefusal): value is VlmRefusal => 'code' in value;

type SurfaceParams = VortexLatticeParams['surfaces'][number];

interface ResolvedSurface {
  readonly surface: LatticeSurface;
  readonly zeroLiftRad: number;
}

/** Leading edges all on y = 0 (a fin) or on both sides of it (a full-span definition): mirroring would overlap the surface. */
function onOrAcrossSymmetryPlane(sections: readonly LatticeSection[], spanLength: number): boolean {
  const tolerance = 1e-9 * spanLength;
  const ys = sections.map((s) => s.leadingEdge[1]);
  return ys.every((y) => Math.abs(y) <= tolerance) || (Math.min(...ys) < -tolerance && Math.max(...ys) > tolerance);
}

function surfaceOf(doc: CadDocument, surface: SurfaceParams, path: string): ResolvedSurface | VlmRefusal {
  const spanwise = surface.spanwisePanels ?? 12;
  const chordwise = surface.chordwisePanels ?? 4;
  if (!(spanwise >= 1 && spanwise <= 200)) return refusal('AER_PARAM_INVALID', 'spanwisePanels must be 1..200', [`${path}.spanwisePanels`]);
  if (!(chordwise >= 1 && chordwise <= 50))
    return refusal('AER_PARAM_INVALID', 'chordwisePanels must be 1..50', [`${path}.chordwisePanels`]);
  if ((surface.loftId === undefined) === (surface.sections === undefined))
    return refusal('AER_SURFACE_SOURCE_CONFLICT', 'give exactly one of loftId or sections', [path]);
  let zeroLift = (surface.zeroLiftAngleDeg ?? 0) * RAD;
  if (surface.naca !== undefined && surface.zeroLiftAngleDeg === undefined) {
    const section = parseNaca(surface.naca);
    if (typeof section === 'string') return refusal('AER_AIRFOIL_INVALID', section, [`${path}.naca`]);
    zeroLift = thinAirfoil((x) => section.camber(x).slope).zeroLiftAngle;
  }
  let sections: LatticeSection[];
  if (surface.loftId !== undefined) {
    const read = loftSections(doc, surface.loftId);
    if (typeof read === 'string')
      return refusal(doc.entities[surface.loftId] === undefined ? 'AER_ENTITY_NOT_FOUND' : 'AER_SURFACE_INVALID', read, [`${path}.loftId`]);
    sections = read.map((s) => ({ ...s, incidence: s.incidence - zeroLift }));
  } else {
    sections = (surface.sections ?? []).map((s) => ({
      leadingEdge: s.leadingEdge,
      chord: s.chord,
      incidence: (s.incidenceDeg ?? 0) * RAD - zeroLift,
    }));
    if (sections.length < 2) return refusal('AER_SURFACE_INVALID', 'a surface needs at least 2 sections', [`${path}.sections`]);
    const bad = sections.findIndex((s) => !(s.chord >= 0) || ![...s.leadingEdge, s.incidence].every(Number.isFinite));
    if (bad >= 0) return refusal('AER_SURFACE_INVALID', 'chords must be >= 0 and values finite', [`${path}.sections.${bad}`]);
  }
  const spanLength = sections.slice(1).reduce((sum, s, k) => {
    const a = (sections[k] as LatticeSection).leadingEdge;
    return sum + Math.hypot(s.leadingEdge[1] - a[1], s.leadingEdge[2] - a[2]);
  }, 0);
  if (!(spanLength > 0)) return refusal('AER_SURFACE_INVALID', 'the sections have no spanwise extent (y / z)', [path]);
  const unmirrorable = onOrAcrossSymmetryPlane(sections, spanLength);
  if (unmirrorable && surface.mirror === true)
    return refusal('AER_SURFACE_INVALID', 'a surface on y = 0 (fin) or spanning both sides of it cannot be mirrored: mirror false', [
      `${path}.mirror`,
    ]);
  return {
    surface: {
      name: surface.name,
      sections,
      mirror: surface.mirror ?? !unmirrorable,
      spanwisePanels: spanwise,
      chordwisePanels: chordwise,
      spacing: surface.spacing ?? 'cosine',
    },
    zeroLiftRad: zeroLift,
  };
}

/**
 * Validates the params into a lattice model; `panelCap` is VLM_TS_PANEL_CAP (command) or VLM_NATIVE_PANEL_CAP (transport).
 * @failure AER_PARAM_INVALID, AER_SURFACE_SOURCE_CONFLICT, AER_SURFACE_INVALID, AER_ENTITY_NOT_FOUND, AER_AIRFOIL_INVALID, AER_LATTICE_TOO_LARGE
 */
export function resolveVortexLattice(doc: CadDocument, params: VortexLatticeParams, panelCap: number): VortexLatticeModel | VlmRefusal {
  if (params.surfaces.length === 0 || params.surfaces.length > 8) return refusal('AER_PARAM_INVALID', 'give 1..8 surfaces', ['surfaces']);
  const alphasDeg = params.alphasDeg ?? [0, 5];
  if (alphasDeg.length === 0 || alphasDeg.length > 31 || alphasDeg.some((a) => !(Math.abs(a) <= 20)))
    return refusal('AER_PARAM_INVALID', 'alphasDeg needs 1..31 angles within -20..20 degrees', ['alphasDeg']);
  const surfaces: LatticeSurface[] = [];
  const zeroLifts: number[] = [];
  for (const [index, surface] of params.surfaces.entries()) {
    const built = surfaceOf(doc, surface, `surfaces.${index}`);
    if ('code' in built) return built;
    surfaces.push(built.surface);
    zeroLifts.push(built.zeroLiftRad);
  }
  const panels = surfaces.reduce((sum, s) => sum + s.spanwisePanels * s.chordwisePanels * (s.mirror ? 2 : 1), 0);
  if (panels > panelCap) return refusal('AER_LATTICE_TOO_LARGE', `${panels} panels exceed the cap of ${panelCap}`, ['surfaces']);
  for (const [key, value] of [
    ['referenceArea', params.referenceArea],
    ['referenceChord', params.referenceChord],
  ] as const)
    if (value !== undefined && !(value > 0)) return refusal('AER_PARAM_INVALID', `${key} must be > 0`, [key]);
  const lattice = buildLattice(surfaces);
  const area = params.referenceArea ?? (lattice.surfaceArea[0] as number);
  return {
    params,
    lattice,
    reference: {
      area,
      chord: params.referenceChord ?? (lattice.meanChord[0] as number),
      span: lattice.span[0] as number,
      point: params.referencePoint ?? [0, 0, 0],
    },
    alphas: alphasDeg.map((a) => a * RAD),
    names: surfaces.map((s) => s.name),
    zeroLift: params.surfaces.map((s, i) => ({
      valueDeg: (zeroLifts[i] as number) / RAD,
      source:
        s.zeroLiftAngleDeg !== undefined
          ? 'given'
          : s.naca !== undefined
            ? `thin-airfoil theory of NACA ${s.naca}`
            : 'default 0 (flat plate)',
    })),
  };
}

export interface SolveProvenance {
  readonly engine: 'ts' | 'native';
  readonly [key: string]: unknown;
}

/**
 * The `data` of analyze_vortex_lattice / vortex_lattice_solve from the basis circulations; `wake` = the Trefftz-plane velocities when the
 * native job computed them (O(n²), kept off the host thread for large lattices), else computed here.
 */
export function vortexLatticeData(
  model: VortexLatticeModel,
  basis: LatticeBasis,
  solver: SolveProvenance,
  wake?: TrefftzBasis,
): Record<string, unknown> {
  const { lattice, reference } = model;
  const trefftz = wake ?? trefftzBasis(lattice, basis);
  const aspectRatio = (reference.span * reference.span) / reference.area;
  const polar = model.alphas.map((alpha) => {
    const loads = alphaLoads(lattice, basis, trefftz, reference, alpha);
    return {
      alphaDeg: sig(alpha / RAD),
      cl: sig(loads.cl),
      cdi: sig(loads.cdi),
      cm: sig(loads.cm),
      spanEfficiency: loads.cdi > 0 ? sig((loads.cl * loads.cl) / (Math.PI * aspectRatio * loads.cdi)) : null,
      surfaces: model.names.map((name, s) => ({ name, cl: sig(loads.surfaceCl[s] as number) })),
    };
  });
  const slopes = stability(lattice, basis, trefftz, reference);
  const lastAlpha = model.alphas[model.alphas.length - 1] as number;
  const loading = stripLoading(lattice, basis, 0, lastAlpha);
  return {
    lattice: {
      panels: panelCount(lattice.panels),
      surfaces: model.names.map((name, s) => ({
        name,
        area: sig(lattice.surfaceArea[s] as number),
        meanChord: sig(lattice.meanChord[s] as number),
        span: sig(lattice.span[s] as number),
      })),
    },
    reference: {
      area: sig(reference.area),
      chord: sig(reference.chord),
      span: sig(reference.span),
      aspectRatio: sig(aspectRatio),
      point: reference.point,
      defaulted: {
        area: model.params.referenceArea === undefined,
        chord: model.params.referenceChord === undefined,
        point: model.params.referencePoint === undefined,
      },
    },
    polar,
    liftSlopePerRad: sig(slopes.liftSlopePerRad),
    liftSlopePerDeg: sig(slopes.liftSlopePerRad * RAD),
    momentSlopePerRad: sig(slopes.momentSlopePerRad),
    neutralPoint: { x: sig(slopes.neutralPointX), staticMargin: sig(slopes.staticMargin) },
    spanLoading: {
      surface: model.names[0],
      alphaDeg: sig(lastAlpha / RAD),
      strips: (lattice.strips[0] ?? []).map((strip, j) => ({
        y: sig(strip.centre[1]),
        chord: sig(strip.chord),
        cl: sig(loading[j] as number),
      })),
    },
    sections: model.zeroLift.map((z0, s) => ({ name: model.names[s], zeroLiftAngleDeg: sig(z0.valueDeg), source: z0.source })),
    solver,
    warnings: [
      'Inviscid, incompressible, attached flow: no stall, thickness or viscous drag (use drag_buildup for parasite drag); planar wake along +x.',
      ...(model.zeroLift.some((z0) => z0.source.startsWith('default'))
        ? ['A surface without naca / zeroLiftAngleDeg is a flat plate (zero camber).']
        : []),
    ],
    provenance: {
      method: 'horseshoe vortex lattice: bound vortex at 1/4 panel chord, control point at 3/4 (Katz & Plotkin §12.3; Bertin & Smith §7.4)',
      inducedDrag: 'Trefftz plane, D_i = ½ρ Σ Γ_i (v_i × s_i)·x̂',
      neutralPoint: 'x_np = x_ref − (Cm_α / CL_α) c_ref, slopes by central differences at α = 0 (±0.5°)',
    },
  };
}
