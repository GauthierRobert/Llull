import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { MomentConnectionElement } from '@core/model/building';
import { execute } from '@core/commands/registry';
import { solveFrame } from '@lib/frame2d';
import { framesOf } from '@aec/industrial/frames/frameModelFrames';
import { solveCombination } from '@aec/industrial/frames/frameModelSolve';
import { haunchedProfile, rafterPieces, HAUNCH_PIECES, type HaunchEnd } from '@aec/industrial/frames/haunchSection';
import { buildingConnectionSolids } from '@aec/industrial/connections/evaluateConnections';
import type { FrameModel } from '@aec/industrial/frames/frameModelTypes';
import type { CheckRow } from '@aec/industrial/frames/frameCheckSolve';
import { findProfile, sectionProperties } from '@aec/steel/profiles';
import { E_STEEL } from '@aec/industrial/steelDesign/steelDesign';
import { hall } from './hallFixtures';
import { expectNoOp } from '../../helpers/expectNoOp';

const LOADS = { deadLoad: 0.5, snowLoad: 0.8, windPressure: 0.6 };

const connectionsOf = (doc: CadDocument): MomentConnectionElement[] =>
  Object.values(doc.building!.elements).filter((element): element is MomentConnectionElement => element.category === 'connection');

const levelOf = (doc: CadDocument): string => doc.building!.levelOrder[0]!;
const framesFor = (doc: CadDocument): FrameModel[] => framesOf(doc, doc.building!, levelOf(doc), LOADS).frames;
const rows = (doc: CadDocument, tool = 'check_portal_frames'): CheckRow[] => (execute(doc, tool, LOADS).data as { rows: CheckRow[] }).rows;

describe('haunched section model', () => {
  it('is an I section of the rafter flanges and web with the haunch depth added', () => {
    const base = findProfile('IPE450')!;
    const haunched = haunchedProfile(base, base.h);
    expect(haunched.h).toBe(2 * base.h);
    expect([haunched.b, haunched.tw, haunched.tf]).toEqual([base.b, base.tw, base.tf]);
    const ratio = sectionProperties(haunched).inertia / sectionProperties(base).inertia;
    expect(ratio).toBeGreaterThan(4);
    expect(ratio).toBeLessThan(6);
    expect(haunchedProfile(base, 0)).toBe(base);
  });
  it('splits a rafter into stepped pieces that stiffen toward the haunched end and cover its length', () => {
    const base = findProfile('IPE450')!;
    const pieces = rafterPieces(base, 12000, [{ face: 200, length: 2400 }, null]);
    expect(pieces).toHaveLength(HAUNCH_PIECES + 1);
    expect(pieces[0]!.from).toBe(0);
    expect(pieces[pieces.length - 1]!.to).toBe(12000);
    pieces.slice(1).forEach((piece, index) => expect(piece.from).toBeCloseTo(pieces[index]!.to, 9));
    const heights = pieces.map((piece) => piece.stiffness.h);
    expect(heights).toEqual([...heights].sort((a, b) => b - a));
    expect(heights[0]).toBeGreaterThan(1.8 * base.h);
    expect(pieces[pieces.length - 1]!.stiffness).toBe(base);
    expect(pieces[pieces.length - 1]!.resistance).toBeNull();
    // Resistance is taken at the weaker (far) end of each piece: never deeper than the stiffness section.
    for (const piece of pieces.slice(0, HAUNCH_PIECES)) expect(piece.resistance!.h).toBeLessThanOrEqual(piece.stiffness.h);
    expect(rafterPieces(base, 12000, [null, null])).toHaveLength(1);
  });
  it('hand check, fixed-fixed beam under UDL: haunches raise the end moment above wL²/12 and cut the mid-span moment below wL²/24', () => {
    const base = findProfile('IPE450')!;
    const [length, load] = [12000, 10]; // mm, N/mm
    const solve = (ends: [HaunchEnd | null, HaunchEnd | null]): { endMoment: number; midMoment: number } => {
      const pieces = rafterPieces(base, length, ends);
      const nodes = [...pieces.map((piece) => piece.from), length].map((x) => ({
        x,
        y: 0,
        restraint: (x === 0 || x === length ? [true, true, true] : [false, false, false]) as [boolean, boolean, boolean],
      }));
      const result = solveFrame(
        nodes,
        pieces.map((piece, index) => {
          const section = sectionProperties(piece.stiffness);
          return { a: index, b: index + 1, E: E_STEEL, A: section.area, I: section.inertia, load: { qx: 0, qy: -load } };
        }),
      )!;
      const endMoment = Math.abs(result.members[0]!.moment[0]);
      return { endMoment, midMoment: (load * length ** 2) / 8 - endMoment };
    };
    const prismatic = solve([null, null]);
    expect(prismatic.endMoment).toBeCloseTo((load * length ** 2) / 12, -2);
    expect(prismatic.midMoment).toBeCloseTo((load * length ** 2) / 24, -2);
    const haunched = solve([
      { face: 200, length: 2400 },
      { face: 200, length: 2400 },
    ]);
    expect(haunched.endMoment).toBeGreaterThan(prismatic.endMoment * 1.05);
    expect(haunched.midMoment).toBeLessThan(prismatic.midMoment * 0.9);
    expect(haunched.endMoment).toBeLessThan((load * length ** 2) / 8);
  });
});

describe('add_portal_frame_building haunch option', () => {
  it('keeps the default eaves haunch of 10 % of the span and no apex haunch', () => {
    const connections = connectionsOf(hall());
    expect(connections.filter((c) => c.kind === 'eaves').every((c) => c.haunchLength === 2400)).toBe(true);
    expect(connections.filter((c) => c.kind === 'apex').every((c) => c.haunchLength === 0)).toBe(true);
    const explicit = connectionsOf(hall({ haunch: { eavesLength: 0.1 } }));
    expect(explicit.filter((c) => c.kind === 'eaves').every((c) => c.haunchLength === 2400)).toBe(true);
  });
  it('sizes eaves and apex haunches as fractions of the span and draws the apex haunch under both rafters', () => {
    const doc = hall({ haunch: { eavesLength: 0.15, apexLength: 0.05 } });
    const connections = connectionsOf(doc);
    expect(connections.filter((c) => c.kind === 'eaves').every((c) => c.haunchLength === 3600)).toBe(true);
    const apex = connections.filter((c) => c.kind === 'apex');
    expect(apex.length).toBeGreaterThan(0);
    expect(apex.every((c) => c.haunchLength === 1200)).toBe(true);
    const parts = (c: MomentConnectionElement): string[] => buildingConnectionSolids(doc, doc.building!, c)!.map((solid) => solid.part);
    expect(parts(apex[0]!)).toEqual(expect.arrayContaining(['haunch', 'haunch-flange', 'haunch-2', 'haunch-2-flange']));
    expect(parts(connections.find((c) => c.kind === 'eaves')!)).toEqual(expect.arrayContaining(['haunch', 'haunch-flange']));
    expect(parts(connections.find((c) => c.kind === 'eaves')!)).not.toContain('haunch-2');
  });
  it('eavesLength 0 builds the eaves without haunch', () => {
    const doc = hall({ haunch: { eavesLength: 0 } });
    const eaves = connectionsOf(doc).filter((c) => c.kind === 'eaves');
    expect(eaves.length).toBeGreaterThan(0);
    expect(eaves.every((c) => c.haunchLength === 0)).toBe(true);
    expect(buildingConnectionSolids(doc, doc.building!, eaves[0]!)!.map((s) => s.part)).not.toContain('haunch');
  });
  it('ignores the apex haunch of a monopitch roof (no apex)', () => {
    const doc = hall({ roofType: 'monopitch', haunch: { eavesLength: 0.1, apexLength: 0.1 } });
    expect(connectionsOf(doc).some((c) => c.kind === 'apex')).toBe(false);
    expect(connectionsOf(doc).every((c) => c.haunchLength === 2400)).toBe(true);
  });
  it('rejects fractions outside [0, 0.25] or a sum above 0.4 without changing the document', () => {
    for (const haunch of [
      { eavesLength: -0.1 },
      { eavesLength: 0.3 },
      { eavesLength: 0.1, apexLength: 0.3 },
      { eavesLength: 0.25, apexLength: 0.2 },
    ]) {
      const result = execute(hall(), 'add_portal_frame_building', { span: 24000, length: 30000, haunch });
      expect(result.summary).toMatch(/haunch/);
    }
    const empty = hall();
    expectNoOp(execute(empty, 'add_portal_frame_building', { haunch: { eavesLength: 0.5 } }), empty);
  });
});

describe('add_moment_connections apexHaunchLength', () => {
  it('adds haunches at the apex connections and rejects a non-positive length', () => {
    const doc = hall({ connections: false });
    const result = execute(doc, 'add_moment_connections', { apexHaunchLength: 1500 });
    const apex = connectionsOf(result.document).filter((c) => c.kind === 'apex');
    expect(apex.length).toBeGreaterThan(0);
    expect(apex.every((c) => c.haunchLength === 1500)).toBe(true);
    expect(execute(doc, 'add_moment_connections', { apexHaunchLength: 0 }).affected).toEqual([]);
  });
});

describe('frame analysis with haunches', () => {
  const plain = hall({ haunch: { eavesLength: 0 } });
  const haunched = hall();

  it('models each haunched rafter as stepped pieces with increasing inertia toward the eaves', () => {
    const frame = framesFor(haunched)[0]!;
    const pieces = frame.members.filter((member) => member.role === 'rafter');
    expect(framesFor(plain)[0]!.members.filter((member) => member.role === 'rafter')).toHaveLength(2);
    // Two rafters per frame plane, each (HAUNCH_PIECES haunch pieces + 1 plain piece).
    expect(pieces).toHaveLength(2 * (HAUNCH_PIECES + 1));
    const left = pieces.filter((piece) => frame.nodes[piece.geometry.a]!.x < 12000);
    const inertias = left.map((piece) => piece.geometry.I);
    expect(inertias).toEqual([...inertias].sort((a, b) => b - a));
    expect(left[0]!.geometry.I / left[left.length - 1]!.geometry.I).toBeGreaterThan(4);
    // The pieces carry the same load per length as the plain rafter and cover its full length.
    const total = pieces.reduce((sum, piece) => {
      const [a, b] = [frame.nodes[piece.geometry.a]!, frame.nodes[piece.geometry.b]!];
      return sum + Math.hypot(b.x - a.x, b.y - a.y);
    }, 0);
    expect(total).toBeCloseTo(2 * Math.hypot(12000, 12000 * Math.tan((6 * Math.PI) / 180)), 3);
  });
  it('steps both ends of a rafter with an apex haunch, including the partner rafter of the apex connection', () => {
    const doc = hall({ haunch: { eavesLength: 0.1, apexLength: 0.05 } });
    const frame = framesFor(doc)[0]!;
    const pieces = frame.members.filter((member) => member.role === 'rafter');
    // Per rafter: HAUNCH_PIECES at the eaves + 1 plain + HAUNCH_PIECES at the apex, the apex pieces from the ridge outward.
    expect(pieces).toHaveLength(2 * (2 * HAUNCH_PIECES + 1));
    const nearRidge = pieces.filter(
      (piece) => Math.abs(frame.nodes[piece.geometry.b]!.x - 12000) < 1 || Math.abs(frame.nodes[piece.geometry.a]!.x - 12000) < 1,
    );
    expect(nearRidge).toHaveLength(2);
    expect(nearRidge.every((piece) => piece.section !== undefined && piece.section.h < 2 * 450 + 1)).toBe(true);
    expect(Math.max(...nearRidge.map((piece) => piece.geometry.I))).toBeGreaterThan(3 * sectionProperties(findProfile('IPE450')!).inertia);
  });
  it('gives the expected direction of the effects: higher eaves moment, lower apex (mid-frame) moment, less sway', () => {
    const response = (doc: CadDocument): { eaves: number; apex: number; sway: number } => {
      const frame = framesFor(doc)[0]!;
      const vertical = solveCombination(frame, { G: 1.35, S: 1.5 })!;
      const wind = solveCombination(frame, { WL: 1 })!;
      const rafterIndexes = frame.members.flatMap((member, index) => (member.role === 'rafter' ? [index] : []));
      const eaves = Math.max(...rafterIndexes.map((index) => Math.abs(vertical.members[index]!.moment[0])));
      const atApex = rafterIndexes.find((index) => Math.abs(frame.nodes[frame.members[index]!.geometry.b]!.x - 12000) < 1)!;
      const sway = Math.abs(wind.displacements[frame.columnTops[0]!.node]![0]);
      return { eaves, apex: Math.abs(vertical.members[atApex]!.moment[1]), sway };
    };
    const [without, withHaunch] = [response(plain), response(haunched)];
    expect(withHaunch.eaves).toBeGreaterThan(without.eaves);
    expect(withHaunch.apex).toBeLessThan(without.apex);
    expect(withHaunch.sway).toBeLessThan(without.sway);
  });
  it('checks the haunched pieces with the built-up section and names it in the row', () => {
    const withHaunch = rows(haunched).filter((row) => row.kind === 'rafter');
    const without = rows(plain).filter((row) => row.kind === 'rafter');
    expect(withHaunch.length).toBeGreaterThan(0);
    expect(Math.max(...withHaunch.map((row) => row.utilisation))).toBeLessThan(Math.max(...without.map((row) => row.utilisation)));
    expect(without.every((row) => !row.check.includes('haunch'))).toBe(true);
  });
  it('reports the eaves connection moment from the haunch piece at the column', () => {
    const connection = rows(haunched).filter((row) => row.kind === 'connection');
    expect(connection.length).toBeGreaterThan(0);
    expect(connection.some((row) => row.moment > 0)).toBe(true);
  });
});

describe('design_portal_frames tries a haunch before up-sizing the rafters', () => {
  const loads = { snowLoad: 0.8, windPressure: 0.6, allowFixedBases: false };
  const rafterProfiles = (doc: CadDocument): string[] => [
    ...new Set(
      Object.values(doc.building!.elements).flatMap((element) =>
        element.category === 'member' && element.role === 'rafter' ? [element.profile] : [],
      ),
    ),
  ];

  it('lengthens the eaves haunch instead of a heavier rafter when the eaves moment governs', () => {
    const start = hall({ haunch: { eavesLength: 0 }, rafterProfile: 'IPE400', columnProfile: 'HEB500', columnBase: 'fixed' });
    const before = (execute(start, 'check_portal_frames', loads).data as { failures: string[] }).failures;
    expect(before.length).toBeGreaterThan(0);
    const result = execute(start, 'design_portal_frames', loads);
    expect(result.summary).toMatch(/eaves haunches 0 → 20 % of the rafter length \(12 connection\(s\)\)/);
    expect(rafterProfiles(result.document)).toEqual(['IPE400']);
    const eaves = connectionsOf(result.document).filter((c) => c.kind === 'eaves');
    expect(eaves.every((c) => Math.abs(c.haunchLength - 2400) < 1)).toBe(true);
    expect(result.affected).toEqual(expect.arrayContaining(eaves.map((c) => c.id)));
    expect((execute(result.document, 'check_portal_frames', loads).data as { failures: string[] }).failures).toEqual([]);
  });
  it('leaves the haunches alone when the frames already pass', () => {
    const start = hall({ rafterProfile: 'IPE450', columnProfile: 'HEB500', columnBase: 'fixed' });
    const before = connectionsOf(start).map((c) => c.haunchLength);
    const result = execute(start, 'design_portal_frames', loads);
    expect(result.summary).not.toMatch(/haunch/);
    expect(connectionsOf(result.document).map((c) => c.haunchLength)).toEqual(before);
  });
});
