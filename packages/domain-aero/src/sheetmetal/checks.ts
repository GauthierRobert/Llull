/** Design-rule checks of a sheet-metal part (FR-FTR-07, 16, 34): each returns findings and says whether the rule could run. */

import type { DocumentUnit, Vec2 } from '@core/model/types';
import type { FtrFinding } from '@core/model/manufacturing';
import type { SheetMetalModel, SheetMetalPart, SheetMetalRule } from '@core/model/sheetMetal';
import { toDegrees } from '@lib/angle';
import { projectOntoSegment } from '@lib/polygon';
import { polygonToSegmentDistance } from './geometry2d';
import { type FlatNode, bendsOf, flatsOf, hemsOf, joggleNodes, reliefNodes } from './graph';
import { bendEnd } from './reliefGeometry';
import { findRadiusRow } from './rules';

export type SkipCode = 'FTR_RULE_THRESHOLD_MISSING' | 'FTR_BEND_RADIUS_NO_TABLE_ROW';

export interface RuleOutcome {
  readonly rule: string;
  readonly findings: FtrFinding[];
  readonly skipped?: SkipCode;
}

interface Context {
  readonly unit: DocumentUnit;
  readonly model: SheetMetalModel;
  readonly part: SheetMetalPart;
  readonly rule: SheetMetalRule;
}

const missingThreshold = (name: string, ids: readonly string[], what: string): RuleOutcome => ({
  rule: name,
  findings: [
    {
      code: 'FTR_RULE_THRESHOLD_MISSING',
      severity: 'warn',
      ids,
      remediation: `Set the ${what} threshold in the rule (with its source) to enable this check: create_sheet_metal_rule thresholds.`,
    },
  ],
  skipped: 'FTR_RULE_THRESHOLD_MISSING',
});

export function minBendRadius({ unit, model, part, rule }: Context): RuleOutcome {
  const closedHems = new Set(hemsOf(part).flatMap((hem) => (hem.hemType === 'closed' ? [hem.bend] : [])));
  const bends = bendsOf(part).filter((bend) => !closedHems.has(bend.id));
  const findings: FtrFinding[] = [];
  for (const bend of bends)
    if (bend.insideRadius === 0 && rule.allowSharpBends !== true)
      findings.push({
        code: 'FTR_SHARP_BEND_FORBIDDEN',
        severity: 'fail',
        ids: [part.id, bend.id],
        value: 0,
        unit,
        remediation: 'Use an inside radius >= the table minimum, or a rule with allowSharpBends.',
      });
  const rows = bends.map((bend) => ({
    bend,
    match: findRadiusRow(model.radiusTable, {
      material: rule.material,
      temper: rule.temper,
      thickness: rule.thickness,
      unit,
      angleDeg: toDegrees(Math.abs(bend.angle)),
    }),
  }));
  if (bends.length > 0 && rows.some(({ match }) => match === undefined)) {
    findings.push({
      code: 'FTR_BEND_RADIUS_NO_TABLE_ROW',
      severity: 'warn',
      ids: [part.id, rule.name],
      remediation: 'Import a sourced row with import_bend_radius_table (material, temper and thickness must match the rule).',
    });
    return { rule: 'min_bend_radius', findings, skipped: 'FTR_BEND_RADIUS_NO_TABLE_ROW' };
  }
  for (const { bend, match } of rows)
    if (match !== undefined && bend.insideRadius < match.minInsideRadius - 1e-9)
      findings.push({
        code: 'FTR_BEND_RADIUS_BELOW_MIN',
        severity: 'fail',
        ids: [part.id, bend.id],
        value: bend.insideRadius,
        limit: match.minInsideRadius,
        unit,
        source: match.row.source,
        remediation: 'Increase insideRadius to >= the limit or choose a softer temper / thinner sheet.',
      });
  return { rule: 'min_bend_radius', findings };
}

/** Bend tangent lines on a flat's own plane: its child bends, and the line to its parent at y = 0. */
export function bendLinesOn(part: SheetMetalPart, flat: FlatNode): Array<{ id: string; a: Vec2; b: Vec2 }> {
  return bendsOf(part).flatMap((bend) => {
    if (bend.from === flat.id) return [{ id: bend.id, a: bend.lineInFrom[0], b: bend.lineInFrom[1] }];
    if (bend.to !== flat.id) return [];
    const width = Math.hypot(bend.lineInFrom[1][0] - bend.lineInFrom[0][0], bend.lineInFrom[1][1] - bend.lineInFrom[0][1]);
    return [{ id: bend.id, a: [0, 0] as Vec2, b: [width, 0] as Vec2 }];
  });
}

/** Distance from a cutout to the segment a-b (the exact circle when there is one). */
function cutoutToSegment(cutout: FlatNode['cutouts'][number], a: Vec2, b: Vec2): number {
  return cutout.circle !== undefined
    ? Math.max(0, projectOntoSegment(cutout.circle.center, a, b).distance - cutout.circle.radius)
    : polygonToSegmentDistance(cutout.points, a, b);
}

const onLine = (point: Vec2, a: Vec2, b: Vec2): boolean => projectOntoSegment(point, a, b).distance < 1e-6;

export function holeDistances({ unit, part, rule }: Context, which: 'holeToBend' | 'holeToEdge'): RuleOutcome {
  const name = which === 'holeToBend' ? 'hole_to_bend' : 'hole_to_edge';
  const flats = flatsOf(part).filter((flat) => flat.cutouts.length > 0);
  if (flats.length === 0) return { rule: name, findings: [] };
  const threshold = rule.thresholds?.[which];
  if (threshold === undefined) return missingThreshold(name, [part.id, rule.name], which);
  const findings: FtrFinding[] = [];
  for (const flat of flats) {
    const lines = bendLinesOn(part, flat);
    flat.cutouts.forEach((cutout, index) => {
      const hole = `${flat.id}/cutout${index + 1}`;
      if (which === 'holeToBend') {
        for (const line of lines) {
          const distance = cutoutToSegment(cutout, line.a, line.b);
          if (distance < threshold.value - 1e-9)
            findings.push({
              code: 'FTR_HOLE_TO_BEND_TOO_CLOSE',
              severity: 'fail',
              ids: [part.id, hole, line.id],
              value: distance,
              limit: threshold.value,
              unit,
              source: threshold.source,
              remediation: 'Move the hole away from the bend or add a relief.',
            });
        }
        return;
      }
      const edges = flat.outline
        .map((a, i) => ({ a, b: flat.outline[(i + 1) % flat.outline.length] as Vec2 }))
        .filter(({ a, b }) => !lines.some((line) => onLine(a, line.a, line.b) && onLine(b, line.a, line.b)));
      const distance = Math.min(...edges.map(({ a, b }) => cutoutToSegment(cutout, a, b)));
      if (edges.length > 0 && distance < threshold.value - 1e-9)
        findings.push({
          code: 'FTR_HOLE_TO_EDGE_TOO_CLOSE',
          severity: 'fail',
          ids: [part.id, hole],
          value: distance,
          limit: threshold.value,
          unit,
          source: threshold.source,
          remediation: 'Move the hole inward or reduce its diameter.',
        });
    });
  }
  return { rule: name, findings };
}

export function minFlange({ unit, part, rule }: Context): RuleOutcome {
  const inclines = new Set(joggleNodes(part).map((joggle) => joggle.incline));
  const flanges = flatsOf(part).filter((flat) => flat.id !== part.root && !inclines.has(flat.id));
  if (flanges.length === 0) return { rule: 'min_flange', findings: [] };
  const threshold = rule.thresholds?.minFlange;
  if (threshold === undefined) return missingThreshold('min_flange', [part.id, rule.name], 'minFlange');
  const findings: FtrFinding[] = [];
  for (const flange of flanges) {
    const length = Math.max(...flange.outline.map((point) => point[1]));
    if (length < threshold.value - 1e-9)
      findings.push({
        code: 'FTR_FLANGE_TOO_SHORT',
        severity: 'fail',
        ids: [part.id, flange.id],
        value: length,
        limit: threshold.value,
        unit,
        source: threshold.source,
        remediation: 'Lengthen the flange.',
      });
  }
  return { rule: 'min_flange', findings };
}

export function reliefPresent({ part, rule }: Context): RuleOutcome {
  const bends = bendsOf(part);
  if (bends.length === 0 || rule.relief?.type === 'none') return { rule: 'relief', findings: [] };
  if (rule.relief === undefined) return missingThreshold('relief', [part.id, rule.name], 'relief');
  const reliefs = reliefNodes(part);
  const findings: FtrFinding[] = [];
  for (const bend of bends) {
    const parent = flatsOf(part).find((flat) => flat.id === bend.from);
    if (parent === undefined) continue;
    for (const end of ['start', 'end'] as const) {
      const location = bendEnd(parent.outline, bend.lineInFrom, end);
      if (location !== null && location.free > 1e-6 && !reliefs.some((node) => node.bend === bend.id && node.end === end))
        findings.push({
          code: 'FTR_RELIEF_MISSING',
          severity: 'warn',
          ids: [part.id, bend.id],
          value: location.free,
          remediation: `add_relief on bend ${bend.id} (end ${end}).`,
        });
    }
  }
  return { rule: 'relief', findings };
}

export type { Context as CheckContext };
