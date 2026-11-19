/** Hostile-input table: load-time validation of the 13 FLT flight slice's power tables (batteries with Peukert, powertrains with an ESC map and a thermal motor). */
import { flightDocument } from '@dynamics/flight/document';
import type { CadDocument } from '@core/model/types';
import { quadDrone, step } from '../../unit/flight/flightFixture';
import { asText, type HostileReader } from './types';

type Raw = Record<string, unknown>;
const isRecordLike = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

let base: CadDocument | null = null;
/** The reference quad with one Peukert battery and one powertrain (ESC map, thermal datasheet), once. */
const powered = (): CadDocument => {
  if (base !== null) return base;
  let doc = step(quadDrone(), 'add_battery', {
    id: 'b',
    cellsSeries: 4,
    capacityMah: 5600,
    internalResistanceOhm: 0.04,
    peukertExponent: 1.05,
    peukertRatedHours: 1,
    source: 'hostile sample',
  }).doc;
  doc = step(doc, 'add_flight_powertrain', {
    id: 'p',
    battery: 'b',
    rotors: ['r1'],
    datasheet: {
      nominalVoltageV: 14.8,
      terminalResistanceOhm: 0.1,
      torqueConstantNmPerA: 0.01038,
      rotorInertiaKgM2: 1e-5,
      thermal: { rthWindingHousingKPerW: 5, rthHousingAmbientKPerW: 5, tauWindingS: 6, tauMotorS: 200, maxWindingC: 125 },
    },
    motorSource: 'hostile sample',
    escEfficiencyMap: {
      throttle: [0, 1],
      currentA: [0, 30],
      efficiency: [
        [0.8, 0.9],
        [0.9, 0.97],
      ],
    },
    motorAmbientC: 30,
  }).doc;
  base = doc;
  return doc;
};

/** `records` rotor + battery + powertrain triples on the quad's body, `tamper` applied to each battery and powertrain record. */
function flightPower(records: number, tamper?: (battery: Raw, powertrain: Raw) => void): string {
  const doc = JSON.parse(JSON.stringify(powered())) as {
    dynamics: Raw;
    flight: { rotors: Record<string, Raw>; batteries: Record<string, Raw>; powertrains: Record<string, Raw> };
  };
  const [rotor, battery, powertrain] = [doc.flight.rotors['r1'], doc.flight.batteries['b'], doc.flight.powertrains['p']];
  const rotors: Record<string, Raw> = {};
  const batteries: Record<string, Raw> = {};
  const powertrains: Record<string, Raw> = {};
  for (let k = 0; k < records; k++) {
    rotors[`r${k}`] = { ...rotor, id: `r${k}` };
    const pack: Raw = { ...battery, id: `b${k}` };
    const train: Raw = { ...powertrain, id: `p${k}`, batteryId: `b${k}`, rotorIds: [`r${k}`] };
    tamper?.(pack, train);
    batteries[`b${k}`] = pack;
    powertrains[`p${k}`] = train;
  }
  return JSON.stringify({ dynamics: doc.dynamics, flight: { rotors, bodyDrag: {}, batteries, powertrains } });
}

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return undefined;
    throw error;
  }
};

const map = (train: Raw): Raw => train['escEfficiencyMap'] as Raw;

export const FLIGHT_READERS: readonly HostileReader[] = [
  {
    name: 'dynamics: flight batteries and powertrains (load-time validation of a saved document, FLT-M3b fields)',
    covers: ['domain-dynamics/src/flight/powerDocument.ts:powerErrors', 'domain-dynamics/src/flight/powerDocument.ts:escMapProblem'],
    input: 'text',
    build: (records) => flightPower(records),
    read: (input) => {
      const raw = parsed(asText(input));
      return isRecordLike(raw) ? flightDocument.validate(raw) : null;
    },
    accepts: (result) => Array.isArray(result) && result.length === 0,
    maxRecords: 5000,
    extra: [
      { name: 'Peukert exponent below 1', input: () => flightPower(3, (pack) => void (pack['peukertExponent'] = 0.5)) },
      { name: 'Peukert exponent as a string', input: () => flightPower(3, (pack) => void (pack['peukertExponent'] = '1.1')) },
      { name: 'a rated time without an exponent', input: () => flightPower(3, (pack) => void delete pack['peukertExponent']) },
      { name: 'ESC map that is not an object', input: () => flightPower(3, (_, train) => void (train['escEfficiencyMap'] = 'abc')) },
      { name: 'ESC map throttle decreasing', input: () => flightPower(3, (_, train) => void (map(train)['throttle'] = [1, 0])) },
      {
        name: 'ESC map rows of the wrong length',
        input: () => flightPower(3, (_, train) => void (map(train)['efficiency'] = [[0.9], [0.9]])),
      },
      {
        name: 'ESC map row of nulls',
        input: () =>
          flightPower(
            3,
            (_, train) =>
              void (map(train)['efficiency'] = [
                [null, null],
                [0.9, 0.9],
              ]),
          ),
      },
      {
        name: 'ESC map efficiency above 1',
        input: () =>
          flightPower(
            3,
            (_, train) =>
              void (map(train)['efficiency'] = [
                [2, 2],
                [2, 2],
              ]),
          ),
      },
      {
        name: 'ESC map with 100000 throttle points',
        input: () => flightPower(1, (_, train) => void (map(train)['throttle'] = Array.from({ length: 100_000 }, (_, k) => k))),
      },
      { name: 'motor ambient far out of range', input: () => flightPower(3, (_, train) => void (train['motorAmbientC'] = 1e9)) },
      {
        name: 'motor ambient named after a prototype member',
        input: () => flightPower(3, (_, train) => void (train['motorAmbientC'] = '__proto__')),
      },
    ],
  },
];
