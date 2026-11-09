/**
 * 14 FLL-M4: check_rotor_resonance. Oracle VC-FLL-04: the Euler-Bernoulli cantilever b 10 mm, h 8 mm, L 150 mm, E 2 GPa, rho 1270 kg/m^3 has
 * f1 = (1.8751^2 / 2 pi) sqrt(EI / (m' L^4)) = 72.078 Hz, so the 2P crossing is 60 f / 2 = 2162.34 rpm and the 1P crossing 4324.68 rpm;
 * f2 = f1 (4.6941 / 1.8751)^2 = 451.72 Hz. The modal results are a fixture in the layout CalculiX writes (eigenFixtures).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { bandMargin, crossingRpm, excitationHz, marginPct } from '@cae/flightLoads/campbellMath';
import { CAMPBELL_WIDTH, campbellSvg } from '@cae/flightLoads/campbellSvg';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { eigenCase, modalDat, type EigenCase } from './eigenFixtures';
import { mustRun } from './deckFixtures';

const F1 = 72.078;
const F2 = 451.72;
const ALL = ['r1', 'r2', 'r3', 'r4'];

/** The modal bar with its results recorded and a flight model on the bar entity: body `frame`, rotors r1 (rpm 3000) and r2 (rpm 0), controller `fc` on r1. */
function flightModal(frequencies: readonly number[] = [F1, F2]): { fixture: EigenCase; doc: CadDocument; analysisId: string } {
  const fixture = eigenCase({ type: 'modal', dat: modalDat(frequencies) });
  let doc = mustRun(fixture.recorded, 'add_rigid_body', {
    entityIds: [fixture.bar.boxId],
    id: 'frame',
    massKg: 1,
    inertiaKgM2: [0.01, 0.01, 0.01, 0, 0, 0],
  });
  const rotor = {
    body: 'frame',
    hub: [0, 0, 0],
    axis: [0, 0, 1],
    spin: 'ccw',
    diameter: 0.254,
    thrustCoefficient: 0.1,
    powerCoefficient: 0.05,
    source: 'test',
  };
  const quad: [string, number, number, 'cw' | 'ccw', number][] = [
    ['r1', 180, -180, 'ccw', 3000],
    ['r2', -180, 180, 'ccw', 0],
    ['r3', 180, 180, 'cw', 3000],
    ['r4', -180, -180, 'cw', 0],
  ];
  for (const [id, x, y, spin, rpm] of quad) doc = mustRun(doc, 'add_rotor', { ...rotor, id, hub: [x, y, 0], spin, rpm });
  return { fixture, doc, analysisId: fixture.bar.analysisId };
}

const check = (
  setup: { fixture: EigenCase; doc: CadDocument; analysisId: string },
  params: Record<string, unknown>,
): ReturnType<typeof execute> =>
  execute(setup.doc, 'check_rotor_resonance', { analysisId: setup.analysisId, ...params }, setup.fixture.ctx);

interface Data {
  rows: {
    rotorId: string;
    harmonic: number;
    label: string;
    mode: number;
    crossingRpm: number | null;
    minMarginPct: number | null;
    minMarginAtRpm: number | null;
    atOperating: { rpm: number; excitationHz: number; marginPct: number | null }[];
    status: string;
    reason: string | null;
  }[];
  rotors: {
    rotorId: string;
    bandRpm: number[] | null;
    bandSource: string;
    operatingRpm: number[];
    harmonics: number[];
    bladeCount: number | null;
  }[];
  unassessed: { rotorId: string }[];
  crossings: unknown[];
  status: string;
  reviewRequired: boolean;
  threshold: { pct: number; source: string } | null;
  svg: string | null;
  width: number | null;
}
const dataOf = (result: ReturnType<typeof execute>): Data => result.data as Data;
const rowOf = (data: Data, rotorId: string, harmonic: number, mode: number): Data['rows'][number] => {
  const found = data.rows.find((row) => row.rotorId === rotorId && row.harmonic === harmonic && row.mode === mode);
  if (found === undefined) throw new Error(`no row ${rotorId} ${harmonic}P mode ${mode}`);
  return found;
};

describe('Campbell arithmetic (VC-FLL-04 oracle)', () => {
  it('crossing speed is 60 f / k exactly: 2P of the 72.078 Hz mode is 2162.34 rpm, 1P 4324.68 rpm', () => {
    expect(crossingRpm(F1, 2)).toBe(2162.34);
    expect(crossingRpm(F1, 1)).toBe(4324.68);
    expect(crossingRpm(F1, 4)).toBe(1081.17);
  });

  it('margin on a hand example: 72.078 Hz against 2P at 3000 rpm (100 Hz) is 27.922 %', () => {
    expect(excitationHz(2, 3000)).toBe(100);
    expect(marginPct(F1, 2, 3000)).toBeCloseTo(27.922, 9);
    expect(marginPct(F1, 2, 0)).toBeNull();
  });

  it('band margin: 0 at an interior crossing, else at the nearer edge (2400 rpm: 80 Hz, 9.9025 %; 1500 rpm: 50 Hz, 44.156 %)', () => {
    expect(bandMargin(F1, 2, 2000, 2400)).toEqual({ crossingRpm: 2162.34, minMarginPct: 0, atRpm: 2162.34 });
    const above = bandMargin(F1, 2, 2400, 3000);
    expect(above.crossingRpm).toBeNull();
    expect(above.atRpm).toBe(2400);
    expect(above.minMarginPct).toBeCloseTo((7.922 / 80) * 100, 9);
    const below = bandMargin(F1, 2, 1000, 1500);
    expect(below.atRpm).toBe(1500);
    expect(below.minMarginPct).toBeCloseTo((22.078 / 50) * 100, 9);
  });
});

describe('check_rotor_resonance', () => {
  it('reports the 2P crossing of the first mode at 2162.34 rpm in the band, 0 % margin, and fails against a sourced requirement', () => {
    const setup = flightModal();
    const result = check(setup, {
      rotors: ['r1'],
      rpmBand: [2000, 2400],
      bladeCount: 2,
      marginThresholdPct: 10,
      marginSource: 'test requirement',
    });
    expect(result.rejected).not.toBe(true);
    expect(result.affected).toEqual([]);
    const data = dataOf(result);
    const row = rowOf(data, 'r1', 2, 1);
    expect(row.crossingRpm).toBeCloseTo(2162.34, 9);
    expect(row.minMarginPct).toBe(0);
    expect(row.status).toBe('fail');
    expect(data.status).toBe('fail');
    expect(data.reviewRequired).toBe(true);
    expect(data.threshold).toEqual({ pct: 10, source: 'test requirement' });
    expect(data.rotors[0]).toMatchObject({
      rotorId: 'r1',
      bandRpm: [2000, 2400],
      bandSource: 'rpmBand (caller)',
      bladeCount: 2,
      harmonics: [1, 2],
    });
    expect(rowOf(data, 'r1', 1, 1).crossingRpm).toBeNull();
    expect(result.summary).toContain('check_rotor_resonance: fail');
    expect(result.summary).toContain('2162.3 rpm');
  });

  it('margin at the operating speed (3000 rpm, from the rotor record) and a passing result against a requirement the band meets', () => {
    const setup = flightModal();
    const result = check(setup, {
      rotors: ['r1'],
      rpmBand: [2900, 3100],
      harmonics: [2],
      bladeCount: 2,
      marginThresholdPct: 5,
      marginSource: 'test requirement',
    });
    const data = dataOf(result);
    expect(data.rotors[0]?.operatingRpm).toEqual([3000]);
    const op = rowOf(data, 'r1', 2, 1).atOperating[0];
    expect(op?.excitationHz).toBe(100);
    expect(op?.marginPct).toBeCloseTo(27.922, 9);
    const row = rowOf(data, 'r1', 2, 1);
    expect(row.minMarginAtRpm).toBe(2900);
    expect(row.minMarginPct).toBeCloseTo((((2 * 2900) / 60 - F1) / ((2 * 2900) / 60)) * 100, 9);
    expect(data.rows.every((entry) => entry.status === 'pass')).toBe(true);
    expect(data.status).toBe('pass');
    expect(data.reviewRequired).toBe(false);
  });

  it('adds the blade-passing harmonic when the blade count is known: 3 blades give 3P, per-rotor counts override', () => {
    const setup = flightModal();
    const data = dataOf(check(setup, { rpmBand: [1000, 2400], rotors: ['r1', 'r2'], bladeCount: 3, bladeCounts: { r2: 4 } }));
    expect(data.rotors.map((rotor) => [rotor.rotorId, rotor.harmonics])).toEqual([
      ['r1', [1, 2, 3]],
      ['r2', [1, 2, 4]],
    ]);
    expect(rowOf(data, 'r1', 3, 1).label).toBe('3P (blade passing)');
    expect(rowOf(data, 'r1', 3, 1).crossingRpm).toBeCloseTo((60 * F1) / 3, 9);
  });

  it('without a margin requirement every row is unknown (never pass) but the crossings are reported; no default threshold exists', () => {
    const setup = flightModal();
    const result = check(setup, { rotors: ['r1'], rpmBand: [2000, 2400], bladeCount: 2 });
    const data = dataOf(result);
    expect(data.threshold).toBeNull();
    expect(data.rows.every((row) => row.status === 'unknown')).toBe(true);
    expect(rowOf(data, 'r1', 2, 1).reason).toContain('no margin requirement');
    expect(rowOf(data, 'r1', 2, 1).crossingRpm).toBeCloseTo(2162.34, 9);
    expect(data.crossings.length).toBeGreaterThan(0);
    expect(data.status).toBe('unknown');
    expect(data.reviewRequired).toBe(true);
    expect(result.summary).toContain('no margin requirement given');
  });

  it('a missing blade count leaves the rotor unassessed: the overall status is unknown even when every checked row passes', () => {
    const setup = flightModal();
    const data = dataOf(check(setup, { rotors: ['r1'], rpmBand: [2900, 3100], harmonics: [2], marginThresholdPct: 5, marginSource: 's' }));
    expect(data.rows.every((row) => row.status === 'pass')).toBe(true);
    expect(data.unassessed).toEqual([{ rotorId: 'r1', reason: expect.stringContaining('blade count') }]);
    expect(data.status).toBe('unknown');
  });

  it('a rotor with no rpm band (rpm 0, no controller) is unknown, not pass; the band comes from the rotor rpm or the controller otherwise', () => {
    const setup = flightModal();
    const data = dataOf(check(setup, { bladeCount: 2, marginThresholdPct: 5, marginSource: 's' }));
    expect(data.rotors.find((rotor) => rotor.rotorId === 'r2')).toMatchObject({ bandRpm: null, bandSource: 'none', operatingRpm: [] });
    expect(rowOf(data, 'r2', 1, 1)).toMatchObject({ status: 'unknown', crossingRpm: null, minMarginPct: null });
    expect(data.rotors.find((rotor) => rotor.rotorId === 'r1')).toMatchObject({
      bandRpm: [3000, 3000],
      bandSource: 'rotor rpm (constant)',
    });
    const flown = mustRun(setup.doc, 'add_flight_controller', { body: 'frame', id: 'fc', rotors: ALL, minRpm: 1000, maxRpm: 5000 });
    const withController = dataOf(
      execute(flown, 'check_rotor_resonance', { analysisId: setup.analysisId, rotors: ['r1'], bladeCount: 2 }, setup.fixture.ctx),
    );
    expect(withController.rotors[0]).toMatchObject({ bandRpm: [1000, 5000], bandSource: "controller 'fc' minRpm..maxRpm" });
    expect(rowOf(withController, 'r1', 2, 1).crossingRpm).toBeCloseTo(2162.34, 9);
    expect(rowOf(withController, 'r1', 1, 1).crossingRpm).toBeCloseTo(4324.68, 9);
  });

  it('operatingRpm overrides the rotor rpm; harmonics are caller-chosen', () => {
    const setup = flightModal();
    const data = dataOf(check(setup, { rotors: ['r1'], rpmBand: [1000, 5000], operatingRpm: [2000, 4000], harmonics: [1, 4] }));
    expect(data.rotors[0]).toMatchObject({ operatingRpm: [2000, 4000], harmonics: [1, 4] });
    expect(rowOf(data, 'r1', 1, 1).atOperating.map((point) => point.excitationHz)).toEqual([2000 / 60, 4000 / 60]);
  });

  it('data.svg is a deterministic Campbell diagram (rpm vs Hz, modes, rays, band) and plot false omits it', () => {
    const setup = flightModal();
    const params = { rotors: ['r1'], rpmBand: [2000, 2400], bladeCount: 2 };
    const first = dataOf(check(setup, params));
    expect(first.svg).toBe(dataOf(check(setup, params)).svg);
    expect(first.width).toBe(CAMPBELL_WIDTH);
    expect(first.svg?.startsWith('<svg')).toBe(true);
    expect(first.svg).toContain('rotor speed, rpm');
    expect(first.svg).toContain('frequency, Hz');
    expect(first.svg).toContain('mode 1 72.078 Hz');
    expect(first.svg).toContain('>2P<');
    expect(first.svg).toContain('r1 band');
    expect(first.svg).toContain('<circle');
    expect(first.svg?.endsWith('</svg>')).toBe(true);
    const bare = dataOf(check(setup, { ...params, plot: false }));
    expect(bare.svg).toBeNull();
    expect(bare.width).toBeNull();
  });

  it('is pure and read-only', () => {
    const setup = flightModal();
    expectPure(setup.doc, () => check(setup, { rpmBand: [2000, 2400], bladeCount: 2 }));
    expect(check(setup, { rpmBand: [2000, 2400] }).document).toBe(setup.doc);
  });
});

describe('check_rotor_resonance refusals (each leaves the document unchanged)', () => {
  const refused = (result: ReturnType<typeof execute>, doc: CadDocument, code: string): void => {
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe(code);
    expectNoOp(result, doc);
  };

  it('unknown analysis, non-modal analysis', () => {
    const setup = flightModal();
    refused(check({ ...setup, analysisId: 'nope' }, {}), setup.doc, 'FEA_ANALYSIS_NOT_FOUND');
    const staticCase = eigenCase({ type: 'modal' });
    const mixed = mustRun(staticCase.recorded, 'create_analysis', { name: 'S', analysisType: 'static' });
    const staticId = Object.keys(mixed.analysis?.cases ?? {}).find((id) => id !== staticCase.bar.analysisId) ?? '';
    refused(execute(mixed, 'check_rotor_resonance', { analysisId: staticId }, staticCase.ctx), mixed, 'FLL_NOT_MODAL');
  });

  it('a modal analysis without stored results (not solved) is refused, never read as zero modes', () => {
    const unsolved = eigenCase({ type: 'modal' });
    let doc = mustRun(unsolved.recorded, 'add_rigid_body', {
      entityIds: [unsolved.bar.boxId],
      id: 'frame',
      massKg: 1,
      inertiaKgM2: [0.01, 0.01, 0.01, 0, 0, 0],
    });
    doc = mustRun(doc, 'add_rotor', {
      body: 'frame',
      hub: [0, 0, 0],
      axis: [0, 0, 1],
      spin: 'ccw',
      rpm: 3000,
      diameter: 0.254,
      thrustCoefficient: 0.1,
      powerCoefficient: 0.05,
      source: 't',
    });
    refused(execute(doc, 'check_rotor_resonance', { analysisId: unsolved.bar.analysisId }, unsolved.ctx), doc, 'FLL_MODAL_UNAVAILABLE');
  });

  it('a stale solution (the set-up changed after the solve) is refused', () => {
    const setup = flightModal();
    const edited = mustRun(setup.doc, 'add_fea_load', {
      analysisId: setup.analysisId,
      name: 'late',
      kind: 'force',
      vector: [1, 0, 0],
      target: { entityId: setup.fixture.bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const result = execute(edited, 'check_rotor_resonance', { analysisId: setup.analysisId, rpmBand: [1, 2] }, setup.fixture.ctx);
    refused(result, edited, 'FLL_MODAL_UNAVAILABLE');
    expect(result.summary).toContain('stale');
  });

  it('only rigid-body modes in the results -> FLL_NO_MODES', () => {
    const setup = flightModal([0, 0.0005]);
    refused(check(setup, { rpmBand: [1, 2] }), setup.doc, 'FLL_NO_MODES');
  });

  it('no flight rotors, an unknown rotor, an unknown scenario', () => {
    const setup = flightModal();
    const bare = eigenCase({ type: 'modal', dat: modalDat([F1]) });
    refused(execute(bare.recorded, 'check_rotor_resonance', { analysisId: bare.bar.analysisId }, bare.ctx), bare.recorded, 'FLL_NO_ROTORS');
    refused(check(setup, { rotors: ['r9'] }), setup.doc, 'FLL_ROTOR_UNKNOWN');
    const result = check(setup, { scenario: 'ghost' });
    refused(result, setup.doc, 'FLL_NO_ROTORS');
    expect(result.summary).toContain("no flight scenario 'ghost'");
  });

  it('an inverted band, a threshold without its source (and the reverse)', () => {
    const setup = flightModal();
    refused(check(setup, { rpmBand: [3000, 2000] }), setup.doc, 'FLL_BAND_INVALID');
    refused(check(setup, { marginThresholdPct: 10 }), setup.doc, 'FLL_THRESHOLD_SOURCE');
    refused(check(setup, { marginSource: 'standard' }), setup.doc, 'FLL_THRESHOLD_SOURCE');
  });

  it('a trim that fails (scenario without a vehicle that can trim) is named FLL_TRIM_FAILED and refuses', () => {
    const setup = flightModal();
    const flown = mustRun(setup.doc, 'add_flight_controller', { body: 'frame', id: 'fc', rotors: ALL, maxRpm: 100 });
    const withScenario = mustRun(flown, 'define_flight_scenario', {
      body: 'frame',
      controller: 'fc',
      id: 's',
      durationS: 1,
      setpoints: [{ t: 0 }],
    });
    const result = execute(
      withScenario,
      'check_rotor_resonance',
      { analysisId: setup.analysisId, scenario: 's', airspeedMps: 0 },
      setup.fixture.ctx,
    );
    refused(result, withScenario, 'FLL_TRIM_FAILED');
    expect(result.summary).toContain('trim_flight');
  });

  it('invalid params (blade count 0, empty source) are rejected by the schema', () => {
    const setup = flightModal();
    expect(check(setup, { bladeCount: 0 }).rejected).toBe(true);
    expect(check(setup, { marginThresholdPct: 5, marginSource: '' }).rejected).toBe(true);
  });
});

describe('check_rotor_resonance operating speed from the flight trim (13 FLT trim_flight)', () => {
  it('scenario + airspeedMps takes the hover rpm of the rotor from trim_flight and reports the margin at it', () => {
    const setup = flightModal();
    let doc = mustRun(setup.doc, 'set_gravity', { gravity: [0, 0, -9.80665] });
    doc = mustRun(doc, 'add_flight_controller', { body: 'frame', id: 'fc', rotors: ALL, minRpm: 500, maxRpm: 12000 });
    doc = mustRun(doc, 'define_flight_scenario', { body: 'frame', controller: 'fc', id: 's', durationS: 1, setpoints: [{ t: 0 }] });
    const trim = execute(doc, 'trim_flight', { scenario: 's', airspeedMps: 0 });
    const controls = (trim.data as { controls: { id: string; value: number }[] }).controls;
    const hoverRpm = controls.find((control) => control.id === 'r1')?.value ?? 0;
    expect(hoverRpm).toBeGreaterThan(500);
    const result = execute(
      doc,
      'check_rotor_resonance',
      { analysisId: setup.analysisId, scenario: 's', airspeedMps: 0, harmonics: [2], bladeCount: 2 },
      setup.fixture.ctx,
    );
    const data = dataOf(result);
    expect(data.rotors[0]).toMatchObject({
      rotorId: 'r1',
      bandRpm: [500, 12000],
      operatingRpm: [hoverRpm],
      operatingSource: "trim_flight 's'",
    });
    expect(rowOf(data, 'r1', 2, 1).atOperating[0]?.marginPct).toBeCloseTo(
      (Math.abs(F1 - (2 * hoverRpm) / 60) / ((2 * hoverRpm) / 60)) * 100,
      9,
    );
    expect(rowOf(data, 'r1', 2, 1).crossingRpm).toBeCloseTo(2162.34, 9);
  });
});

describe('Campbell SVG edge cases', () => {
  const base = {
    modes: [{ mode: 1, frequencyHz: 40 }],
    harmonics: [],
    bands: [{ rotorId: 'a<b', lowRpm: 1000, highRpm: 2000 }],
    crossings: [],
  };

  it('without excitation rays the Hz axis follows the modes; titles and rotor ids are escaped; both modes are drawn', () => {
    const svg = campbellSvg({ ...base, modes: [...base.modes, { mode: 2, frequencyHz: 4000 }] }, 'T & <x>');
    expect(svg).toContain('T &amp; &lt;x&gt;');
    expect(svg).toContain('a&lt;b band');
    expect(svg).toContain('mode 1 40 Hz');
    expect(svg).toContain('mode 2 4000 Hz');
    expect(svg).not.toContain('stroke-dasharray');
  });

  it('a mode above the axis set by the rays is not drawn', () => {
    const svg = campbellSvg(
      { ...base, modes: [...base.modes, { mode: 2, frequencyHz: 4000 }], harmonics: [{ harmonic: 1, label: '1P' }] },
      'T',
    );
    expect(svg).toContain('mode 1');
    expect(svg).not.toContain('mode 2');
  });

  it('a crossing outside the axes is not marked; axis ends are rounded to 1, 2, 5 x 10^n', () => {
    const outside = campbellSvg({ ...base, harmonics: [{ harmonic: 1, label: '1P' }], crossings: [{ rpm: 99999, frequencyHz: 5 }] }, 'T');
    expect(outside).not.toContain('<circle');
    expect(campbellSvg({ ...base, bands: [{ rotorId: 'a', lowRpm: 0, highRpm: 1500 }] }, 'T')).toContain('>2000<');
    expect(campbellSvg({ ...base, bands: [{ rotorId: 'a', lowRpm: 0, highRpm: 0 }], modes: [] }, 'T')).toContain('<svg');
  });
});

describe('check_rotor_resonance review fixes', () => {
  it('an empty rotors list is rejected (no vacuous pass); document unchanged', () => {
    const setup = flightModal();
    const result = check(setup, { rotors: [], rpmBand: [2000, 2400] });
    expect(result.rejected).toBe(true);
    expectNoOp(result, setup.doc);
  });

  it('a controller with minRpm above maxRpm gives no band (falls back to the rotor rpm); a negative rotor rpm is its magnitude', () => {
    const setup = flightModal();
    let doc = mustRun(setup.doc, 'add_rotor', {
      body: 'frame',
      hub: [50, 50, 0],
      axis: [0, 0, 1],
      spin: 'cw',
      diameter: 0.254,
      thrustCoefficient: 0.1,
      powerCoefficient: 0.05,
      source: 'test',
      id: 'rneg',
      rpm: 3000,
    });
    const flight = Reflect.get(doc, 'flight') as unknown as {
      rotors: Record<string, Record<string, unknown>>;
      controllers?: Record<string, unknown>;
    };
    const rotor = flight.rotors['rneg'] ?? {};
    doc = {
      ...doc,
      flight: {
        ...flight,
        rotors: { ...flight.rotors, rneg: { ...rotor, rpm: -3000 } },
        controllers: { bad: { id: 'bad', rotorIds: ['rneg'], minRpm: 5000, maxRpm: 1000 } },
      },
    } as unknown as CadDocument;
    const data = dataOf(
      execute(doc, 'check_rotor_resonance', { analysisId: setup.analysisId, rotors: ['rneg'], bladeCount: 2 }, setup.fixture.ctx),
    );
    expect(data.rotors[0]).toMatchObject({ bandRpm: [3000, 3000], bandSource: 'rotor rpm (constant)', operatingRpm: [3000] });
    expect(rowOf(data, 'rneg', 2, 1).atOperating[0]?.excitationHz).toBe(100);
  });

  it('the SVG stays well-formed XML for a hostile rotor id (markup and control characters)', () => {
    const svg = campbellSvg(
      {
        modes: [{ mode: 1, frequencyHz: 40 }],
        harmonics: [],
        bands: [{ rotorId: 'a</text><script>x</script>\u0001\u0000b', lowRpm: 1, highRpm: 2 }],
        crossings: [],
      },
      'T\u001f',
    );
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('a&lt;/text&gt;&lt;script&gt;x&lt;/script&gt;b band');
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(svg)).toBe(false);
    const stack: string[] = [];
    for (const [, closing, name, selfClosing] of svg.matchAll(/<(\/?)([a-z]+)\b[^>]*?(\/?)>/g)) {
      if (selfClosing === '/') continue;
      if (closing === '/') expect(stack.pop()).toBe(name);
      else stack.push(name ?? '');
    }
    expect(stack).toEqual([]);
  });
});
