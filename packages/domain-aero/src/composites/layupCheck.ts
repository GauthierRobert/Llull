/** check_layup engine (06 CMP FR-CMP-66): rule, blending, ramp, strength-ratio, material-verification and default findings with waiver state. */

import type { CompositePart, CompositesModel, LayupWaiver } from '@core/model/composites';
import type { DocumentUnit } from '@core/model/types';
import { polygonCentroid } from '@lib/polygon';
import { sig } from '../shared/results';
import { analyzeStack, type Loads } from './analysis';
import { isUnverified } from './provenance';
import { type Thresholds, effectiveRules, ruleFindings } from './ruleReport';
import { DEFAULT_DROP_RULES } from './rules';
import { representativePoint, stackAt } from './sample';
import { pliesOf, zonesOf } from './state';
import { blendZones } from './zones';

export interface LayupFinding {
  readonly code: string;
  readonly severity: 'fail' | 'warn';
  readonly message: string;
  readonly ids: readonly string[];
  readonly value?: number | undefined;
  readonly limit?: number | undefined;
  readonly unit?: string | undefined;
  readonly remediation: string;
  readonly waiverStatus?: 'pending' | 'approved' | undefined;
}

export interface LoadCase extends Loads {
  readonly name?: string | undefined;
}

const REMEDIATION: Readonly<Record<string, string>> = {
  CMP_FPF_RATIO_BELOW_ONE:
    'add plies or change angles; accepting a ratio below 1 is a human gate (request_layup_waiver, then approval by a qualified person)',
  CMP_MATERIAL_UNVERIFIED: 'use a sourced A/B-basis record (cited allowables) instead of mean / unknown data',
  CMP_DEFAULT_USED: 'give the programme value explicitly (set_laminate_rules, set_ply_drop_rules, material tsaiWuF12Star)',
  CMP_RAMP_CONFLICT: 'move the zone boundary, lower the ramp ratio (with a reviewer) or reduce the thickness step',
  CMP_WAIVER_PENDING: 'ask the qualified reviewer to approve the waiver; the finding stays a failure until then',
  CMP_MATERIAL_ALLOWABLE_MISSING: 'add Xt, Xc, Yt, Yc and S from a cited source (no default exists) to run the strength check',
  CMP_NOT_BLENDABLE: 'edit the zones so every stack embeds in the thickest one',
};

const waiverFor = (waivers: readonly LayupWaiver[], part: CompositePart, finding: LayupFinding): LayupWaiver | undefined =>
  waivers.find((w) => w.partId === part.id && w.code === finding.code && w.ids.every((id) => finding.ids.includes(id)));

export interface LayupReport {
  readonly findings: LayupFinding[];
  readonly defaults: Record<string, unknown>;
  readonly unverifiedMaterials: string[];
  readonly status: 'pass' | 'warn' | 'fail';
}

/**
 * Findings of a part. `release` evaluates every rule even if `set_laminate_rules` disabled it (a disable is a waiver needing human approval).
 * @invariant a failing finding keeps severity fail with waiverStatus pending until an approval reference exists on its waiver
 */
export function layupFindings(
  model: CompositesModel,
  part: CompositePart,
  options: {
    readonly purpose: 'design' | 'release';
    readonly loads?: readonly LoadCase[] | undefined;
    readonly thresholds?: Thresholds | undefined;
    readonly units: DocumentUnit;
  },
): LayupReport {
  const findings: LayupFinding[] = [];
  const { rules, named } = effectiveRules(part, options.thresholds);
  const checkedRules = options.purpose === 'release' ? { ...rules, disabled: [] } : rules;
  const { findings: ruleResults } = ruleFindings(model, part, checkedRules);
  for (const found of ruleResults)
    findings.push({
      code: found.code,
      severity: 'fail',
      message: `${found.rule} in zone "${found.zoneName}": ${found.value} vs limit ${found.limit} ${found.unit} (plies ${found.plies.join(', ')})`,
      ids: found.zoneId === null ? [part.id] : [found.zoneId],
      value: found.value,
      limit: found.limit,
      unit: found.unit,
      remediation: found.remediation,
    });
  const plies = pliesOf(model, part.id);
  const zones = zonesOf(model, part.id);
  const rampDefaulted = part.plyDropRules === undefined;
  const material = plies[0] === undefined ? undefined : model.materials[plies[0].materialName];
  if (zones.length > 0 && material !== undefined) {
    const blend = blendZones(zones, part, part.plyDropRules ?? DEFAULT_DROP_RULES, material.plyThickness);
    if (!blend.ok)
      findings.push({
        code: blend.code,
        severity: 'fail',
        message: blend.message,
        ids: blend.zoneIds,
        remediation: REMEDIATION['CMP_NOT_BLENDABLE'] as string,
      });
    else
      for (const conflict of blend.conflicts)
        findings.push({
          code: 'CMP_RAMP_CONFLICT',
          severity: 'fail',
          message: `a ${sig(conflict.needed)} ramp needs more room than the ${sig(conflict.available)} available near [${conflict.location.map(sig).join(', ')}]`,
          ids: conflict.zoneIds,
          value: sig(conflict.available),
          limit: sig(conflict.needed),
          unit: 'document length units',
          remediation: REMEDIATION['CMP_RAMP_CONFLICT'] as string,
        });
  }
  const usedMaterials = [...new Set(plies.map((ply) => ply.materialName))].flatMap((name) =>
    model.materials[name] === undefined ? [] : [model.materials[name]],
  );
  for (const used of usedMaterials.filter(isUnverified))
    findings.push({
      code: 'CMP_MATERIAL_UNVERIFIED',
      severity: 'warn',
      message: `material "${used.name}" is ${used.basis} data with source "${used.source}"`,
      ids: [used.name],
      remediation: REMEDIATION['CMP_MATERIAL_UNVERIFIED'] as string,
    });
  const stations =
    zones.length > 0
      ? zones.map((zone) => ({ id: zone.id, name: zone.name, uv: representativePoint(model, part, zone) }))
      : [{ id: part.id, name: part.name, uv: polygonCentroid(part.outline) }];
  for (const station of stations) {
    const entries = stackAt(model, part, station.uv);
    if (entries.length === 0) continue;
    for (const loadCase of options.loads ?? []) {
      const outcome = analyzeStack(
        entries.map((entry) => ({ material: entry.material, angle: entry.ply.orientation })),
        options.units,
        loadCase,
      );
      if (!outcome.ok) {
        findings.push({
          code: outcome.code,
          severity: 'warn',
          message: `${outcome.message} (zone "${station.name}")`,
          ids: [station.id],
          remediation: REMEDIATION[outcome.code] ?? 'see analyze_laminate',
        });
        continue;
      }
      const failure = outcome.data['firstPlyFailure'] as Record<string, { R: number | null }>;
      const ratios = Object.entries(failure).flatMap(([name, hit]) => (hit.R === null ? [] : [[name, hit.R] as const]));
      const worst = ratios.reduce<readonly [string, number] | null>(
        (best, next) => (best === null || next[1] < best[1] ? next : best),
        null,
      );
      if (worst !== null && worst[1] < 1)
        findings.push({
          code: 'CMP_FPF_RATIO_BELOW_ONE',
          severity: 'fail',
          message: `first-ply failure ratio ${worst[1]} (${worst[0]}) below 1 in zone "${station.name}" for load case "${loadCase.name ?? 'unnamed'}"`,
          ids: [station.id],
          value: worst[1],
          limit: 1,
          unit: 'strength ratio',
          remediation: REMEDIATION['CMP_FPF_RATIO_BELOW_ONE'] as string,
        });
    }
  }
  const waivers = Object.values(model.waivers).filter((w) => w.partId === part.id);
  const withWaivers = findings.flatMap((finding): LayupFinding[] => {
    const waiver = finding.severity === 'fail' ? waiverFor(waivers, part, finding) : undefined;
    if (waiver === undefined) return [finding];
    if (waiver.approvalRef !== undefined) return [{ ...finding, severity: 'warn', waiverStatus: 'approved' }];
    return [
      { ...finding, waiverStatus: 'pending' },
      {
        code: 'CMP_WAIVER_PENDING',
        severity: 'warn',
        message: `waiver ${waiver.id} for ${finding.code} has no human approval`,
        ids: [waiver.id],
        remediation: REMEDIATION['CMP_WAIVER_PENDING'] as string,
      },
    ];
  });
  const defaults: Record<string, unknown> = {
    ...Object.fromEntries(Object.entries(named).filter(([, entry]) => entry.defaulted)),
    ...(rampDefaulted && zones.length > 0
      ? {
          rampRatio: {
            value: DEFAULT_DROP_RULES.rampRatio,
            unit: '-',
            source: 'common published ramp ratio 20:1 (user rule)',
            defaulted: true,
          },
        }
      : {}),
    ...(usedMaterials.some((used) => used.tsaiWuF12Star === undefined) && (options.loads ?? []).length > 0
      ? { tsaiWuF12Star: { value: -0.5, unit: '-', source: 'common Tsai-Wu default without biaxial data (S36)', defaulted: true } }
      : {}),
  };
  if (options.purpose === 'release' && Object.keys(defaults).length > 0)
    withWaivers.push({
      code: 'CMP_DEFAULT_USED',
      severity: 'warn',
      message: `defaults in force: ${Object.keys(defaults).join(', ')}`,
      ids: Object.keys(defaults),
      remediation: REMEDIATION['CMP_DEFAULT_USED'] as string,
    });
  const status = withWaivers.some((f) => f.severity === 'fail') ? 'fail' : withWaivers.length > 0 ? 'warn' : 'pass';
  return { findings: withWaivers, defaults, unverifiedMaterials: usedMaterials.filter(isUnverified).map((m) => m.name), status };
}
