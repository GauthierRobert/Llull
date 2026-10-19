/** Rule evaluation of a part's stacks with named thresholds (06 CMP FR-CMP-20, FR-CMP-67): shared by check_laminate_rules and check_layup. */

import type { CompositePart, CompositesModel, RuleConfig } from '@core/model/composites';
import { type RuleFinding, DEFAULT_RULES, checkStack } from './rules';
import { pliesOf, zonesOf } from './state';

export interface Thresholds {
  readonly symmetric?: boolean | undefined;
  readonly balanced?: boolean | undefined;
  readonly minFraction?: number | undefined;
  readonly maxConsecutive?: number | undefined;
  readonly outerPlusMinus45?: boolean | undefined;
  readonly maxAngleChange?: number | undefined;
}

export interface NamedThreshold {
  readonly value: number | boolean;
  readonly unit: string;
  readonly source: string;
  readonly defaulted: boolean;
}

const KEYS = ['symmetric', 'balanced', 'minFraction', 'maxConsecutive', 'outerPlusMinus45', 'maxAngleChange'] as const;
const UNIT: Readonly<Record<(typeof KEYS)[number], string>> = {
  symmetric: '-',
  balanced: '-',
  minFraction: 'fraction of plies',
  maxConsecutive: 'plies',
  outerPlusMinus45: '-',
  maxAngleChange: 'degrees',
};

/** The rule configuration in force (defaults < part rules < call thresholds) and where each value came from. */
export function effectiveRules(
  part: CompositePart,
  thresholds: Thresholds = {},
): { rules: RuleConfig; named: Record<string, NamedThreshold> } {
  const given = Object.fromEntries(Object.entries(thresholds).filter(([, value]) => value !== undefined));
  const rules: RuleConfig = { ...DEFAULT_RULES, ...part.rules, ...given };
  const named = Object.fromEntries(
    KEYS.flatMap((key) => {
      const value = rules[key];
      if (value === undefined) return [];
      const fromCall = key in given;
      const fromPart = part.rules !== undefined && key in part.rules;
      const entry: NamedThreshold = {
        value,
        unit: UNIT[key],
        source: fromCall
          ? 'call parameter'
          : fromPart
            ? 'set_laminate_rules'
            : 'common published guidelines (CMH-17 / industry), not a quoted clause',
        defaulted: !fromCall && !fromPart,
      };
      return [[key, entry]];
    }),
  );
  return { rules, named };
}

export interface ZoneFinding extends RuleFinding {
  readonly zoneId: string | null;
  readonly zoneName: string;
}

/** Rule findings of each selected zone's stack (all zones; or the whole ply list when the part has no zones). */
export function ruleFindings(
  model: CompositesModel,
  part: CompositePart,
  rules: RuleConfig,
  only?: readonly string[],
): { findings: ZoneFinding[]; checked: string[] } {
  const zones = zonesOf(model, part.id).filter((zone) => only === undefined || only.includes(zone.id) || only.includes(zone.name));
  const stacks =
    zonesOf(model, part.id).length === 0
      ? [{ id: null, name: 'all plies', angles: pliesOf(model, part.id).map((ply) => ply.orientation) }]
      : zones.map((zone) => ({ id: zone.id as string | null, name: zone.name, angles: zone.angles }));
  const findings = stacks.flatMap((stack) =>
    stack.angles.length === 0
      ? []
      : checkStack(stack.angles, rules).map((finding): ZoneFinding => ({ ...finding, zoneId: stack.id, zoneName: stack.name })),
  );
  return { findings, checked: stacks.map((stack) => stack.name) };
}
