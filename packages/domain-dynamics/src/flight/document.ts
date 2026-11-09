/** Load-time validation of `CadDocument.flight` (the dynamics plugin's `DocumentExtension`): a zod schema plus the cross-reference checks. */

import { z } from '@core/commands/schema';
import type { DocumentExtension } from '@core/plugins/plugin';
import { sliceSchemaErrors } from '@core/plugins/sliceSchema';
import { isRecord } from '@lib/isRecord';
import { aeroErrors, aeroSurfaceSchema, pivotCommandsSchema, turbulenceSchema } from './aeroDocument';
import { batterySchema, powerErrors, powertrainSchema } from './powerDocument';

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

const positive = z.number().positive();
const nonNegativeVec3 = z.tuple([nonNegative, nonNegative, nonNegative]);
const pid = z.strictObject({ p: nonNegativeVec3, i: nonNegativeVec3, d: nonNegativeVec3 });

const controller = z.strictObject({
  id: text,
  bodyId: text,
  rotorIds: z.array(text).min(1).max(64),
  rateHz: z.number().min(1).max(5000),
  gains: z.strictObject({ position: nonNegativeVec3, velocity: pid, attitude: nonNegativeVec3, rate: pid }),
  limits: z.strictObject({
    maxTiltDeg: positive.max(80),
    maxHorizontalSpeedMps: positive,
    maxVerticalSpeedMps: positive,
    maxRateDegS: z.tuple([positive, positive, positive]),
  }),
  minRpm: nonNegative,
  maxRpm: positive.max(200000),
  motorTimeConstantS: nonNegative.max(2),
  mixer: z.array(z.tuple([finite, finite, finite, finite])).nullable(),
  defaulted: z.array(z.string()),
});

const scenario = z.strictObject({
  id: text,
  bodyId: text,
  controllerId: text.nullable(),
  durationS: positive.max(600),
  setpoints: z
    .array(z.strictObject({ t: nonNegative, position: vec3, yawDeg: finite, pivotDeg: pivotCommandsSchema }))
    .min(1)
    .max(1000),
  initialVelocity: vec3,
  initialAngularVelocity: vec3,
  wind: z.strictObject({
    steady: vec3,
    gusts: z.array(z.strictObject({ startS: nonNegative, durationS: positive, peak: vec3 })).max(100),
    turbulence: turbulenceSchema.optional(),
  }),
  settleBandM: positive,
  defaulted: z.array(z.string()),
});

const flightSchema = z.strictObject({
  rotors: z.record(z.string(), rotor),
  bodyDrag: z.record(z.string(), bodyDrag),
  controllers: z.record(z.string(), controller).optional(),
  scenarios: z.record(z.string(), scenario).optional(),
  batteries: z.record(z.string(), batterySchema).optional(),
  powertrains: z.record(z.string(), powertrainSchema).optional(),
  aeroSurfaces: z.record(z.string(), aeroSurfaceSchema).optional(),
});

/** Controller and scenario checks the schema cannot express (keys, rotors on the body, set-point order, the controller's body). */
function controlErrors(
  slice: z.infer<typeof flightSchema>,
  dynamicsIds: ReadonlySet<string>,
  body: (at: string, id: string) => void,
): string[] {
  const errors: string[] = [];
  const controllers = slice.controllers ?? {};
  const taken = (at: string, key: string): void => {
    if (dynamicsIds.has(key) || Object.hasOwn(slice.rotors, key)) errors.push(`${at}: id '${key}' is also a dynamics record or a rotor`);
  };
  for (const [key, entry] of Object.entries(controllers)) {
    const at = `flight.controllers.${key}`;
    if (entry.id !== key) errors.push(`${at}.id must equal its key`);
    taken(at, key);
    body(at, entry.bodyId);
    if (new Set(entry.rotorIds).size !== entry.rotorIds.length) errors.push(`${at}.rotorIds: a rotor is listed twice`);
    for (const rotorId of entry.rotorIds) {
      const rotor = Object.hasOwn(slice.rotors, rotorId) ? slice.rotors[rotorId] : undefined;
      if (rotor === undefined) errors.push(`${at}.rotorIds: '${rotorId}' is not a rotor`);
      else if (rotor.bodyId !== entry.bodyId) errors.push(`${at}.rotorIds: rotor '${rotorId}' is not on body '${entry.bodyId}'`);
    }
    if (!(entry.minRpm < entry.maxRpm)) errors.push(`${at}: minRpm must be below maxRpm`);
    if (entry.mixer !== null && entry.mixer.length !== entry.rotorIds.length) errors.push(`${at}.mixer: one row per rotor`);
  }
  for (const [key, entry] of Object.entries(slice.scenarios ?? {})) {
    const at = `flight.scenarios.${key}`;
    if (entry.id !== key) errors.push(`${at}.id must equal its key`);
    taken(at, key);
    if (Object.hasOwn(controllers, key)) errors.push(`${at}: id '${key}' is also a flight controller`);
    body(at, entry.bodyId);
    const flying =
      entry.controllerId === null ? undefined : Object.hasOwn(controllers, entry.controllerId) ? controllers[entry.controllerId] : null;
    if (flying === null) errors.push(`${at}.controllerId: '${entry.controllerId ?? ''}' is not a flight controller`);
    else if (flying !== undefined && flying.bodyId !== entry.bodyId) errors.push(`${at}.controllerId: it flies another body`);
    const times = entry.setpoints.map((setpoint) => setpoint.t);
    if (times[0] !== 0 || times.some((t, i) => i > 0 && t <= (times[i - 1] ?? Infinity)) || times.some((t) => t >= entry.durationS))
      errors.push(`${at}.setpoints: times must start at 0, strictly increase and stay below durationS`);
    if (entry.wind.gusts.some((gust) => gust.startS >= entry.durationS)) errors.push(`${at}.wind.gusts: a gust starts after the run`);
  }
  return errors;
}

/** Moving rigid bodies of the raw document: id -> fixed. */
function bodiesOf(raw: Record<string, unknown>): ReadonlyMap<string, boolean> {
  const dynamics = raw['dynamics'];
  const bodies = isRecord(dynamics) && isRecord(dynamics['bodies']) ? dynamics['bodies'] : {};
  return new Map(Object.entries(bodies).map(([id, body]) => [id, isRecord(body) && body['fixed'] === true]));
}

/** The id-keyed tables of `doc.dynamics` whose ids share the dynamics id space with rotors (as `dynamicsIdTaken`). */
const DYNAMICS_ID_TABLES = [
  'bodies',
  'joints',
  'transmissions',
  'motors',
  'propellers',
  'cylinders',
  'losses',
  'springs',
  'profiles',
  'loadSchedules',
  'referenceSeries',
] as const;

/** Ids of the raw document's dynamics records. */
function dynamicsIdsOf(raw: Record<string, unknown>): ReadonlySet<string> {
  const dynamics = raw['dynamics'];
  if (!isRecord(dynamics)) return new Set();
  return new Set(
    DYNAMICS_ID_TABLES.flatMap((table) => {
      const records = dynamics[table];
      return isRecord(records) ? Object.keys(records) : [];
    }),
  );
}

/** Key, id and body checks the schema cannot express. */
function referenceErrors(
  slice: z.infer<typeof flightSchema>,
  bodies: ReadonlyMap<string, boolean>,
  dynamicsIds: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  const body = (at: string, id: string): void => {
    const fixed = bodies.get(id);
    if (fixed === undefined) errors.push(`${at}.bodyId: '${id}' is not a rigid body of dynamics.bodies`);
    else if (fixed) errors.push(`${at}.bodyId: '${id}' is fixed to the ground`);
  };
  for (const [key, entry] of Object.entries(slice.rotors)) {
    const at = `flight.rotors.${key}`;
    if (entry.id !== key) errors.push(`${at}.id must equal its key`);
    if (dynamicsIds.has(key)) errors.push(`${at}: id '${key}' is also a doc.dynamics record (rotor ids share the dynamics id space)`);
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
  // the later checks report body problems through `body` into `errors`: spread it after them
  const later = [...controlErrors(slice, dynamicsIds, body), ...powerErrors(slice, dynamicsIds), ...aeroErrors(slice, dynamicsIds, body)];
  return [...errors, ...later];
}

/** `DocumentExtension` for `CadDocument.flight`: input data only (nothing is derived). */
export const flightDocument: DocumentExtension = {
  validate(raw) {
    const slice = raw['flight'];
    if (slice === undefined) return [];
    // zod rebuilds records by assignment, so an own "__proto__" key would vanish from the parsed copy: read the keys on the raw value
    const reserved = (['rotors', 'bodyDrag', 'controllers', 'scenarios', 'batteries', 'powertrains', 'aeroSurfaces'] as const).flatMap(
      (table) => {
        const records = isRecord(slice) ? slice[table] : undefined;
        return isRecord(records)
          ? Object.keys(records)
              .filter((key) => RESERVED_KEYS.has(key))
              .map((key) => `flight.${table}.${key}: reserved key`)
          : [];
      },
    );
    if (reserved.length > 0) return reserved;
    const errors = sliceSchemaErrors(flightSchema, slice, 'flight');
    if (errors.length > 0) return errors;
    return referenceErrors(flightSchema.parse(slice), bodiesOf(raw), dynamicsIdsOf(raw));
  },
  derivedEntityIds: () => new Set(),
  restore: (raw) => raw,
};
