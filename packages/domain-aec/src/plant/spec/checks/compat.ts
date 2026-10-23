/** Compatibility passes of `check_pipe_spec` (§5.6 6 and 7): dimensional standard mixing at butt-weld ends, and joint / end compatibility. */

import { bundledCatalog } from '../../catalog/bundled';
import { en10220OutsideDiameter, sizePair } from '../../catalog/nominal';
import type { ComponentType, DimensionalStandard, NominalSize } from '../../catalog/types';
import { resolveComponent } from '../resolve';
import { rangesOverlap, sizeLabel } from '../size';
import type { SpecComponent } from '../types';
import { finding, type CheckContext, type SpecFinding } from './finding';
import type { ComponentRows } from './rows';

/** Above this the end diameters are different series (EN 10220 vs ASME B36.10M at DN65 / DN125: 3.1 / 1.6 mm); below 0.1 mm they are equal. */
const END_OD_MIXED_MM = 1;
const END_OD_ROUNDING_MM = 0.1;
const BUTT_WELD_TYPES: ReadonlySet<ComponentType> = new Set([
  'elbow90',
  'elbow45',
  'tee',
  'reducingTee',
  'reducerConcentric',
  'reducerEccentric',
  'cap',
]);

/** Outside diameter (mm) of the pipe series `standard` at `size`: B36.10M by NPS, EN 10220 by DN. */
function seriesOd(standard: DimensionalStandard, size: NominalSize): number | null {
  const pair = sizePair(size.system === 'NPS' ? { nps: size.key } : { dn: size.key });
  if (pair === null) return null;
  if (standard === 'EN') return pair.dn === null ? null : en10220OutsideDiameter(pair.dn);
  if (standard !== 'ASME') return null;
  const pipe = bundledCatalog().families.find((family) => family.id === 'asme-b36.10m');
  return pipe?.sizes.find((row) => row.size.key === pair.nps?.key)?.dims['outsideDiameter']?.value ?? null;
}

/** Standard of a fitting that has no catalogue family, from its `catalogRef`. */
function standardOfReference(reference: string): DimensionalStandard | undefined {
  if (/\b(asme|mss)\b|(^|[-\s])b16|b36/i.test(reference)) return 'ASME';
  return /\b(en|din)[\s-]?\d|10253/i.test(reference) ? 'EN' : undefined;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Butt-weld fitting end OD against the spec's pipe OD at the same size: fail PSC_DIM_STANDARD_MIXED > 1.0 mm, warn PSC_DIM_STANDARD_ROUNDING > 0.1 mm. */
export function dimStandardFindings({ spec, catalogs }: CheckContext, rows: readonly ComponentRows[]): SpecFinding[] {
  return rows.flatMap((entry): SpecFinding[] => {
    if (!BUTT_WELD_TYPES.has(entry.component.type)) return [];
    const mixed: string[] = [];
    const rounding: string[] = [];
    let worst = 0;
    let pipeStandard: string | undefined;
    let fittingStandard: string | undefined;
    for (const resolved of entry.resolved) {
      const piped = resolveComponent(spec, catalogs, {
        type: 'pipe',
        ...(resolved.size.system === 'NPS' ? { nps: resolved.size.key } : { dn: resolved.size.key }),
      });
      if (!piped.ok) continue;
      const pipeStd =
        piped.resolved.dimensionalStandard ??
        (spec.dimensionalStandard === 'ASME' || spec.dimensionalStandard === 'EN' ? spec.dimensionalStandard : undefined);
      const fitStd = resolved.dimensionalStandard ?? standardOfReference(entry.component.catalogRef);
      const pipeOd = piped.resolved.dims['outsideDiameter']?.value;
      const fitOd = fitStd === undefined ? null : seriesOd(fitStd, resolved.size);
      if (pipeStd === undefined || fitStd === undefined || pipeOd === undefined || fitOd === null) continue;
      pipeStandard = pipeStd;
      fittingStandard = fitStd;
      const delta = Math.abs(pipeOd - fitOd);
      worst = Math.max(worst, delta);
      const text = `${sizeLabel(resolved.size)}: pipe ${pipeOd} vs fitting ${fitOd} mm`;
      if (delta > END_OD_MIXED_MM) mixed.push(text);
      else if (delta > END_OD_ROUNDING_MM) rounding.push(text);
    }
    const path = `components.${entry.index}`;
    const values = { maxDeltaMm: round2(worst), thresholdMm: END_OD_MIXED_MM };
    if (mixed.length > 0)
      return [
        finding(
          spec.id,
          'dimStandard',
          'PSC_DIM_STANDARD_MIXED',
          'fail',
          [entry.component.id],
          [path],
          `component ${entry.component.id} (${fittingStandard} end diameters) does not fit the spec pipe (${pipeStandard}): ${mixed.join('; ')}`,
          values,
        ),
      ];
    return rounding.length === 0
      ? []
      : [
          finding(
            spec.id,
            'dimStandard',
            'PSC_DIM_STANDARD_ROUNDING',
            'warn',
            [entry.component.id],
            [path],
            `component ${entry.component.id} end diameters differ from the spec pipe by 0.1 to 1.0 mm: ${rounding.join('; ')}`,
            values,
          ),
        ];
  });
}

const JOINT_TYPES: ReadonlySet<ComponentType> = new Set([
  'flangeWeldNeck',
  'flangeSlipOn',
  'flangeBlind',
  'flangeSocketWeld',
  'flangeThreaded',
  'flangeLapJoint',
  'gasketSpiralWound',
  'gasketSheet',
  'gasketRing',
  'boltSet',
]);
const TRANSITION_TYPES: ReadonlySet<ComponentType> = new Set(['swage', 'coupling', 'union']);

const overlaps = (a: SpecComponent, b: SpecComponent): boolean => rangesOverlap(a.from, a.to, b.from, b.to);

/** Joint compatibility: flange / gasket / bolt components of one size with different class or facing; BW <-> SW without a transition part (warn PSC_END_INCOMPATIBLE). */
export function jointFindings({ spec }: CheckContext): SpecFinding[] {
  const out: SpecFinding[] = [];
  const joints = spec.components
    .map((component, index) => ({ component, index }))
    .filter(({ component }) => JOINT_TYPES.has(component.type) || (component.type.startsWith('valve') && component.ends === 'FL'));
  joints.forEach((a, i) =>
    joints.slice(i + 1).forEach((b) => {
      if (!overlaps(a.component, b.component)) return;
      const differs: string[] = [];
      if (a.component.class !== undefined && b.component.class !== undefined && a.component.class !== b.component.class)
        differs.push(`class ${a.component.class} vs ${b.component.class}`);
      if (a.component.facing !== undefined && b.component.facing !== undefined && a.component.facing !== b.component.facing)
        differs.push(`facing ${a.component.facing} vs ${b.component.facing}`);
      if (differs.length > 0)
        out.push(
          finding(
            spec.id,
            'joints',
            'PSC_END_INCOMPATIBLE',
            'warn',
            [a.component.id, b.component.id],
            [`components.${a.index}`, `components.${b.index}`],
            `${a.component.id} and ${b.component.id} meet in one joint but differ: ${differs.join(', ')}`,
          ),
        );
    }),
  );
  const pipes = spec.components.filter((component) => component.type === 'pipe');
  const transition = (from: NominalSize, to: NominalSize): boolean =>
    spec.components.some((component) => TRANSITION_TYPES.has(component.type) && rangesOverlap(component.from, component.to, from, to));
  spec.components.forEach((component, index) => {
    const wrong = component.ends === 'SW' ? 'BE' : component.ends === 'BW' ? 'PE' : undefined;
    if (wrong === undefined || transition(component.from, component.to)) return;
    const clash = pipes.find((pipe) => pipe.ends === wrong && overlaps(pipe, component));
    if (clash !== undefined)
      out.push(
        finding(
          spec.id,
          'joints',
          'PSC_END_INCOMPATIBLE',
          'warn',
          [component.id, clash.id],
          [`components.${index}`],
          `${component.id} has ${component.ends} ends but pipe ${clash.id} in the same sizes has ${clash.ends} ends and the spec has no transition component (swage, coupling, union)`,
        ),
      );
  });
  return out;
}
