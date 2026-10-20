/**
 * Ply-failure margins of composite shells (05 FEA, 06 CMP): per ply, the first-ply strength ratio R (max stress and Tsai-Wu, the lower governs) of the
 * ply stresses recovered through the laminate from the stresses at the two outer fibres of the shell (STRESS_TOP / STRESS_BOT), and MS = R / (FoS x extras) - 1.
 * Core data only: the laminate comes from `CadDocument.composites` (never from the composites plugin) and the CLT / criteria are the pure leaf `@lib/laminate`.
 */

import type { AnalysisCase, FeMeshArtifact, HumanSignaturePort } from '@core/model/analysis';
import type { LaminaMaterial } from '@core/model/composites';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { toMetres } from '@core/model/units';
import type { StackPly, Triple } from '@lib/laminate/clt';
import { DEFAULT_F12_STAR, strengthRatio, strengthsOf, type Strengths } from '@lib/laminate/failure';
import { isUnverified } from '@lib/laminate/provenance';
import { recoverPlyStresses } from '@lib/laminate/recover';
import { cross3, dot3, normalize3 } from '@lib/vec3';
import { buildDeckContext } from '../decks/context';
import { lengthUnitName, stressPerMpa, stressUnitName } from '../decks/units';
import { analysisInputHash } from '../hash/inputHash';
import { nodeCoordinates } from '../results/fields';
import { compositePlane, projectedAxis } from '../shell/shellDeck';
import { isLaminateRefusal, laminateOf } from '../shell/laminate';
import { appliedFactor, type FactorReport, type MarginStatus, marginOfSafety, statusOf } from './marginMath';
import { dispositionOf } from './disposition';

type Fields = Readonly<Record<string, { readonly values: Readonly<Record<string, readonly number[]>> } | undefined>>;

interface PlyRow {
  readonly ms: number | null;
  readonly status: MarginStatus;
  readonly disposition: string;
  readonly [key: string]: unknown;
}

export interface PlyMarginInput {
  readonly doc: CadDocument;
  readonly analysis: AnalysisCase;
  readonly mesh: FeMeshArtifact;
  readonly fields: Fields;
  readonly entityId: string;
  /** Group region key ('part' or the C_ / L_ node-set key). */
  readonly region: string;
  readonly nodes: readonly number[];
  readonly singular: boolean;
  readonly loadCase: { readonly name: string; readonly category: 'limit' | 'ultimate' };
  readonly factors: FactorReport;
  readonly marginalBand: number | undefined;
  readonly port: HumanSignaturePort | null;
}

export type PlyOutcome = { readonly rows: PlyRow[] } | { readonly skipped: string };

/** Global stress components [xx, yy, zz, xy, yz, zx] in the shell frame (e1, e2): [s1, s2, t12]. */
function inPlane(stress: readonly number[], e1: Vec3, e2: Vec3): Triple {
  const [xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, zx = 0] = stress;
  const times = (v: Vec3): Vec3 => [
    xx * v[0] + xy * v[1] + zx * v[2],
    xy * v[0] + yy * v[1] + yz * v[2],
    zx * v[0] + yz * v[1] + zz * v[2],
  ];
  return [dot3(e1, times(e1)), dot3(e2, times(e2)), dot3(e1, times(e2))];
}

interface Worst {
  R: number;
  criterion: 'max_stress' | 'tsai_wu';
  mode: string | undefined;
  ratios: { max_stress: number; tsai_wu: number };
  position: 'bottom' | 'top';
  stress: Triple;
  node: number;
}

/**
 * The ply-failure rows of one group of nodes of a composite shell for one load case, or why there are none.
 * @invariant one row per ply (tool side first): the lowest strength ratio over the group's nodes and the ply's two surfaces, governing criterion named; only the ultimate check
 *   exists (strengths are failure strengths): R / (FoS x extras) - 1 with the case factors of an ultimate check; every row reviewRequired
 * @failure laminate refusal / non-planar shell / lamina without Xt, Xc, Yt, Yc, S / results without STRESS_TOP + STRESS_BOT -> skipped with the reason (FEA_COMPOSITE_MARGINS_UNSUPPORTED)
 */
export function plyMarginRows(input: PlyMarginInput): PlyOutcome {
  const { doc, analysis, mesh, fields, entityId, region, nodes, singular, loadCase, factors } = input;
  const idealization = analysis.parts[entityId];
  if (idealization?.kind !== 'shell' || idealization.laminate === undefined) return { skipped: `'${entityId}' is no composite shell` };
  const ctx = buildDeckContext(doc, analysis.id, mesh);
  if (ctx === null) return { skipped: 'the analysis is missing' };
  const laminate = laminateOf(doc, idealization.laminate.compositePartId, entityId, idealization.laminate.sectionId);
  if (isLaminateRefusal(laminate)) return { skipped: `${laminate.code}: ${laminate.message}` };
  const normal = compositePlane(ctx, entityId);
  if (typeof normal === 'string') return { skipped: normal };
  const lacking = Object.values(laminate.materials).flatMap((material) => {
    const strengths = strengthsOf(material);
    return 'missing' in strengths ? [`"${material.name}" lacks ${strengths.missing.join(', ')}`] : [];
  });
  if (lacking.length > 0) return { skipped: `the laminate has no ply allowables (Xt, Xc, Yt, Yc, S): ${lacking.join('; ')}` };
  const e1 = projectedAxis(laminate.plies[0]?.axis0 ?? [1, 0, 0], normal);
  if (e1 === null) return { skipped: 'the rosette 0-degree axis is normal to the shell' };
  const e2 = normalize3(cross3(normal, e1));
  const top = fields['STRESS_TOP'];
  const bottom = fields['STRESS_BOT'];
  if (top === undefined || bottom === undefined)
    return { skipped: 'the results have no STRESS_TOP / STRESS_BOT fibre stresses of this shell (ply stresses need both outer surfaces)' };
  const ordered = dot3(normal, laminate.stackNormal) < 0 ? [...laminate.plies].reverse() : laminate.plies;
  const mmPerUnit = toMetres(doc, 1) * 1000;
  const stack: StackPly<LaminaMaterial>[] = ordered.map((ply) => ({
    material: { ...(laminate.materials[ply.materialName] as LaminaMaterial), plyThickness: ply.thickness * mmPerUnit },
    angle: ply.angleDeg,
  }));
  const perMpa = stressPerMpa(analysis.unitSystem);
  const worst = new Map<number, Worst>();
  for (const node of nodes) {
    const [t, b] = [top.values[String(node)], bottom.values[String(node)]];
    if (t === undefined || b === undefined) continue;
    const recovered = recoverPlyStresses(
      stack,
      inPlane(b, e1, e2).map((value) => value / perMpa) as unknown as Triple,
      inPlane(t, e1, e2).map((value) => value / perMpa) as unknown as Triple,
    );
    if (recovered === null) return { skipped: 'the laminate stiffness is singular: ply stresses cannot be recovered' };
    recovered.forEach((ply, index) => {
      const material = (stack[index] as StackPly<LaminaMaterial>).material;
      const strengths = strengthsOf(material) as Strengths;
      for (const [position, stress] of [
        ['bottom', ply.bottom],
        ['top', ply.top],
      ] as const) {
        const f12 = material.tsaiWuF12Star ?? DEFAULT_F12_STAR;
        const max = strengthRatio('max_stress', stress, strengths);
        const wu = strengthRatio('tsai_wu', stress, strengths, f12);
        const governing = wu.R < max.R ? ('tsai_wu' as const) : ('max_stress' as const);
        const R = Math.min(max.R, wu.R);
        const current = worst.get(index);
        if (current === undefined || R < current.R)
          worst.set(index, {
            R,
            criterion: governing,
            mode: governing === 'max_stress' ? max.mode : undefined,
            ratios: { max_stress: max.R, tsai_wu: wu.R },
            position,
            stress,
            node,
          });
      }
    });
  }
  if (worst.size === 0) return { skipped: 'no node of the group has both STRESS_TOP and STRESS_BOT' };
  const coordinates = nodeCoordinates(mesh);
  const stress = stressUnitName(analysis.unitSystem);
  const length = `${lengthUnitName(analysis.unitSystem).charAt(0).toUpperCase()}${lengthUnitName(analysis.unitSystem).slice(1)}`;
  const factor = appliedFactor(factors, 'ultimate', loadCase.category);
  const rows: PlyRow[] = ordered.flatMap((ply, index) => {
    const hit = worst.get(index);
    if (hit === undefined) return [];
    const material = (stack[index] as StackPly<LaminaMaterial>).material;
    const ms = Number.isFinite(hit.R) ? marginOfSafety(hit.R, 1, factor) : null;
    const status = statusOf(ms, input.marginalBand);
    const rowKey = [loadCase.name, entityId, region, 'ultimate', 'ply_failure', ply.id].join('|') + (singular ? '|singular' : '');
    const decided = dispositionOf(
      analysis,
      { rowKey, status, ms, inputHash: analysisInputHash(doc, analysis.id, 'full') },
      input.port,
      analysis.results?.resultsHash ?? '',
    );
    const unverified = isUnverified(material);
    const at: Vec3 = coordinates.get(hit.node) ?? [0, 0, 0];
    const finite = (value: number): number | null => (Number.isFinite(value) ? value : null);
    return [
      {
        rowKey,
        part: entityId,
        region: singular ? 'singular' : region,
        ...(singular ? { groupRegion: region } : {}),
        loadCase: loadCase.name,
        category: loadCase.category,
        check: 'ultimate',
        criterion: 'ply_failure',
        plyCriterion: hit.criterion,
        ply: { id: ply.id, name: ply.name, index, angleDeg: ply.angleDeg, material: ply.materialName, position: hit.position },
        strengthRatio: finite(hit.R),
        strengthRatios: { max_stress: finite(hit.ratios.max_stress), tsai_wu: finite(hit.ratios.tsai_wu) },
        ...(hit.mode === undefined ? {} : { failureMode: hit.mode }),
        [`plyStress${stress === 'psi' ? 'Psi' : stress}`]: {
          sigma1: hit.stress[0] * perMpa,
          sigma2: hit.stress[1] * perMpa,
          tau12: hit.stress[2] * perMpa,
        },
        allowable: {
          property: 'Xt, Xc, Yt, Yc, S',
          basis: material.basis,
          provenance: material.source,
          tsaiWuF12Star: { value: material.tsaiWuF12Star ?? DEFAULT_F12_STAR, defaulted: material.tsaiWuF12Star === undefined },
        },
        factorApplied: factor,
        ms,
        status,
        ...(status === 'FAIL' ? { code: 'FEA_MS_NEGATIVE' } : status === 'MARGINAL' ? { code: 'FEA_MS_MARGINAL' } : {}),
        node: hit.node,
        [`at${length}`]: at,
        singular,
        ...(singular
          ? {
              singularNote:
                'peak within the singularity radius of a point / edge load or support: mesh-dependent, excluded from minMs; judge it yourself',
            }
          : {}),
        provenance: {
          formula:
            'MS = R / (FoS x prod(extra)) - 1, R = first-ply strength ratio (lower of max stress and Tsai-Wu) of the ply stresses recovered through the laminate',
          method:
            'CLT (Kirchhoff-Love): strains at the outer surfaces from STRESS_TOP / STRESS_BOT through the Qbar of the outer plies, linear through the thickness; in-plane stresses only, first-ply failure, no hygrothermal state, no interlaminar stresses',
          standard: ['NASA-STD-5001B', '14 CFR 25.303', '14 CFR 25.305(a)'],
          ...(ms === null ? { note: 'no stress in this ply: no finite margin' } : {}),
        },
        unverified,
        unverifiedReasons: unverified ? [`lamina '${ply.materialName}': ${material.basis} data, source "${material.source}"`] : [],
        reviewRequired: true,
        reviewReason: 'margin of safety supports a structural substantiation decision',
        disposition: decided.disposition,
        statusLabel: decided.statusLabel,
        ...(decided.record !== undefined ? { dispositionRecord: decided.record } : {}),
        ...(decided.note !== undefined ? { dispositionNote: decided.note } : {}),
      },
    ];
  });
  return { rows };
}
