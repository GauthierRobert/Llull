/** Load-time validation of `CadDocument.flight` (the dynamics plugin's `DocumentExtension`): a zod schema plus the cross-reference checks. */

import { z } from '@core/commands/schema';
import type { DocumentExtension } from '@core/plugins/plugin';
import { sliceSchemaErrors } from '@core/plugins/sliceSchema';
import { isRecord } from '@lib/isRecord';

const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const finite = z.number();
const nonNegative = z.number().min(0);
const vec3 = z.tuple([finite, finite, finite]);
const text = z.string().trim().min(1);

const coefficients = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('static'), thrustCoefficient: nonNegative, powerCoefficient: nonNegative, source: text }),
  z.strictObject({
    kind: z.literal('table'),
    points: z
      .array(z.tuple([finite, nonNegative, nonNegative]))
      .min(2)
      .max(200),
    source: text,
    grade: z.enum(['A', 'B', 'C']),
  }),
]);

const rotor = z.strictObject({
  id: text,
  bodyId: text,
  hub: vec3,
  axis: vec3,
  spin: z.enum(['cw', 'ccw']),
  rpm: z.number().min(0).max(200000),
  diameter: z.number().positive(),
  coefficients,
  airDensity: z.number().positive(),
  spinInertiaKgM2: nonNegative,
});

const bodyDrag = z.strictObject({
  bodyId: text,
  cdaM2: z.tuple([nonNegative, nonNegative, nonNegative]),
  airDensity: z.number().positive(),
});

const flightSchema = z.strictObject({ rotors: z.record(z.string(), rotor), bodyDrag: z.record(z.string(), bodyDrag) });

/** Moving rigid bodies of the raw document: id -> fixed. */
function bodiesOf(raw: Record<string, unknown>): ReadonlyMap<string, boolean> {
  const dynamics = raw['dynamics'];
  const bodies = isRecord(dynamics) && isRecord(dynamics['bodies']) ? dynamics['bodies'] : {};
  return new Map(Object.entries(bodies).map(([id, body]) => [id, isRecord(body) && body['fixed'] === true]));
}

/** Key, id and body checks the schema cannot express. */
function referenceErrors(slice: z.infer<typeof flightSchema>, bodies: ReadonlyMap<string, boolean>): string[] {
  const errors: string[] = [];
  const body = (at: string, id: string): void => {
    const fixed = bodies.get(id);
    if (fixed === undefined) errors.push(`${at}.bodyId: '${id}' is not a rigid body of dynamics.bodies`);
    else if (fixed) errors.push(`${at}.bodyId: '${id}' is fixed to the ground`);
  };
  for (const [key, entry] of Object.entries(slice.rotors)) {
    const at = `flight.rotors.${key}`;
    if (entry.id !== key) errors.push(`${at}.id must equal its key`);
    if (Math.hypot(...entry.axis) < 1e-12) errors.push(`${at}.axis must be non-zero`);
    const points = entry.coefficients.kind === 'table' ? entry.coefficients.points : [];
    if (points.some((point, i) => i > 0 && point[0] <= (points[i - 1]?.[0] ?? Infinity)))
      errors.push(`${at}.coefficients.points: J must strictly increase`);
    body(at, entry.bodyId);
  }
  for (const [key, entry] of Object.entries(slice.bodyDrag)) {
    const at = `flight.bodyDrag.${key}`;
    if (entry.bodyId !== key) errors.push(`${at}.bodyId must equal its key`);
    if (entry.cdaM2.every((value) => value === 0)) errors.push(`${at}.cdaM2 must have a component > 0`);
    body(at, entry.bodyId);
  }
  return errors;
}

/** `DocumentExtension` for `CadDocument.flight`: input data only (nothing is derived). */
export const flightDocument: DocumentExtension = {
  validate(raw) {
    const slice = raw['flight'];
    if (slice === undefined) return [];
    // zod rebuilds records by assignment, so an own "__proto__" key would vanish from the parsed copy: read the keys on the raw value
    const reserved = (['rotors', 'bodyDrag'] as const).flatMap((table) => {
      const records = isRecord(slice) ? slice[table] : undefined;
      return isRecord(records)
        ? Object.keys(records)
            .filter((key) => RESERVED_KEYS.has(key))
            .map((key) => `flight.${table}.${key}: reserved key`)
        : [];
    });
    if (reserved.length > 0) return reserved;
    const errors = sliceSchemaErrors(flightSchema, slice, 'flight');
    if (errors.length > 0) return errors;
    return referenceErrors(flightSchema.parse(slice), bodiesOf(raw));
  },
  derivedEntityIds: () => new Set(),
  restore: (raw) => raw,
};
