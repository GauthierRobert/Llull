/** check_property_models (PHY-01, AF-20): readiness check over the document's property models. */

import { convertValue, isUnitFailure } from '../../lib/quantity';
import { catalogEntry } from '../../model/propertyCatalog';
import { evaluateForm, isFormFailure } from '../../model/propertyForms';
import type { PropertyForm, PropertyModel } from '../../model/propertyModel';
import { baseEvaluatorOf, modelUnverifiedReasons, type PropertyRecord } from '../../model/propertyModelEval';
import { samplePoints } from '../../model/propertyTabulate';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';

const DISCONTINUITY_TOL = 1e-3;
const FIT_POOR = 0.05;

interface Item {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
  readonly values?: Readonly<Record<string, number>>;
}

/** Value of `form` at x, given in `unit` (default: the model's variable unit). */
const valueAt = (record: PropertyRecord, model: PropertyModel, form: PropertyForm, x: number, unit?: string): number | null => {
  const spec = model.variables[0];
  if (spec === undefined) return null;
  const converted = unit === undefined ? { value: x } : convertValue(x, unit, spec.unit);
  if (isUnitFailure(converted)) return null;
  const result = evaluateForm(form, { [spec.variable]: converted.value }, undefined, baseEvaluatorOf(record));
  return isFormFailure(result) ? null : result.value;
};

/** Relative jumps at the breakpoints of a top-level piecewise form (right segment start minus left segment end). */
function discontinuities(record: PropertyRecord, model: PropertyModel, tolerance: number): Item[] {
  const form = model.form;
  if (form.kind !== 'piecewise') return [];
  const items: Item[] = [];
  form.segments.forEach((segment, i) => {
    const next = form.segments[i + 1];
    if (next === undefined) return;
    const left = valueAt(record, model, segment.form, segment.upTo);
    const right = valueAt(record, model, next.form, segment.upTo);
    if (left === null || right === null) return;
    const jump = right - left;
    const relative = Math.abs(jump) / Math.max(Math.abs(left), Number.MIN_VALUE);
    if (relative > tolerance) {
      items.push({
        code: 'PROP_DISCONTINUITY',
        severity: 'warning',
        ids: [`${record.name}/${model.id}`],
        message: `jump of ${jump.toPrecision(6)} ${model.unit} (${relative.toExponential(2)} relative) at ${form.variable} = ${segment.upTo}`,
        remediation: 'confirm with the source; smooth or accept explicitly',
        values: { breakpoint: segment.upTo, jump, relativeJump: relative },
      });
    }
  });
  return items;
}

const sourceKey = (model: PropertyModel): string =>
  JSON.stringify([
    model.provenance.sourceId ?? model.provenance.citation ?? '',
    model.provenance.locator ?? '',
    model.property,
    model.direction ?? null,
    model.condition ?? null,
  ]);

/** Common 1D range of two models (equation ranges in the first model's variable unit), or null. */
function commonRange(a: PropertyModel, b: PropertyModel): [number, number] | null {
  const ra = a.validity[0];
  const rb = b.validity[0];
  if (a.variables.length !== 1 || b.variables.length !== 1 || ra === undefined || rb === undefined || ra.variable !== rb.variable)
    return null;
  const [lo, hi] = (rb.equation ?? rb.data).map((v) => {
    const converted = convertValue(v, rb.unit, ra.unit);
    return isUnitFailure(converted) ? Number.NaN : converted.value;
  });
  const [alo, ahi] = ra.equation ?? ra.data;
  const low = Math.max(alo, lo ?? Number.NaN);
  const high = Math.min(ahi, hi ?? Number.NaN);
  return low < high ? [low, high] : null;
}

/**
 * @affects nothing — read-only; data { status, items[], unverified[] }
 * @invariant status = fail on any error item, warn on any warning, else pass
 */
export const checkPropertyModels = defineCommand({
  name: 'check_property_models',
  annotations: { readOnly: true },
  description:
    'Readiness check of the property models of the document (or of the listed materials): piecewise jumps above discontinuityTol ' +
    '(PROP_DISCONTINUITY, default 1e-3 relative), the same source + locator transcribed with different coefficients (PROP_SOURCE_CONFLICT ' +
    'with the max difference over the common range), a positive-only property ≤ 0 somewhere in range (PROP_NONPOSITIVE_IN_RANGE), poor ' +
    '(PROP_FIT_POOR) or unreviewed (PROP_FIT_UNREVIEWED) fits, models without an equation range (PROP_EQUATION_RANGE_MISSING, info), and ' +
    'the list of unverified models with reasons. Read-only; run it before handing a property-based result to the owner.',
  params: z.object({
    material: z.array(z.string()).optional().describe('Only these material ids (default: every material).'),
    discontinuityTol: z.number().positive().optional().describe('Relative jump tolerance at piecewise breakpoints (default 1e-3).'),
  }),
  run: (doc, params): CommandResult => {
    const tolerance = params.discontinuityTol ?? DISCONTINUITY_TOL;
    const names = params.material ?? Object.keys(doc.materials);
    const items: Item[] = [];
    const unverified: { id: string; reasons: string[] }[] = [];
    const bySource = new Map<string, { record: PropertyRecord; model: PropertyModel }[]>();
    for (const materialName of names) {
      const material = Object.hasOwn(doc.materials, materialName) ? doc.materials[materialName] : undefined;
      if (material === undefined) {
        items.push({
          code: 'MAT_RECORD_NOT_FOUND',
          severity: 'error',
          ids: [materialName],
          message: `no material '${materialName}'`,
          remediation: 'create_material first',
        });
        continue;
      }
      const record: PropertyRecord = {
        name: materialName,
        ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}),
      };
      for (const model of material.propertyModels ?? []) {
        const id = `${materialName}/${model.id}`;
        items.push(...discontinuities(record, model, tolerance));
        const reasons = modelUnverifiedReasons(model);
        if (reasons.length > 0) unverified.push({ id, reasons });
        if (model.validity.some((range) => range.equation === undefined)) {
          items.push({
            code: 'PROP_EQUATION_RANGE_MISSING',
            severity: 'info',
            ids: [id],
            message: 'no equation range: the data range is used',
            remediation: 'give the equation range the source states',
          });
        }
        if (model.fit !== undefined && model.fit.residual.maxRel > FIT_POOR) {
          items.push({
            code: 'PROP_FIT_POOR',
            severity: 'warning',
            ids: [id],
            message: `max relative residual ${model.fit.residual.maxRel.toExponential(2)}`,
            remediation: 'try another form or degree; do not use for design without review',
          });
        }
        if (model.fit !== undefined && model.reviewedBy === undefined) {
          items.push({
            code: 'PROP_FIT_UNREVIEWED',
            severity: 'warning',
            ids: [id],
            message: 'fitted model not accepted by a reviewer',
            remediation: 'ask a qualified reviewer (human gate)',
          });
        }
        const range = model.validity[0];
        if (catalogEntry(model.property)?.positive === true && model.variables.length === 1 && range !== undefined) {
          const [low, high] = range.equation ?? range.data;
          const offending = samplePoints(low, high, 101, 'linear').find(
            (x) => (valueAt(record, model, model.form, x, range.unit) ?? 1) <= 0,
          );
          if (offending !== undefined) {
            items.push({
              code: 'PROP_NONPOSITIVE_IN_RANGE',
              severity: 'error',
              ids: [id],
              message: `${model.property} ≤ 0 at ${range.variable} = ${offending} ${range.unit}`,
              remediation: 'correct the coefficients or narrow the range',
              values: { at: offending },
            });
          }
        }
        const key = sourceKey(model);
        bySource.set(key, [...(bySource.get(key) ?? []), { record, model }]);
      }
    }
    for (const group of bySource.values()) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const a = group[i];
          const b = group[j];
          if (a === undefined || b === undefined || a.model.coefficientsSha256 === b.model.coefficientsSha256) continue;
          const common = commonRange(a.model, b.model);
          let maxAbs = 0;
          let maxRel = 0;
          for (const x of common === null ? [] : samplePoints(common[0], common[1], 101, 'linear')) {
            const va = valueAt(a.record, a.model, a.model.form, x, a.model.validity[0]?.unit);
            const vb = valueAt(b.record, b.model, b.model.form, x, a.model.validity[0]?.unit);
            if (va === null || vb === null) continue;
            const converted = convertValue(vb, b.model.unit, a.model.unit);
            const diff = Math.abs(va - (isUnitFailure(converted) ? vb : converted.value));
            maxAbs = Math.max(maxAbs, diff);
            maxRel = Math.max(maxRel, diff / Math.max(Math.abs(va), Number.MIN_VALUE));
          }
          items.push({
            code: 'PROP_SOURCE_CONFLICT',
            severity: 'warning',
            ids: [`${a.record.name}/${a.model.id}`, `${b.record.name}/${b.model.id}`],
            message: `same source and locator, different coefficients: max difference ${maxAbs.toPrecision(4)} ${a.model.unit} (${maxRel.toExponential(2)} relative)`,
            remediation: 're-read the primary source; keep one, mark it preferred',
            values: { maxAbsDiff: maxAbs, maxRelDiff: maxRel },
          });
        }
      }
    }
    const status = items.some((item) => item.severity === 'error')
      ? 'fail'
      : items.some((item) => item.severity === 'warning')
        ? 'warn'
        : 'pass';
    const counted = items.filter((item) => item.severity !== 'info');
    return report(
      doc,
      `check_property_models: ${status} — ${counted.length} finding(s)${counted.length > 0 ? ` (${[...new Set(counted.map((i) => i.code))].join(', ')})` : ''}, ${unverified.length} unverified model(s).`,
      {
        status,
        items,
        unverified,
        defaults:
          params.discontinuityTol === undefined
            ? [{ name: 'discontinuityTol', value: DISCONTINUITY_TOL, source: 'llull choice (OQ-PROP-06)', defaulted: true }]
            : [],
      },
    );
  },
});
