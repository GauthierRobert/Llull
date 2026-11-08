/** PHY-06 §5.1 contact deck cards (TR-CNT-02): surfaces, interactions, behaviour per formulation, *MODEL CHANGE, *CONTACT FILE. */
import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { caseOf, withCase } from '@cae/shared/access';
import { blocks, blocksMesh, must, pairParams, type Blocks } from './support';

function deckOf(b: Blocks, doc: CadDocument, pairIds: readonly string[]): string {
  const written = writeInp(doc, b.analysisId, blocksMesh(b, doc, pairIds));
  if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
  return written.text;
}

/** The deck lines from the first contact comment up to the first `*STEP`. */
const modelCards = (text: string): string => text.slice(text.indexOf('** contact pair'), text.indexOf('** step '));

const withPair = (extra: Record<string, unknown> = {}, b = blocks()): { b: Blocks; doc: CadDocument; pairId: string } => {
  const added = must(b.doc, 'add_contact_pair', pairParams(b, extra));
  return { b, doc: added.doc, pairId: added.affected[1] ?? '' };
};

describe('contact deck', () => {
  it('writes element-face surfaces, a linear interaction with friction, the pair with ADJUST, and CONTACT FILE in every step (golden)', () => {
    const { b, doc, pairId } = withPair({ friction: { mu: 0.2, stickSlope: 50000 }, adjust: { kind: 'clearance', value: 0.01 } });
    const text = deckOf(b, doc, [pairId]);
    expect(modelCards(text)).toBe(
      [
        `** contact pair ${pairId} stack`,
        '*SURFACE, NAME=CPS_1, TYPE=ELEMENT',
        '7, S1',
        '9, S1',
        '*SURFACE, NAME=CPM_1, TYPE=ELEMENT',
        '5, S3',
        '6, S3',
        '*SURFACE INTERACTION, NAME=CPI_1',
        '*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=LINEAR',
        '1000000',
        '*FRICTION',
        '0.2, 50000',
        '*CONTACT PAIR, INTERACTION=CPI_1, TYPE=SURFACE TO SURFACE, ADJUST=0.01',
        'CPS_1, CPM_1',
        '',
      ].join('\n'),
    );
    expect(text).toContain('PEEQ\n*CONTACT FILE, FREQUENCY=21\nCDIS, CSTR\n*END STEP');
    expect(text).not.toContain('*MODEL CHANGE');
  });

  it('omits *SURFACE BEHAVIOR for mortar + hard, writes HARD otherwise, SMALL SLIDING for node_to_surface, the tied stick slope and EXPONENTIAL', () => {
    const mortar = withPair({ formulation: 'mortar', behaviour: { kind: 'hard' } });
    const mortarCards = modelCards(deckOf(mortar.b, mortar.doc, [mortar.pairId]));
    expect(mortarCards).not.toContain('*SURFACE BEHAVIOR');
    expect(mortarCards).toContain('TYPE=MORTAR\n');
    const hard = withPair({ formulation: 'node_to_surface', behaviour: { kind: 'hard' }, smallSliding: true, friction: { mu: 0.3 } });
    const hardCards = modelCards(deckOf(hard.b, hard.doc, [hard.pairId]));
    expect(hardCards).toContain('*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=HARD\n*FRICTION\n0.3\n');
    expect(hardCards).toContain('TYPE=NODE TO SURFACE, SMALL SLIDING\n');
    const tied = withPair({ behaviour: { kind: 'tied', slope: 1e6, stickSlope: 5e4 } });
    expect(modelCards(deckOf(tied.b, tied.doc, [tied.pairId]))).toContain('PRESSURE-OVERCLOSURE=TIED\n1000000\n*FRICTION\n1, 50000\n');
    const expo = withPair({ behaviour: { kind: 'exponential', c0: 0.001, p0: 10 } });
    expect(modelCards(deckOf(expo.b, expo.doc, [expo.pairId]))).toContain('PRESSURE-OVERCLOSURE=EXPONENTIAL\n0.001, 10\n');
    const linear = withPair({ behaviour: { kind: 'linear', slope: 1e6, c0: 0.002 } });
    expect(modelCards(deckOf(linear.b, linear.doc, [linear.pairId]))).toContain('PRESSURE-OVERCLOSURE=LINEAR\n1000000, , 0.002\n');
  });

  it('switches a pair off and on with *MODEL CHANGE where activeSteps changes between steps', () => {
    const b = blocks();
    const second = must(b.doc, 'add_analysis_step', {
      analysisId: b.analysisId,
      name: 'more',
      multipliers: { LC1: 2 },
      control: { kind: 'load', initialIncrement: 0.1, minIncrement: 0.001, maxIncrement: 0.5, maxIncrements: 20 },
    });
    const third = must(second.doc, 'add_analysis_step', {
      analysisId: b.analysisId,
      name: 'last',
      multipliers: { LC1: 1 },
      control: { kind: 'load', initialIncrement: 0.1, minIncrement: 0.001, maxIncrement: 0.5, maxIncrements: 20 },
    });
    const later = must(third.doc, 'add_contact_pair', pairParams(b, { activeSteps: [second.affected[0], third.affected[0]] }));
    const text = deckOf(b, later.doc, [later.affected[1] ?? '']);
    const steps = text.split('*STEP').slice(1);
    expect(steps[0]).toContain('*MODEL CHANGE, TYPE=CONTACT PAIR, REMOVE\n');
    expect(steps[1]).toContain('*MODEL CHANGE, TYPE=CONTACT PAIR, ADD\n');
    expect(steps[2]).not.toContain('*MODEL CHANGE');
  });

  it('refuses a pair whose faces the mesh did not resolve, and an invalid stored pair, with the pair id', () => {
    const { b, doc, pairId } = withPair();
    const missing = writeInp(doc, b.analysisId, { ...blocksMesh(b, doc, [pairId]), faceSets: {} });
    expect(missing).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED', ids: [pairId] });
    const analysis = caseOf(doc, b.analysisId);
    const contact = analysis?.contact;
    if (analysis === undefined || contact === undefined) throw new Error('no contact');
    const pair = contact.pairs[pairId];
    if (pair === undefined) throw new Error('no pair');
    const broken = withCase(doc, {
      ...analysis,
      contact: {
        ...contact,
        formulation: 'mortar',
        pairs: { [pairId]: { ...pair, behaviour: { kind: 'tied', slope: 1, stickSlope: 1 } } },
      },
    });
    expect(writeInp(broken, b.analysisId, blocksMesh(b, broken, [pairId]))).toMatchObject({ code: 'CNT_BEHAVIOUR_FORMULATION_MISMATCH' });
    const stale = withCase(doc, { ...analysis, contact: { ...contact, pairs: { [pairId]: { ...pair, activeSteps: ['gone'] } } } });
    expect(writeInp(stale, b.analysisId, blocksMesh(b, stale, [pairId]))).toMatchObject({ code: 'CNT_STEP_UNKNOWN' });
  });

  it('names the deck cards by pair position, so ids that sanitise alike never collide', () => {
    const b = blocks();
    const one = must(b.doc, 'add_contact_pair', pairParams(b));
    const two = must(one.doc, 'add_contact_pair', pairParams(b, { name: 'second', formulation: undefined }));
    const analysis = caseOf(two.doc, b.analysisId);
    const contact = analysis?.contact;
    if (analysis === undefined || contact === undefined) throw new Error('no contact');
    const [first = '', second = ''] = contact.pairOrder;
    const clash = {
      'cp-1.1': { ...contact.pairs[first], id: 'cp-1.1' },
      'cp_1.1': { ...contact.pairs[second], id: 'cp_1.1' },
    } as typeof contact.pairs;
    const doc = withCase(two.doc, { ...analysis, contact: { ...contact, pairs: clash, pairOrder: ['cp-1.1', 'cp_1.1'] } });
    const mesh = blocksMesh(b, doc, ['cp-1.1', 'cp_1.1']);
    // only the face sets: the node sets of these ids would themselves collide (FEA_DECK_NAME_COLLISION), the surfaces must not
    const faceOnly = { ...mesh, nodeSets: Object.fromEntries(Object.entries(mesh.nodeSets).filter(([key]) => !key.startsWith('CP_'))) };
    const written = writeInp(doc, b.analysisId, faceOnly);
    const cards = modelCards('text' in written ? written.text : written.code);
    expect(cards).toContain('CPS_1, CPM_1\n');
    expect(cards).toContain('CPS_2, CPM_2\n');
    expect(cards.match(/\*SURFACE, NAME=/g)).toHaveLength(4);
  });

  it('writes no contact card for a nonlinear case without pairs', () => {
    const b = blocks();
    const text = deckOf(b, b.doc, []);
    expect(text).not.toContain('CONTACT');
  });
});
