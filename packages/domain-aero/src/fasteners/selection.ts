/**
 * select_fastener's engine (08 MAT FR-MAT-12..14, TECHNICAL_SPEC §5.2): resolves family, size, stack, nut and washer from the document
 * catalogue, runs the grip / shim / length / protrusion rules and names every defaulted rule (AF-31). Shared by the insert commands.
 */

import { round6 } from '@lib/compactNumber';
import type { CadDocument, Vec3 } from '@core/model/types';
import type { FastenerFamily, FastenerSize } from '@core/model/fasteners';
import { unitAxisOrNull } from '@lib/axisRotation';
import { familyOf, sizeOf } from './fastenerDoc';
import { remediationFor } from './codes';
import { type FieldValues, formatWithGrammar, defaultedCodes } from './partNumber';
import { type Reason, selectBolt, selectMaxGripPin, selectRivetLength } from './selectCore';
import { measureStack } from './stackMeasure';
import { CONTACT_TOLERANCE_IN, convertTo, docToInches, inchesToDoc, ticksToInches, toTicks } from './units';
import type { SelectionParams } from './selectionParams';

interface PlacedWasher {
  readonly partNumber: string;
  readonly thicknessIn: number;
}

interface PlacedNut {
  readonly partNumber: string;
  readonly family: FastenerFamily;
  readonly size: FastenerSize;
}

export interface MeasuredStack {
  readonly origin: Vec3;
  readonly direction: Vec3;
  /** Axis parameters of the stack's first entry face and last exit face. */
  readonly startS: number;
  readonly endS: number;
  readonly layers: ReadonlyArray<{ readonly entityId: string; readonly thicknessIn: number }>;
}

/** A successful selection with everything an insert needs. */
export interface Resolved {
  readonly family: FastenerFamily;
  readonly size: FastenerSize;
  readonly partNumber: string;
  readonly mode: 'bolt' | 'pin' | 'rivet';
  /** Shank length below the head, inches (a pin has no listed length: the top of its grip range). */
  readonly lengthIn: number;
  readonly representativeLength: boolean;
  readonly washers: readonly PlacedWasher[];
  readonly washerSide: 'nut' | 'head';
  readonly nut: PlacedNut | null;
  readonly stackIn: number;
  readonly measured: MeasuredStack | null;
}

export interface SelectionOutcome {
  readonly ok: boolean;
  readonly data: Record<string, unknown>;
  readonly failure: { readonly code: string; readonly message: string; readonly ids: readonly string[] } | null;
  readonly resolved: Resolved | null;
}

const MAX_WASHER_SOURCE = 'AC 43.13-1B 7-37';
const PROTRUSION_SOURCE = "AC 43.13-1B 7-37 ('at least one thread'); llull reading";
const EDGE_PITCH_SOURCE = 'AC 43.13-1B 4-57(c)';
const ROUNDING_SOURCE = 'llull choice (OQ-MAT-04); catalogue lengthRule.round';

const withRemediation = (reason: Reason): Reason & { remediation: string } => ({ ...reason, remediation: remediationFor(reason.code) });

function refused(code: string, message: string, ids: readonly string[], extra: Record<string, unknown> = {}): SelectionOutcome {
  return {
    ok: false,
    data: { ok: false, reasons: [withRemediation({ code, message })], warnings: [], ...extra },
    failure: { code, message, ids },
    resolved: null,
  };
}

const numericDash = (dash: string): number => (/^\d+$/.test(dash) ? Number(dash) : Number.NaN);

function partNumberOf(
  family: FastenerFamily,
  size: FastenerSize,
  extra: Record<string, number>,
  codes: FieldValues,
): { text: string; defaulted: string[] } {
  const values: Record<string, string | number> = { ...codes, ...extra, diameterDash: numericDash(size.dash) };
  const text = formatWithGrammar(family.partNumber, values) ?? `${family.id}-${size.dash}`;
  return { text, defaulted: defaultedCodes(family.partNumber, values) };
}

/** Largest known dimension value of a size (max, else nominal, else min), in the dimension's unit. */
function dimensionTicks(size: FastenerSize, name: string, work: string): number | null {
  const dimension = size.dims[name];
  if (dimension === undefined) return null;
  const value = dimension.max ?? dimension.nominal ?? dimension.min;
  return value === undefined ? null : toTicks(value, dimension.unit, work);
}

function washerOptions(size: FastenerSize, work: string): number[] | null {
  const thickness = size.dims['thickness'];
  if (thickness === undefined) return null;
  const values = thickness.options ?? (thickness.nominal === undefined ? [] : [thickness.nominal]);
  const ticks = values.map((value) => toTicks(value, thickness.unit, work));
  return ticks.length === 0 || ticks.includes(null) ? null : (ticks as number[]);
}

function washerLabel(family: FastenerFamily, size: FastenerSize, thicknessTicks: number, work: string): string {
  const unit = size.dims['thickness']?.unit ?? work;
  const inUnit = toTicks(thicknessTicks / 1e6, work, unit) ?? thicknessTicks;
  return `${family.id}(${String(Number((inUnit / 1e6).toFixed(4))).replace(/^0\./, '.')})`;
}

type StackInput =
  | { readonly ok: true; readonly stackIn: number; readonly measured: MeasuredStack | null; readonly warnings: Reason[] }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly ids: readonly string[] };

function stackFrom(doc: CadDocument, p: SelectionParams): StackInput {
  if (p.stack !== undefined) {
    const inches = convertTo(p.stack.value, p.stack.unit, 'in');
    if (inches === null || !(inches > 0))
      return { ok: false, code: 'FAST_STACK_MISSING', message: `stack ${p.stack.value} ${p.stack.unit} is not a positive length`, ids: [] };
    return { ok: true, stackIn: inches, measured: null, warnings: [] };
  }
  if (p.stackIds === undefined || p.stackIds.length === 0 || p.axisPoint === undefined)
    return { ok: false, code: 'FAST_STACK_MISSING', message: 'neither stack nor stackIds with axisPoint was given', ids: [] };
  const direction = unitAxisOrNull(p.axis ?? [0, 0, 1]);
  if (direction === null) return { ok: false, code: 'FAST_STACK_MISSING', message: 'axis is not a non-zero direction', ids: [] };
  const measurement = measureStack(doc, p.stackIds, p.axisPoint, direction, inchesToDoc(doc, CONTACT_TOLERANCE_IN));
  if (!measurement.ok) return { ok: false, code: measurement.code, message: measurement.message, ids: measurement.ids };
  const warnings: Reason[] = [];
  const skewed = measurement.layers.filter((layer) => layer.entryAngleDeg > 2);
  if (skewed.length > 0)
    warnings.push({
      code: 'FAST_AXIS_ANGLE',
      message: `axis is more than 2 degrees from the face normal of ${skewed.map((layer) => layer.entityId).join(', ')}`,
    });
  return {
    ok: true,
    stackIn: docToInches(doc, measurement.thickness),
    measured: {
      origin: p.axisPoint,
      direction,
      startS: measurement.startS,
      endS: measurement.endS,
      layers: measurement.layers.map((layer) => ({ entityId: layer.entityId, thicknessIn: docToInches(doc, layer.exitS - layer.entryS) })),
    },
    warnings,
  };
}

interface Accessory {
  readonly family: FastenerFamily;
  readonly size: FastenerSize;
}

function accessory(doc: CadDocument, familyId: string, dash: string): Accessory | SelectionOutcome {
  const family = familyOf(doc, familyId);
  if (family === undefined) return refused('FAST_FAMILY_UNKNOWN', `family '${familyId}' is not in the document catalogue`, [familyId]);
  const size = sizeOf(family, dash);
  if (size === undefined) return refused('FAST_SIZE_UNKNOWN', `family '${familyId}' has no size with dash '${dash}'`, [familyId]);
  return { family, size };
}

const isOutcome = (value: Accessory | SelectionOutcome): value is SelectionOutcome => 'data' in value;

const rulesForRivet = (
  family: FastenerFamily,
  diameterIn: number,
  roundingGiven: 'up' | 'nearest' | undefined,
): Record<string, unknown> => ({
  rivetLengthRounding: {
    value: roundingGiven ?? (family.lengthRule?.kind === 'stack_plus_k_d' ? family.lengthRule.round : 'up'),
    step: family.lengthRule?.kind === 'stack_plus_k_d' ? family.lengthRule.step : undefined,
    source: roundingGiven === undefined ? ROUNDING_SOURCE : 'caller',
    defaulted: roundingGiven === undefined,
  },
  rivetMinEdgeDistance: { value: '2 D', valueIn: 2 * diameterIn, source: EDGE_PITCH_SOURCE, defaulted: true },
  rivetMinPitch: { value: '3 D', valueIn: 3 * diameterIn, source: EDGE_PITCH_SOURCE, defaulted: true },
});

const failOutcome = (code: string, message: string, ids: readonly string[], data: Record<string, unknown>): SelectionOutcome => ({
  ok: false,
  data,
  failure: { code, message, ids },
  resolved: null,
});

/**
 * Select the part number, washers, length and protrusion for a stack.
 * @failure unknown family/size, no stack, out-of-range grip, unshimmable gap, short protrusion -> ok:false with coded reasons
 */
export function runSelection(doc: CadDocument, p: SelectionParams): SelectionOutcome {
  const base = accessory(doc, p.family, p.diameterDash);
  if (isOutcome(base)) return base;
  const { family, size } = base;
  const mode =
    family.lengthRule?.kind === 'stack_plus_k_d' ? 'rivet' : family.gripMode === 'max_grip_range' ? 'pin' : family.gripMode ? 'bolt' : null;
  if (mode === null)
    return refused('FAST_FAMILY_NOT_SELECTABLE', `family '${family.id}' (${family.kind}) has no grip or length rule`, [family.id]);
  const stack = stackFrom(doc, p);
  if (!stack.ok) return refused(stack.code, stack.message, stack.ids);
  const work =
    family.gripIncrement?.unit ?? (family.lengthRule?.kind === 'stack_plus_k_d' ? family.lengthRule.step.unit : size.nominalDiameter.unit);
  const stackTicks = toTicks(stack.stackIn, 'in', work) ?? 0;
  const codes = p.codes ?? {};
  const common = { family: family.id, kind: family.kind, diameterDash: size.dash, stackIn: round6(stack.stackIn) };
  const measuredLayers = stack.measured?.layers ?? [];
  const layout = stack.measured === null ? {} : { stackSource: 'measured', layers: measuredLayers };
  const warnings: Reason[] = [...stack.warnings];

  if (mode === 'rivet') {
    const rule = family.lengthRule;
    if (rule?.kind !== 'stack_plus_k_d') return refused('FAST_FAMILY_NOT_SELECTABLE', 'rivet rule missing', [family.id]);
    const diameterTicks = toTicks(size.nominalDiameter.value, size.nominalDiameter.unit, work) ?? 0;
    const stepTicks = toTicks(rule.step.value, rule.step.unit, work) ?? 1;
    const length = selectRivetLength(stackTicks, diameterTicks, rule.k, stepTicks, p.rivetRounding ?? rule.round);
    const part = partNumberOf(family, size, { lengthDash: length.lengthDash }, codes);
    const diameterIn = ticksToInches(diameterTicks, work);
    const rivet = {
      rawLengthIn: ticksToInches(length.rawTicks, work),
      shopHeadMinDiameterIn: 1.5 * diameterIn,
      shopHeadMinHeightIn: 0.5 * diameterIn,
    };
    const lengthIn = ticksToInches(length.lengthTicks, work);
    const data = {
      ok: true,
      ...common,
      ...layout,
      partNumber: part.text,
      partNumberDefaultedCodes: part.defaulted,
      lengthIn,
      ...rivet,
      minEdgeDistanceIn: 2 * diameterIn,
      minPitchIn: 3 * diameterIn,
      rules: rulesForRivet(family, diameterIn, p.rivetRounding),
      reasons: [],
      warnings: warnings.map(withRemediation),
    };
    const resolved: Resolved = {
      family,
      size,
      partNumber: part.text,
      mode,
      lengthIn,
      representativeLength: false,
      washers: [],
      washerSide: 'nut',
      nut: null,
      stackIn: stack.stackIn,
      measured: stack.measured,
    };
    return { ok: true, data, failure: null, resolved };
  }

  const gripTicks = toTicks(family.gripIncrement?.value ?? 0, family.gripIncrement?.unit ?? work, work) ?? 0;
  const gripMin = family.availableGripDash?.min ?? 1;
  const gripMax = family.availableGripDash?.max ?? Number.MAX_SAFE_INTEGER;

  if (mode === 'pin') {
    const pin = selectMaxGripPin(stackTicks, gripTicks, gripMin, gripMax);
    const part = partNumberOf(family, size, { gripDash: pin.gripDash }, codes);
    const range = [ticksToInches(pin.rangeTicks[0], work), ticksToInches(pin.rangeTicks[1], work)];
    const given = [p.nut, p.washer].filter((value) => value !== undefined);
    if (given.length > 0 && pin.ok)
      warnings.push({ code: 'FAST_PROTRUSION_UNKNOWN', message: 'collar/nut and washers are not selected for a maximum-grip pin family' });
    const data = {
      ok: pin.ok,
      ...common,
      ...layout,
      partNumber: part.text,
      partNumberDefaultedCodes: part.defaulted,
      gripDash: pin.gripDash,
      gripIn: range[1],
      gripRangeIn: range,
      rules: {},
      reasons: pin.reasons.map(withRemediation),
      warnings: warnings.map(withRemediation),
    };
    const first = pin.reasons[0];
    if (!pin.ok && first) return failOutcome(first.code, first.message, [family.id], data);
    const resolved: Resolved = {
      family,
      size,
      partNumber: part.text,
      mode,
      lengthIn: range[1] ?? 0,
      representativeLength: true,
      washers: [],
      washerSide: 'nut',
      nut: null,
      stackIn: stack.stackIn,
      measured: stack.measured,
    };
    return { ok: true, data, failure: null, resolved };
  }

  const rule = family.lengthRule;
  const threadLengthTicks =
    rule?.kind === 'grip_plus_thread' && size.threadLength ? (toTicks(size.threadLength.value, size.threadLength.unit, work) ?? 0) : 0;
  const nutBase = p.nut === undefined ? null : accessory(doc, p.nut, size.dash);
  if (nutBase !== null && isOutcome(nutBase)) return nutBase;
  const washerBase = p.washer === undefined ? null : accessory(doc, p.washer, size.dash);
  if (washerBase !== null && isOutcome(washerBase)) return washerBase;
  const maxWasherGiven = p.maxWasherTotal !== undefined;
  const maxWasherIn = p.maxWasherTotal === undefined ? { value: 0.125, unit: 'in' } : p.maxWasherTotal;
  const maxWasherTicks = toTicks(maxWasherIn.value, maxWasherIn.unit, work) ?? 0;
  const pitchTicks = size.threadsPerInch === undefined ? null : toTicks(1 / size.threadsPerInch, 'in', work);
  const options = washerBase === null ? null : washerOptions(washerBase.size, work);
  const selection = selectBolt({
    stackTicks,
    gripTicks,
    gripMin,
    gripMax,
    threadLengthTicks,
    washerOptions: options,
    maxWasherTicks,
    nutHeightMaxTicks: nutBase === null ? null : dimensionTicks(nutBase.size, 'height', work),
    pitchTicks,
    nutGiven: nutBase !== null,
  });
  const part = partNumberOf(family, size, { gripDash: selection.gripDash }, codes);
  const nutPart = nutBase === null ? null : (nutBase.size.partNumber ?? partNumberOf(nutBase.family, nutBase.size, {}, codes).text);
  const washers: PlacedWasher[] =
    washerBase === null
      ? []
      : selection.washers.map((ticks) => ({
          partNumber: washerLabel(washerBase.family, washerBase.size, ticks, work),
          thicknessIn: ticksToInches(ticks, work),
        }));
  const washerTotalIn = ticksToInches(
    selection.washers.reduce((sum, value) => sum + value, 0),
    work,
  );
  const allWarnings = [...warnings, ...selection.warnings];
  const protrusion = selection.protrusion;
  const data = {
    ok: selection.ok,
    ...common,
    ...layout,
    partNumber: part.text,
    partNumberDefaultedCodes: part.defaulted,
    gripDash: selection.gripDash,
    gripIn: ticksToInches(selection.gripValueTicks, work),
    lengthIn: ticksToInches(selection.lengthTicks, work),
    gapIn: ticksToInches(selection.gapTicks, work),
    washerSide: p.washerSide ?? 'nut',
    washers,
    washersIn: washers.map((washer) => washer.thicknessIn),
    washerTotalIn,
    ...(nutBase === null || nutPart === null
      ? {}
      : {
          nut: {
            partNumber: nutPart,
            family: nutBase.family.id,
            heightMaxIn:
              dimensionTicks(nutBase.size, 'height', work) === null
                ? null
                : ticksToInches(dimensionTicks(nutBase.size, 'height', work) ?? 0, work),
          },
        }),
    protrusion: {
      status: protrusion.status,
      ...(protrusion.ticks === undefined ? {} : { protrusionIn: ticksToInches(protrusion.ticks, work) }),
      ...(protrusion.requiredTicks === undefined ? {} : { requiredIn: ticksToInches(protrusion.requiredTicks, work) }),
    },
    ...(protrusion.ticks === undefined ? {} : { protrusionIn: ticksToInches(protrusion.ticks, work) }),
    rules: {
      maxWasherTotal: maxWasherGiven
        ? { value: maxWasherIn.value, unit: maxWasherIn.unit, source: 'caller', defaulted: false }
        : { value: 0.125, unit: 'in', source: MAX_WASHER_SOURCE, defaulted: true },
      minProtrusion: { value: '1 thread pitch beyond nut max height', source: PROTRUSION_SOURCE, defaulted: true },
    },
    reasons: selection.reasons.map(withRemediation),
    warnings: allWarnings.map(withRemediation),
  };
  const first = selection.reasons[0];
  if (!selection.ok && first) return failOutcome(first.code, first.message, [family.id], data);
  const resolved: Resolved = {
    family,
    size,
    partNumber: part.text,
    mode,
    lengthIn: ticksToInches(selection.lengthTicks, work),
    representativeLength: false,
    washers,
    washerSide: p.washerSide ?? 'nut',
    nut: nutBase === null || nutPart === null ? null : { partNumber: nutPart, family: nutBase.family, size: nutBase.size },
    stackIn: stack.stackIn,
    measured: stack.measured,
  };
  return { ok: true, data, failure: null, resolved };
}
