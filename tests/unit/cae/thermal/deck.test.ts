import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { buildDeckContext, type DeckSections } from '@cae/decks/context';
import { thermalMaterialCards, thermalSections } from '@cae/thermal/deck';
import { addBc, facesOn, must, thermalFixture, twoTetMesh, TWO_TETS, type ThermalFixture } from './fixtures';

const textOf = (sections: DeckSections): string => {
  if (!('text' in sections)) throw new Error(`${sections.code}: ${sections.message}`);
  return sections.text
    .replace(/inputHash=[0-9a-f]{64}/, 'inputHash=<hash>')
    .replace(/coefficientsSha256=[0-9a-f]{64}/g, 'coefficientsSha256=<sha>');
};

function sectionsOf(doc: CadDocument, fixture: ThermalFixture, mesh: FeMeshArtifact): DeckSections {
  const ctx = buildDeckContext(doc, fixture.analysisId, mesh);
  if (ctx === null) throw new Error('no context');
  return thermalSections(ctx);
}

function cardsOf(doc: CadDocument, fixture: ThermalFixture, mesh: FeMeshArtifact): DeckSections {
  const ctx = buildDeckContext(doc, fixture.analysisId, mesh);
  if (ctx === null) throw new Error('no context');
  return thermalMaterialCards(ctx, fixture.boxId);
}

const withDoc = (fixture: ThermalFixture, doc: CadDocument): ThermalFixture => ({ ...fixture, doc });
const source = { citation: 'test source' };

/** Steady mm case on the two-tet mesh: prescribed T, flux, generation, point flux, film and a probe. */
function steadyCase(): { fixture: ThermalFixture; mesh: FeMeshArtifact } {
  let fixture = thermalFixture({ units: 'mm', size: [2, 1, 1], k: 15 });
  const box = fixture.boxId;
  const t = addBc(fixture, {
    name: 'T',
    kind: 'temperature',
    value: 300,
    unit: 'K',
    target: { entityId: box, facesNear: [[0, 0.5, 0.5]] },
  });
  const q = addBc(withDoc(fixture, t.doc), {
    name: 'q',
    kind: 'surface_flux',
    value: 1000,
    unit: 'W/m^2',
    target: { entityId: box, facesNear: [[2, 0.5, 0.5]] },
  });
  const g = addBc(withDoc(fixture, q.doc), { name: 'g', kind: 'heat_generation', value: 1e6, unit: 'W/m^3', entityId: box });
  const c = addBc(withDoc(fixture, g.doc), {
    name: 'c',
    kind: 'concentrated_flux',
    value: 2,
    unit: 'W',
    target: { entityId: box, pointsNear: [[2, 1, 1]] },
  });
  const f = addBc(withDoc(fixture, c.doc), {
    name: 'f',
    kind: 'film',
    filmCoefficient: { value: 10, unit: 'W/(m^2*K)' },
    sinkTemperature: { value: 20, unit: 'degC' },
    source,
    target: { entityId: box, facesNear: [[1, 0, 0.5]] },
  });
  const probe = must(f.doc, 'add_result_probe', {
    analysisId: fixture.analysisId,
    name: 'p',
    point: [1, 0.5, 0.5],
    quantity: 'temperature',
  });
  fixture = withDoc(fixture, probe.document);
  const mesh = twoTetMesh(fixture, {
    nodeSets: { [`B_${t.id}`]: [1, 3, 4], [`B_${c.id}`]: [5], [`P_${probe.affected[0]}`]: [2] },
    faceSets: { [`B_${q.id}`]: facesOn(TWO_TETS, [2, 4, 5]), [`B_${f.id}`]: facesOn(TWO_TETS, [1, 2, 3]) },
  });
  return { fixture, mesh };
}

describe('thermal deck sections (golden text)', () => {
  it('writes the steady step: loads in the N-mm-t-s unit system, probe print, and conductivity under the open material', () => {
    const { fixture, mesh } = steadyCase();
    expect(textOf(cardsOf(fixture.doc, fixture, mesh))).toBe(
      '** k: model k_const (synthetic test fixture) coefficientsSha256=<sha> maxRelError=0 constant\n*CONDUCTIVITY\n15\n',
    );
    expect(textOf(sectionsOf(fixture.doc, fixture, mesh))).toBe(
      [
        '** llull thermal type=heat_steady scale=degC unitSystem=N-mm-t-s inputHash=<hash>',
        '*STEP, INC=200',
        '*HEAT TRANSFER, STEADY STATE',
        '1, 1',
        '** tb-10.1 T (temperature)',
        '*BOUNDARY',
        'B_tb_10_1, 11, 11, 26.85',
        '** tb-11.1 q (surface_flux)',
        '*DFLUX',
        '2, S4, 1',
        '** tb-12.1 g (heat_generation)',
        '*DFLUX',
        'P_box_2_1, BF, 1',
        '** tb-13.1 c (concentrated_flux)',
        '*CFLUX',
        'B_tb_13_1, 11, 2000',
        '** tb-14.1 f (film)',
        '*FILM',
        '1, F1, 20, 0.01',
        '*NODE FILE',
        'NT, RFL',
        '*EL FILE',
        'HFL',
        '*NODE PRINT, NSET=P_pr_15_1',
        'NT',
        '*END STEP',
        '',
      ].join('\n'),
    );
  });

  it('is byte-identical for identical inputs', () => {
    const { fixture, mesh } = steadyCase();
    expect(sectionsOf(fixture.doc, fixture, mesh)).toEqual(sectionsOf(fixture.doc, fixture, mesh));
  });

  it('writes the transient: radiation constants, time points, initial conditions, amplitude, T(T)-dependent tables, total power as W/m^3', () => {
    let fixture = thermalFixture({
      type: 'heat_transient',
      k: [
        [-150, 10],
        [0, 12],
        [200, 20],
        [500, 30],
      ],
      cp: 500,
      density: 8000,
    });
    const box = fixture.boxId;
    const amp = must(fixture.doc, 'define_amplitude', {
      analysisId: fixture.analysisId,
      name: 'sine',
      kind: 'sine',
      periodS: 8,
      sampleStepS: 1,
      durationS: 8,
    });
    fixture = withDoc(fixture, amp.document);
    for (const [command, params] of [
      ['set_initial_temperature', { value: 20, unit: 'degC' }],
      [
        'set_thermal_step',
        {
          endTimeS: 8,
          initialIncrementS: 0.5,
          maxIncrementS: 1,
          outputEveryS: 2,
          maxTemperatureChangePerIncrement: { value: 5, unit: 'K' },
        },
      ],
    ] as const)
      fixture = withDoc(fixture, must(fixture.doc, command, { analysisId: fixture.analysisId, ...params }).document);
    const t = addBc(fixture, {
      name: 'T',
      kind: 'temperature',
      value: 100,
      unit: 'degC',
      amplitude: 'sine',
      target: { entityId: box, facesNear: [[0, 0, 0]] },
    });
    const g = addBc(withDoc(fixture, t.doc), { name: 'gen', kind: 'heat_generation', value: 10, unit: 'W', mode: 'total', entityId: box });
    const r = addBc(withDoc(fixture, g.doc), {
      name: 'rad',
      kind: 'radiation',
      emissivity: 0.8,
      sinkTemperature: { value: 3, unit: 'K' },
      source,
      target: { entityId: box, facesNear: [[0, 0, 0]] },
    });
    fixture = withDoc(fixture, r.doc);
    const mesh = twoTetMesh(fixture, { nodeSets: { [`B_${t.id}`]: [1, 2, 3] }, faceSets: { [`B_${r.id}`]: facesOn(TWO_TETS, [1, 2, 3]) } });
    expect(textOf(cardsOf(fixture.doc, fixture, mesh))).toBe(
      [
        '** k: model k_table (synthetic test fixture) coefficientsSha256=<sha> maxRelError=0 range=-150..150 degC relTol=1e-3',
        '*CONDUCTIVITY',
        '10, -150',
        '12, 0',
        '18, 150',
        '** cp: model cp_const (synthetic test fixture) coefficientsSha256=<sha> maxRelError=0 constant',
        '*SPECIFIC HEAT',
        '500',
        '** density: model rho_const (synthetic test fixture) coefficientsSha256=<sha> maxRelError=0 constant',
        '*DENSITY',
        '8000',
        '',
      ].join('\n'),
    );
    expect(textOf(sectionsOf(fixture.doc, fixture, mesh))).toBe(
      [
        '** llull thermal type=heat_transient scale=degC unitSystem=N-m-kg-s inputHash=<hash>',
        '*PHYSICAL CONSTANTS, ABSOLUTE ZERO=-273.15, STEFAN BOLTZMANN=5.67037441918e-8',
        '*TIME POINTS, NAME=TP_OUT',
        '2, 4, 6, 8',
        '*INITIAL CONDITIONS, TYPE=TEMPERATURE',
        'NALL, 20',
        '*AMPLITUDE, NAME=AM_am_10_1',
        '0, 0, 1, 0.707106781187, 2, 1, 3, 0.707106781187',
        '4, 0, 5, -0.707106781187, 6, -1, 7, -0.707106781187',
        '8, 0',
        '*STEP, INC=10000',
        '*HEAT TRANSFER, DELTMX=5',
        '0.5, 8, 0.00008, 1',
        '** tb-13.1 T (temperature)',
        '*BOUNDARY, AMPLITUDE=AM_am_10_1',
        'B_tb_13_1, 11, 11, 100',
        '** tb-14.1 gen (heat_generation)',
        "** total 10 W over 0.5 m^3 of 'box-2.1' = 20 W/m^3",
        '*DFLUX',
        'P_box_2_1, BF, 20',
        '** tb-15.1 rad (radiation)',
        '*RADIATE',
        '1, R1, -270.15, 0.8',
        '*NODE FILE, TIME POINTS=TP_OUT',
        'NT, RFL',
        '*EL FILE, TIME POINTS=TP_OUT',
        'HFL',
        '*END STEP',
        '',
      ].join('\n'),
    );
  });

  it('writes fixed increments with DIRECT and FREQUENCY output, sigma in N-mm-t-s, absolute zero 0 on the K scale, and defaults the first increment', () => {
    let fixture = thermalFixture({ type: 'heat_transient', units: 'mm', scale: 'K' });
    for (const [command, params] of [
      ['set_initial_temperature', { value: 300, unit: 'K' }],
      ['set_thermal_step', { endTimeS: 10, initialIncrementS: 0.5, fixedIncrements: true, outputEveryS: 2 }],
    ] as const)
      fixture = withDoc(fixture, must(fixture.doc, command, { analysisId: fixture.analysisId, ...params }).document);
    const r = addBc(fixture, {
      name: 'rad',
      kind: 'radiation',
      emissivity: 1,
      sinkTemperature: { value: 3, unit: 'K' },
      source,
      target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] },
    });
    fixture = withDoc(fixture, r.doc);
    const mesh = twoTetMesh(fixture, { faceSets: { [`B_${r.id}`]: facesOn(TWO_TETS, [1, 2, 3]) } });
    const fixedText = textOf(sectionsOf(fixture.doc, fixture, mesh));
    expect(fixedText).toContain('*PHYSICAL CONSTANTS, ABSOLUTE ZERO=0, STEFAN BOLTZMANN=5.67037441918e-11\n');
    expect(fixedText).toContain('*STEP, INC=21\n*HEAT TRANSFER, DIRECT\n0.5, 10\n');
    expect(fixedText).toContain('*NODE FILE, FREQUENCY=4\nNT, RFL\n*EL FILE, FREQUENCY=4\nHFL\n');
    expect(fixedText).toContain('1, R1, 3, 1\n');
    expect(fixedText).not.toContain('TIME POINTS');
    const automatic = withDoc(
      fixture,
      must(fixture.doc, 'set_thermal_step', { analysisId: fixture.analysisId, endTimeS: 20, initialIncrementS: 1, fixedIncrements: false })
        .document,
    );
    const automaticText = textOf(sectionsOf(automatic.doc, automatic, mesh));
    expect(automaticText).toContain('*STEP, INC=10000\n*HEAT TRANSFER\n1, 20\n');
    expect(automaticText).toContain('*TIME POINTS, NAME=TP_OUT\n2, 4, 6, 8, 10, 12, 14, 16\n18, 20\n*INITIAL');
  });

  it('lists explicit output times, adds the end time to output intervals that do not divide it, and notes the defaulted increment', () => {
    let fixture = thermalFixture({ type: 'heat_transient' });
    fixture = withDoc(
      fixture,
      must(fixture.doc, 'set_initial_temperature', { analysisId: fixture.analysisId, value: 20, unit: 'degC' }).document,
    );
    const sink = addBc(fixture, {
      name: 'T',
      kind: 'temperature',
      value: 50,
      unit: 'degC',
      target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] },
    });
    fixture = withDoc(fixture, sink.doc);
    const mesh = twoTetMesh(fixture, { nodeSets: { [`B_${sink.id}`]: [1] } });
    const times = withDoc(
      fixture,
      must(fixture.doc, 'set_thermal_step', { analysisId: fixture.analysisId, endTimeS: 10, outputTimesS: [1, 2.5, 10] }).document,
    );
    expect(textOf(sectionsOf(times.doc, times, mesh))).toContain(
      '** initial increment defaulted to endTimeS/100 (llull deck rule)\n*STEP, INC=10000\n*HEAT TRANSFER\n0.1, 10\n',
    );
    expect(textOf(sectionsOf(times.doc, times, mesh))).toContain('*TIME POINTS, NAME=TP_OUT\n1, 2.5, 10\n');
    const every = withDoc(
      fixture,
      must(fixture.doc, 'set_thermal_step', { analysisId: fixture.analysisId, endTimeS: 10, outputEveryS: 4 }).document,
    );
    expect(textOf(sectionsOf(every.doc, every, mesh))).toContain('*TIME POINTS, NAME=TP_OUT\n4, 8, 10\n');
    const bounded = withDoc(
      fixture,
      must(fixture.doc, 'set_thermal_step', { analysisId: fixture.analysisId, endTimeS: 10, initialIncrementS: 1, minIncrementS: 0.1 })
        .document,
    );
    expect(textOf(sectionsOf(bounded.doc, bounded, mesh))).toContain('1, 10, 0.1, 1e30\n');
  });

  it('writes open and closed cavity radiation with R<f>CR and a negative absolute environment for the closed one', () => {
    let fixture = thermalFixture({ k: 15 });
    const box = fixture.boxId;
    const sink = addBc(fixture, {
      name: 'T',
      kind: 'temperature',
      value: 20,
      unit: 'degC',
      target: { entityId: box, facesNear: [[0, 0, 0]] },
    });
    fixture = withDoc(fixture, sink.doc);
    const faces = [
      { target: { entityId: box, facesNear: [[0, 0, 0]] }, emissivity: 0.9 },
      { target: { entityId: box, facesNear: [[1, 1, 1]] }, emissivity: 0.8 },
    ];
    const open = must(fixture.doc, 'add_cavity_radiation', {
      analysisId: fixture.analysisId,
      name: 'c1',
      environmentTemperature: { value: 300, unit: 'K' },
      faces,
    });
    const closed = must(open.document, 'add_cavity_radiation', { analysisId: fixture.analysisId, name: 'C2', faces });
    fixture = withDoc(fixture, closed.document);
    const [openId = '', closedId = ''] = [open.affected[0], closed.affected[0]];
    const mesh = twoTetMesh(fixture, {
      nodeSets: { [`B_${sink.id}`]: [1] },
      faceSets: { [`V_${openId}_0`]: [[1, 1]], [`V_${openId}_1`]: [[2, 3]], [`V_${closedId}_0`]: [[1, 1]], [`V_${closedId}_1`]: [[2, 3]] },
    });
    const text = textOf(sectionsOf(fixture.doc, fixture, mesh));
    expect(text).toContain('*PHYSICAL CONSTANTS, ABSOLUTE ZERO=-273.15, STEFAN BOLTZMANN=5.67037441918e-8\n');
    expect(text).toContain('*RADIATE, CAVITY=C1\n1, R1CR, 26.85, 0.9\n2, R3CR, 26.85, 0.8\n');
    expect(text).toContain('*RADIATE, CAVITY=C2\n1, R1CR, -274.15, 0.9\n2, R3CR, -274.15, 0.8\n');
    const missing = twoTetMesh(fixture, { nodeSets: { [`B_${sink.id}`]: [1] } });
    expect(sectionsOf(fixture.doc, fixture, missing)).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED', ids: [openId] });
  });

  it('writes a constant density from the document material when no density model exists, and flags unverified inputs in the cards', () => {
    const fixture = thermalFixture({ type: 'heat_transient', units: 'mm', density: null, basis: 'typical' });
    const mesh = twoTetMesh(fixture);
    const text = textOf(cardsOf(fixture.doc, fixture, mesh));
    expect(text).toContain('** k unverified: basis typical\n*CONDUCTIVITY\n15\n');
    expect(text).toContain('** density: Material.density of the document material maxRelError=0 constant\n*DENSITY\n8e-9\n');
  });
});

describe('thermal deck refusals', () => {
  it('refuses a steady case with no heat path, a transient without initial temperature or end time, and BCs outside the mesh', () => {
    let fixture = thermalFixture();
    const flux = addBc(fixture, {
      name: 'q',
      kind: 'surface_flux',
      value: 1,
      unit: 'W/m^2',
      target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] },
    });
    fixture = withDoc(fixture, flux.doc);
    const mesh = twoTetMesh(fixture);
    expect(sectionsOf(fixture.doc, fixture, mesh)).toMatchObject({ code: 'THM_NO_HEAT_PATH' });
    const sink = addBc(fixture, {
      name: 'T',
      kind: 'temperature',
      value: 1,
      unit: 'degC',
      target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] },
    });
    const withSink = withDoc(fixture, sink.doc);
    expect(sectionsOf(withSink.doc, withSink, twoTetMesh(withSink))).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED', ids: [flux.id] });
    const nodeless = twoTetMesh(withSink, { faceSets: { [`B_${flux.id}`]: [[1, 1]] } });
    expect(sectionsOf(withSink.doc, withSink, nodeless)).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED', ids: [sink.id] });
    const transient = thermalFixture({ type: 'heat_transient' });
    expect(sectionsOf(transient.doc, transient, twoTetMesh(transient))).toMatchObject({ code: 'THM_INITIAL_TEMPERATURE_MISSING' });
    const started = withDoc(
      transient,
      must(transient.doc, 'set_initial_temperature', { analysisId: transient.analysisId, value: 1, unit: 'degC' }).document,
    );
    expect(sectionsOf(started.doc, started, twoTetMesh(started))).toMatchObject({ code: 'THM_STEP_INVALID' });
  });

  it('refuses a body without k or cp/density, with the property codes of PHY-01 passed through', () => {
    const noK = thermalFixture({ k: null });
    expect(cardsOf(noK.doc, noK, twoTetMesh(noK))).toMatchObject({ code: 'THM_MATERIAL_NO_K', ids: expect.arrayContaining([noK.boxId]) });
    const noCp = thermalFixture({ type: 'heat_transient', cp: null });
    expect(cardsOf(noCp.doc, noCp, twoTetMesh(noCp))).toMatchObject({ code: 'THM_MATERIAL_NO_CP' });
    const noRho = thermalFixture({ type: 'heat_transient', density: null });
    const bare = { ...noRho.doc, materials: { steel: { ...noRho.doc.materials['steel']!, density: 0 } } };
    expect(cardsOf(bare, noRho, twoTetMesh(noRho))).toMatchObject({ code: 'THM_MATERIAL_NO_CP' });
    const noMaterial = thermalFixture({ noMaterial: true });
    expect(cardsOf(noMaterial.doc, noMaterial, twoTetMesh(noMaterial))).toMatchObject({ code: 'THM_MATERIAL_NO_K' });
    const narrow = thermalFixture({
      k: [
        [0, 10],
        [100, 20],
      ],
    });
    const hot = addBc(narrow, {
      name: 'T',
      kind: 'temperature',
      value: 400,
      unit: 'degC',
      target: { entityId: narrow.boxId, facesNear: [[0, 0, 0]] },
    });
    expect(cardsOf(hot.doc, narrow, twoTetMesh(narrow))).toMatchObject({ code: 'PROP_OUT_OF_RANGE' });
    const noCase = buildDeckContext(narrow.doc, narrow.analysisId, twoTetMesh(narrow));
    const staticCase = must(narrow.doc, 'create_analysis', { name: 's', analysisType: 'static' });
    const mechanical = buildDeckContext(staticCase.document, staticCase.affected[0] ?? '', twoTetMesh(narrow));
    expect(noCase).not.toBeNull();
    expect(mechanical && thermalSections(mechanical)).toMatchObject({ code: 'THM_CASE_TYPE' });
    expect(mechanical && thermalMaterialCards(mechanical, narrow.boxId)).toMatchObject({ code: 'THM_CASE_TYPE' });
  });

  it('writes a tied contact pair with gap conductance from the K_ face sets (constant and table) and refuses a missing set', () => {
    const fixture = thermalFixture();
    const second = must(fixture.doc, 'add_box', { size: [1, 1, 0.05], position: [0, 0, 0.05] });
    const otherId = second.affected[0] ?? '';
    const parted = must(second.document, 'set_part_idealization', { analysisId: fixture.analysisId, entityId: otherId });
    const sink = addBc(withDoc(fixture, parted.document), {
      name: 'T',
      kind: 'temperature',
      value: 1,
      unit: 'degC',
      target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] },
    });
    const contact = must(sink.doc, 'add_thermal_contact', {
      analysisId: fixture.analysisId,
      name: 'iface',
      master: { entityId: fixture.boxId, facesNear: [[0.5, 0.5, 0.05]] },
      slave: { entityId: otherId, facesNear: [[0.5, 0.5, 0.05]] },
      conductance: { value: 2000, unit: 'W/(m^2*K)' },
    });
    const id = contact.affected[0] ?? '';
    const mesh = twoTetMesh(fixture, {
      nodeSets: { [`B_${sink.id}`]: [1] },
      faceSets: { [`K_${id}_M`]: facesOn(TWO_TETS, [2, 4, 5]), [`K_${id}_S`]: facesOn(TWO_TETS, [1, 2, 3]) },
    });
    const text = textOf(sectionsOf(contact.document, fixture, mesh));
    const base = id.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    expect(text).toContain(
      [
        `** ${id} iface (tied thermal contact)`,
        `*SURFACE, NAME=KM_${base}, TYPE=ELEMENT`,
        '2, S4',
        `*SURFACE, NAME=KS_${base}, TYPE=ELEMENT`,
        '1, S1',
        `*SURFACE INTERACTION, NAME=KI_${base}`,
        '*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=TIED',
        '*GAP CONDUCTANCE',
        '2000, 0',
        `*CONTACT PAIR, INTERACTION=KI_${base}, TYPE=SURFACE TO SURFACE`,
        `KS_${base}, KM_${base}`,
        '*STEP, INC=200',
      ].join('\n'),
    );
    expect(text.indexOf('*CONTACT PAIR')).toBeLessThan(text.indexOf('*STEP'));
    const table = must(sink.doc, 'add_thermal_contact', {
      analysisId: fixture.analysisId,
      name: 'tab',
      master: { entityId: fixture.boxId, facesNear: [[0.5, 0.5, 0.05]] },
      slave: { entityId: otherId, facesNear: [[0.5, 0.5, 0.05]] },
      conductance: {
        points: [
          [1000, 0, 0],
          [4000, 10, 100],
        ],
      },
    });
    const tableId = table.affected[0] ?? '';
    const tableText = textOf(
      sectionsOf(
        table.document,
        fixture,
        twoTetMesh(fixture, {
          nodeSets: { [`B_${sink.id}`]: [1] },
          faceSets: { [`K_${tableId}_M`]: facesOn(TWO_TETS, [2, 4, 5]), [`K_${tableId}_S`]: facesOn(TWO_TETS, [1, 2, 3]) },
        }),
      ),
    );
    expect(tableText).toContain('*GAP CONDUCTANCE\n1000, 0, 0\n4000, 10000000, 100\n*CONTACT PAIR');
    expect(sectionsOf(contact.document, fixture, twoTetMesh(fixture, { nodeSets: { [`B_${sink.id}`]: [1] } }))).toMatchObject({
      code: 'FEA_TARGET_UNRESOLVED',
      ids: [id],
    });
  });
});
