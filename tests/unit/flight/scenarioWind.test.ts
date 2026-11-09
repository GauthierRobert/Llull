/** define_flight_scenario wind.turbulence and set-point pivotDeg (13 FLT M4): defaults flagged, refusals, load validation. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { flightDocument } from '@dynamics/flight/document';
import { expectNoOp } from '../../helpers/expectNoOp';
import { airframe, G } from './flightFixture';

const doc = airframe(1, [0.01, 0.01, 0.01], [0, 0, -G]);
const define = (wind: Record<string, unknown>): ReturnType<typeof execute> =>
  execute(doc, 'define_flight_scenario', { body: 'frame', durationS: 5, id: 's', wind });

describe('scenario turbulence (FLT-M4)', () => {
  it('stores the Dryden field, lists the defaulted airspeed and scale lengths and says so in the summary', () => {
    const result = define({ turbulence: { sigmaMps: [1, 0.8, 0.5], seed: 42 } });
    const scenario = result.document.flight?.scenarios?.['s'];
    expect(scenario?.wind.turbulence).toEqual({ sigmaMps: [1, 0.8, 0.5], airspeedMps: 10, lengthScaleM: [200, 200, 200], seed: 42 });
    expect(scenario?.defaulted).toEqual(['turbulence.airspeedMps', 'turbulence.lengthScaleM', 'settleBandM']);
    expect(result.summary).toContain('Dryden turbulence σ [1, 0.8, 0.5] m/s seed 42');
    const given = define({ turbulence: { sigmaMps: [1, 1, 1], airspeedMps: 15, lengthScaleM: [50, 50, 50], seed: 1 } });
    expect(given.document.flight?.scenarios?.['s']?.defaulted).toEqual(['settleBandM']);
    expect(define({}).document.flight?.scenarios?.['s']?.wind.turbulence).toBeUndefined();
  });

  it('refuses a negative sigma, a non-positive scale length, an unrealisable time constant and a fractional seed', () => {
    expectNoOp(define({ turbulence: { sigmaMps: [-1, 0, 0], seed: 1 } }), doc, 'sigmaMps must be >= 0 and lengthScaleM > 0');
    expectNoOp(define({ turbulence: { sigmaMps: [1, 1, 1], lengthScaleM: [0, 10, 10], seed: 1 } }), doc, 'lengthScaleM > 0');
    expectNoOp(define({ turbulence: { sigmaMps: [1, 1, 1], airspeedMps: 1, lengthScaleM: [500, 10, 10], seed: 1 } }), doc, 'exceeds 120 s');
    expect(define({ turbulence: { sigmaMps: [1, 1, 1], seed: 1.5 } }).affected).toEqual([]);
    expect(define({ turbulence: { sigmaMps: [1, 1, 1], seed: 1.5 } }).summary).toContain('rejected');
  });

  it('load validation refuses a turbulence field outside its ranges, a time constant over 120 s and a reserved pivot key', () => {
    const made = JSON.parse(JSON.stringify(define({ turbulence: { sigmaMps: [1, 1, 1], seed: 3 } }).document)) as Record<string, unknown>;
    const scenario = (
      raw: Record<string, unknown>,
    ): { wind: { turbulence: Record<string, unknown> }; setpoints: Record<string, unknown>[] } =>
      (raw['flight'] as { scenarios: Record<string, ReturnType<typeof scenario>> }).scenarios['s'] as ReturnType<typeof scenario>;
    expect(flightDocument.validate(made)).toEqual([]);
    const slow = structuredClone(made);
    scenario(slow).wind.turbulence['airspeedMps'] = 0.1;
    expect(flightDocument.validate(slow).join()).toContain('exceeds 120 s');
    const negative = structuredClone(made);
    scenario(negative).wind.turbulence['sigmaMps'] = [-1, 1, 1];
    expect(flightDocument.validate(negative).length).toBeGreaterThan(0);
    const proto = JSON.parse(JSON.stringify(made).replace('"setpoints":[{', '"setpoints":[{"pivotDeg":{"__proto__":5},')) as Record<
      string,
      unknown
    >;
    expect(flightDocument.validate(proto)).toEqual(['flight.scenarios.s.setpoints.0.pivotDeg.__proto__: reserved key']);
  });
});
