import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence';
import { addPipeSupport } from '@aec/industrial/pipeSupports';
import { buildingErrors } from '@aec/validate';
import { beam, column, step, twoLevels } from './steelFixtures';
import { hangerDoc, shoeDoc, supportsOf } from './pipeSupportFixtures';

const SHOE_AT = { pipeId: 'pipe-1', at: [[3000, 2000, 3027.15]] };

describe('add_pipe_support registration', () => {
  it('is an industrial command with snake_case name, mutating (no annotations)', () => {
    expect(getCommand('add_pipe_support')?.name).toBe(addPipeSupport.name);
    expect(addPipeSupport.annotations).toBeUndefined();
  });

  it('is pure: the input document is untouched', () => {
    const doc = shoeDoc();
    const snapshot = JSON.stringify(doc);
    const result = execute(doc, 'add_pipe_support', SHOE_AT);
    expect(result.document).not.toBe(doc);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('shoe on a beam below the pipe', () => {
  it('snaps to the pipe, bears on the beam and builds a block under the pipe', () => {
    const result = execute(shoeDoc(), 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[3000, 2050, 3000]],
    });
    const [support] = supportsOf(result.document);
    expect(support).toMatchObject({
      id: 'pipeSupport-1',
      mark: 'PS1',
      pipeId: 'pipe-1',
      type: 'shoe',
      position: [3000, 2000, 3027.15],
      memberId: 'member-3',
      rodLength: 0,
      pedestalHeight: 0,
      levelId: 'level-1',
    });
    expect(result.affected).toEqual(['pipeSupport-1', 'pipeSupport-1:block']);
    expect(result.summary).toContain('Added 1 shoe(s) PS1 on pipe PL1, bearing on SB1');
    expect(result.summary).not.toContain('WARNING');
    const block = result.document.entities['pipeSupport-1:block'];
    expect(block?.kind).toBe('box');
    expect(block?.layerId).toBe('layer-P-SUPP');
    expect(result.document.order).toContain('pipeSupport-1:block');
    // block sits under the pipe underside (2970), 20 mm minimum thickness
    expect(block?.kind === 'box' ? block.size[2] : 0).toBe(20);
    expect(block?.position[2]).toBeCloseTo(2970 - 10, 6);
  });

  it('finds the nearest steel on the line selector too and keeps the pipe line in the summary data', () => {
    const result = execute(shoeDoc(), 'add_pipe_support', {
      line: 'L-1',
      at: [[3000, 2000, 3027.15]],
    });
    const data = result.data as { supports: Array<{ memberId: string }>; unattached: string[] };
    expect(data.supports[0]?.memberId).toBe('member-3');
    expect(data.unattached).toEqual([]);
  });

  it('uses the pedestal height when the steel is lower than the pipe underside', () => {
    let doc = twoLevels();
    doc = column(doc, 3000, 0);
    doc = column(doc, 3000, 4000);
    doc = beam(doc, [3000, 0], [3000, 4000]);
    doc = step(doc, 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 2000, 3227.15],
        [6000, 2000, 3227.15],
      ],
    });
    const result = execute(doc, 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[3000, 2000, 3227.15]],
      type: 'guide',
    });
    const [support] = supportsOf(result.document);
    expect(support?.pedestalHeight).toBeCloseTo(200, 6);
    const block = result.document.entities['pipeSupport-1:block'];
    expect(block?.kind === 'box' ? block.size[2] : 0).toBeCloseTo(200, 6);
    expect(
      Object.keys(result.document.entities).filter((id) => id.includes(':stop-')),
    ).toHaveLength(2);
  });

  it('builds a cap and side stops for an anchor', () => {
    const result = execute(shoeDoc(), 'add_pipe_support', { ...SHOE_AT, type: 'anchor' });
    const parts = Object.keys(result.document.entities).filter((id) =>
      id.startsWith('pipeSupport-1:'),
    );
    expect(parts.sort()).toEqual([
      'pipeSupport-1:block',
      'pipeSupport-1:cap',
      'pipeSupport-1:stop-left',
      'pipeSupport-1:stop-right',
    ]);
  });

  it('accepts an explicit memberId and refuses one that cannot carry the pipe', () => {
    const doc = shoeDoc();
    const ok = execute(doc, 'add_pipe_support', { ...SHOE_AT, memberId: 'member-3' });
    expect(supportsOf(ok.document)[0]?.memberId).toBe('member-3');
    const far = execute(doc, 'add_pipe_support', { ...SHOE_AT, memberId: 'member-1' });
    expect(far.document).toBe(doc);
    expect(far.summary).toContain('add_pipe_support failed: member SC1');
    expect(far.summary).toContain('in plan');
    expect(far.affected).toEqual([]);
    const missing = execute(doc, 'add_pipe_support', { ...SHOE_AT, memberId: 'member-99' });
    expect(missing.document).toBe(doc);
    expect(missing.summary).toContain("memberId 'member-99' is not a steel member");
  });

  it('sits on a column top within reach, else stays unattached', () => {
    let doc = twoLevels();
    doc = column(doc, 1000, 1000, 'HEB200', 2500);
    doc = step(doc, 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 1000, 2700],
        [3000, 1000, 2700],
      ],
    });
    const top = execute(doc, 'add_pipe_support', { pipeId: 'pipe-1', at: [[1000, 1000, 2700]] });
    const [support] = supportsOf(top.document);
    expect(support?.memberId).toBe('member-1');
    expect(support?.pedestalHeight).toBeCloseTo(2700 - 57.15 - 2500, 6);
    const short = execute(doc, 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[1000, 1000, 2700]],
      maxReach: 100,
    });
    expect(supportsOf(short.document)[0]?.memberId).toBeNull();
  });

  it('brackets off a column that spans the pipe elevation', () => {
    let doc = twoLevels();
    doc = column(doc, 1000, 1000);
    doc = step(doc, 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 1000, 2000],
        [3000, 1000, 2000],
      ],
    });
    const result = execute(doc, 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[1000, 1000, 2000]],
      type: 'anchor',
    });
    const [support] = supportsOf(result.document);
    expect(support).toMatchObject({ memberId: 'member-1', pedestalHeight: 0 });
    expect(result.summary).toContain('bearing on SC1');
  });
});

describe('hanger from a beam above the pipe', () => {
  it('stores the rod length from the pipe top to the beam underside and renders a rod', () => {
    const result = execute(hangerDoc(), 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[3000, 2000, 2000]],
      type: 'hanger',
    });
    const [support] = supportsOf(result.document);
    // beam IPE300: axis 2820, bottom 2670; pipe top 2000 + 57.15 -> rod 612.85
    expect(support?.rodLength).toBeCloseTo(2670 - 2057.15, 6);
    expect(support?.position).toEqual([3000, 2000, -1000]);
    expect(support?.levelId).toBe('level-2');
    expect(support?.memberId).toBe('member-3');
    const rod = result.document.entities['pipeSupport-1:rod'];
    expect(rod?.kind).toBe('cylinder');
    expect(rod?.kind === 'cylinder' ? rod.height : 0).toBeCloseTo(612.85, 6);
    expect(rod?.position[2]).toBeCloseTo(2057.15 + 612.85 / 2, 6);
    expect(rod?.kind === 'cylinder' ? rod.radius : 0).toBe(6);
    expect(result.document.entities['pipeSupport-1:clamp']).toBeDefined();
  });

  it('refuses a column as hanger steel and leaves a hanger with nothing above unattached', () => {
    const doc = hangerDoc();
    const column = execute(doc, 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[3000, 2000, 2000]],
      type: 'hanger',
      memberId: 'member-1',
    });
    expect(column.document).toBe(doc);
    expect(column.summary).toContain('is a column: a hanger needs steel above the pipe');
    const short = execute(doc, 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[3000, 2000, 2000]],
      type: 'hanger',
      maxReach: 500,
    });
    const [support] = supportsOf(short.document);
    expect(support?.memberId).toBeNull();
    expect(support?.rodLength).toBe(0);
    expect(short.summary).toContain('WARNING 1 unattached');
    expect(short.document.entities['pipeSupport-1:rod']).toBeUndefined();
    expect((short.data as { unattached: string[] }).unattached).toEqual(['pipeSupport-1']);
  });
});

describe('automatic spacing', () => {
  const longPipe = (): CadDocument =>
    step(twoLevels(), 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 0, 2000],
        [12000, 0, 2000],
      ],
    });

  it('puts a support near each free end and subdivides the stretches to at most the spacing', () => {
    const result = execute(longPipe(), 'add_pipe_support', { pipeId: 'pipe-1', spacing: 4000 });
    const positions = supportsOf(result.document).map((support) => support.position[0]);
    // offset = min(300, 4000/4) = 300; gap 300…11700 split in ceil(11400/4000) = 3 parts of 3800
    expect(positions).toEqual([300, 4100, 7900, 11700]);
    expect(supportsOf(result.document).every((support) => support.memberId === null)).toBe(true);
    expect(result.summary).toContain('WARNING 4 unattached');
  });

  it('places one support near each bend on its longer leg and none on a riser', () => {
    const doc = step(twoLevels(), 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 0, 2000],
        [3000, 0, 2000],
        [3000, 0, 4000],
      ],
    });
    const result = execute(doc, 'add_pipe_support', { pipeId: 'pipe-1', spacing: 6000 });
    const positions = supportsOf(result.document).map((support) => support.position);
    // free start: 300; bend at 3000, longer leg is the riser (2000 < 3000: before is longer) -> 2700;
    // free end on the riser is skipped
    expect(positions).toEqual([
      [300, 0, 2000],
      [2700, 0, 2000],
    ]);
  });

  it('keeps existing supports and adds only where the spacing is exceeded', () => {
    const first = execute(longPipe(), 'add_pipe_support', { pipeId: 'pipe-1', spacing: 4000 });
    const again = execute(first.document, 'add_pipe_support', { pipeId: 'pipe-1', spacing: 4000 });
    expect(again.document).toBe(first.document);
    expect(again.summary).toContain('no support could be placed');
    const finer = execute(first.document, 'add_pipe_support', { pipeId: 'pipe-1', spacing: 2000 });
    expect(supportsOf(finer.document).length).toBeGreaterThan(4);
    const marks = supportsOf(finer.document).map((support) => support.mark);
    expect(new Set(marks).size).toBe(marks.length);
  });

  it('skips the end carried by equipment', () => {
    let doc = longPipe();
    doc = step(doc, 'add_equipment', {
      name: 'Tank',
      location: [-500, 0],
      size: [2000, 2000, 3000],
      levelId: 'level-1',
    });
    const result = execute(doc, 'add_pipe_support', { pipeId: 'pipe-1', spacing: 5000 });
    const positions = supportsOf(result.document).map((support) => support.position[0]);
    // start carried: nozzle at 0; end support at 11700; 11700 split in ceil(11700/5000) = 3 parts of 3900
    expect(positions).toEqual([3900, 7800, 11700]);
  });
});

describe('line selector and failures', () => {
  it('serves every pipe of a line', () => {
    let doc = shoeDoc();
    doc = step(doc, 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      line: 'L-1',
      points: [
        [0, 2500, 3027.15],
        [6000, 2500, 3027.15],
      ],
    });
    const result = execute(doc, 'add_pipe_support', { line: ' L-1 ', at: [[3000, 2450, 3027.15]] });
    expect(supportsOf(result.document)[0]?.pipeId).toBe('pipe-2');
  });

  it.each([
    ['neither pipeId nor line', { at: [[0, 0, 0]] }, 'give exactly one of pipeId or line'],
    [
      'both pipeId and line',
      { pipeId: 'pipe-1', line: 'L-1', at: [[0, 0, 0]] },
      'exactly one of pipeId',
    ],
    [
      'neither at nor spacing',
      { pipeId: 'pipe-1' },
      'exactly one of at (list of points) or spacing',
    ],
    [
      'both at and spacing',
      { pipeId: 'pipe-1', at: [[0, 0, 0]], spacing: 1000 },
      'exactly one of at',
    ],
    ['spacing <= 0', { pipeId: 'pipe-1', spacing: 0 }, 'must be > 0'],
    ['negative maxReach', { ...SHOE_AT, maxReach: -1 }, 'must be > 0'],
    ['negative planTolerance', { ...SHOE_AT, planTolerance: -1 }, 'planTolerance >= 0'],
    ['unknown pipe', { pipeId: 'pipe-9', at: [[0, 0, 0]] }, "'pipe-9' is not a pipe element"],
    [
      'element that is not a pipe',
      { pipeId: 'member-1', at: [[0, 0, 0]] },
      'is not a pipe element',
    ],
    ['unknown line', { line: 'L-9', at: [[0, 0, 0]] }, "no pipe carries line 'L-9'"],
    [
      'point far from the pipe',
      { pipeId: 'pipe-1', at: [[3000, 3500, 3027.15]] },
      'from the pipe(s)',
    ],
    ['point that is not 3D', { pipeId: 'pipe-1', at: [[3000, 2000]] }, 'is not [x, y, z]'],
    ['empty point list', { pipeId: 'pipe-1', at: [] }, 'no support could be placed'],
  ])('is a no-op for %s', (_label, params, text) => {
    const doc = shoeDoc();
    const result = execute(doc, 'add_pipe_support', params);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain(text);
  });

  it('refuses a point on a riser and a second support at the same place', () => {
    const doc = step(twoLevels(), 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 0, 0],
        [0, 0, 3000],
      ],
    });
    const riser = execute(doc, 'add_pipe_support', { pipeId: 'pipe-1', at: [[0, 0, 1500]] });
    expect(riser.document).toBe(doc);
    expect(riser.summary).toContain('is on a riser');
    const placed = execute(shoeDoc(), 'add_pipe_support', SHOE_AT);
    const duplicate = execute(placed.document, 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[3050, 2000, 3027.15]],
    });
    expect(duplicate.document).toBe(placed.document);
    expect(duplicate.summary).toContain('a support is already there');
  });
});

describe('support as a building element', () => {
  const supported = (): CadDocument =>
    execute(shoeDoc(), 'add_pipe_support', { ...SHOE_AT }).document;

  it('is deleted with its pipe', () => {
    const result = execute(supported(), 'delete_building_element', { elementIds: ['pipe-1'] });
    expect(supportsOf(result.document)).toEqual([]);
    expect(result.summary).toContain('pipe-1, pipeSupport-1');
    expect(Object.keys(result.document.entities).some((id) => id.startsWith('pipeSupport'))).toBe(
      false,
    );
  });

  it('can be deleted alone', () => {
    const result = execute(supported(), 'delete_building_element', {
      elementIds: ['pipeSupport-1'],
    });
    expect(supportsOf(result.document)).toEqual([]);
    expect(result.document.building?.elements['pipe-1']).toBeDefined();
  });

  it('moves with its pipe and cannot be moved alone', () => {
    const doc = supported();
    const moved = execute(doc, 'move_building_element', {
      elementIds: ['pipe-1'],
      delta: [0, 100],
    });
    expect(supportsOf(moved.document)[0]?.position).toEqual([3000, 2100, 3027.15]);
    expect(moved.affected).toContain('pipeSupport-1');
    const alone = execute(doc, 'move_building_element', {
      elementIds: ['pipeSupport-1'],
      delta: [0, 100],
    });
    expect(alone.document).toBe(doc);
    expect(alone.summary).toContain('follow their host');
    const both = execute(doc, 'move_building_element', {
      elementIds: ['pipe-1', 'pipeSupport-1'],
      delta: [100, 0],
    });
    expect(supportsOf(both.document)[0]?.position).toEqual([3100, 2000, 3027.15]);
  });

  it('is guarded like other derived geometry', () => {
    const doc = supported();
    const result = execute(doc, 'move_entities', {
      ids: ['pipeSupport-1:block'],
      delta: [1, 0, 0],
    });
    expect(result.document).toBe(doc);
  });

  it('is copied with its pipe to another level, attached only to a copied member', () => {
    const doc = step(supported(), 'add_level', { name: 'Roof', elevation: 6000, height: 3000 });
    const copied = execute(doc, 'copy_level_elements', {
      sourceLevelId: 'level-1',
      targetLevelIds: ['level-3'],
      categories: ['pipe'],
    });
    const copies = supportsOf(copied.document).filter((support) => support.levelId === 'level-3');
    expect(copies).toHaveLength(1);
    expect(copies[0]?.memberId).toBeNull();
    expect(copies[0]?.mark).toBe('PS2');
    expect(copies[0]?.pipeId).not.toBe('pipe-1');
    expect(copies[0]?.pedestalHeight).toBe(0);
  });

  it('survives save and load, and a bad pipeId is rejected on load', () => {
    const doc = supported();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(supportsOf(loaded)).toEqual(supportsOf(doc));
    expect(loaded.entities['pipeSupport-1:block']).toBeDefined();
    const building = JSON.parse(JSON.stringify(doc.building));
    building.elements['pipeSupport-1'].pipeId = 'member-1';
    building.elements['pipeSupport-1'].type = 'bolt';
    building.elements['pipeSupport-1'].position = [1, 2];
    building.elements['pipeSupport-1'].memberId = 4;
    building.elements['pipeSupport-1'].rodLength = -1;
    const errors = buildingErrors(building);
    expect(errors.join('\n')).toContain("pipeId 'member-1' is not a pipe");
    expect(errors.join('\n')).toContain('type must be shoe, hanger, guide or anchor');
    expect(errors.join('\n')).toContain('position must be [x, y, z]');
    expect(errors.join('\n')).toContain('memberId must be a steel member id or null');
    expect(errors.join('\n')).toContain('rodLength must be >= 0');
  });
});

describe('deliverables', () => {
  const supported = (): CadDocument =>
    execute(hangerDoc(), 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[3000, 2000, 2000]],
      type: 'hanger',
    }).document;

  it('lists supports in the support schedule', () => {
    const doc = execute(shoeDoc(), 'add_pipe_support', { ...SHOE_AT }).document;
    const data = execute(doc, 'building_schedule', { kind: 'support' }).data as {
      columns: string[];
      rows: Array<Array<string | number>>;
      csv: string;
    };
    expect(data.columns.slice(0, 5)).toEqual(['Mark', 'Line', 'Pipe', 'Type', 'Bears on']);
    expect(data.rows).toEqual([
      ['PS1', 'L-1', 'PL1', 'shoe', 'SB1', 3000, 2000, 3027.2, '', 'Ground', 'attached'],
    ]);
    const hanger = execute(supported(), 'building_schedule', { kind: 'support' }).data as {
      rows: Array<Array<string | number>>;
    };
    expect(hanger.rows[0]?.slice(3)).toEqual([
      'hanger',
      'SB1',
      3000,
      2000,
      2000,
      612.9,
      'Floor',
      'attached',
    ]);
    const unattached = execute(shoeDoc(), 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[500, 2000, 3027.15]],
    });
    const row = (
      execute(unattached.document, 'building_schedule', { kind: 'support' }).data as {
        rows: Array<Array<string | number>>;
      }
    ).rows[0];
    expect(row?.[4]).toBe('');
    expect(row?.[10]).toBe('UNATTACHED');
  });

  it('counts supports and hanger rod length in the takeoff', () => {
    const lines = (
      execute(supported(), 'quantity_takeoff', {}).data as {
        lines: Array<{ key: string; quantity: number }>;
      }
    ).lines;
    expect(lines.find((line) => line.key === 'pipe-support.hanger.ea')?.quantity).toBe(1);
    expect(lines.find((line) => line.key === 'pipe-support.hanger-rod.m')?.quantity).toBeCloseTo(
      0.613,
      3,
    );
  });

  it('exports an IfcBuildingElementProxy PIPESUPPORT with a property set and stable GlobalIds', () => {
    const ifc = (doc: CadDocument): string =>
      (execute(doc, 'export_ifc', {}).data as { ifc: string }).ifc;
    const doc = supported();
    const text = ifc(doc);
    const proxy = text.split('\n').find((line) => line.includes("'pipeSupport-1'"));
    expect(proxy).toMatch(
      /^#\d+=IFCBUILDINGELEMENTPROXY\('[^']{22}',\$,'PS1','L-2 hanger','PIPESUPPORT',/,
    );
    expect(proxy).toContain('.ELEMENT.)');
    expect(text).toContain("'Pset_llullPipeSupport'");
    expect(text).toContain(
      "IFCPROPERTYSINGLEVALUE('SupportType','Shoe, hanger, guide or anchor',IFCLABEL('hanger'),$)",
    );
    expect(text).toContain(
      "IFCPROPERTYSINGLEVALUE('BearsOn','Mark of the steel member it bears on (empty = unattached)',IFCLABEL('SB1'),$)",
    );
    expect(text).toContain('IFCLENGTHMEASURE(612.85)');
    const guid = (text: string): string | undefined =>
      /IFCBUILDINGELEMENTPROXY\('([^']{22})'/.exec(text)?.[1];
    const more = execute(doc, 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[500, 2000, 2000]],
      type: 'hanger',
    }).document;
    expect(guid(ifc(more))).toBe(guid(text));
    expect(text.match(/IFCEXTRUDEDAREASOLID/g)?.length).toBeGreaterThan(0);
  });

  it('exports a shoe body and skips a support whose pipe is gone', () => {
    const doc = execute(shoeDoc(), 'add_pipe_support', { ...SHOE_AT, type: 'guide' }).document;
    const text = (execute(doc, 'export_ifc', {}).data as { ifc: string }).ifc;
    expect(text).toContain("'L-1 guide','PIPESUPPORT'");
    const building = doc.building;
    if (!building) throw new Error('no building');
    const elements = Object.fromEntries(
      Object.entries(building.elements).filter(([id]) => id !== 'pipe-1'),
    );
    const orphan = {
      ...doc,
      building: {
        ...building,
        elements,
        elementOrder: building.elementOrder.filter((id) => id !== 'pipe-1'),
      },
    };
    const orphanText = (execute(orphan, 'export_ifc', {}).data as { ifc: string }).ifc;
    expect(orphanText).not.toContain('PIPESUPPORT');
  });
});

describe('clash rules', () => {
  const clashes = (doc: CadDocument): Array<{ a: string; b: string }> =>
    (execute(doc, 'check_clashes', {}).data as { clashes: Array<{ a: string; b: string }> })
      .clashes;

  it('does not report a support touching its own pipe and the steel it bears on', () => {
    const shoe = execute(shoeDoc(), 'add_pipe_support', { ...SHOE_AT, type: 'anchor' }).document;
    expect(clashes(shoe)).toEqual([]);
    const hanger = execute(hangerDoc(), 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[3000, 2000, 2000]],
      type: 'hanger',
    }).document;
    expect(clashes(hanger)).toEqual([]);
  });

  it('reports a rod through another member, and another pipe through a shoe', () => {
    let doc = execute(hangerDoc(), 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[3000, 2000, 2000]],
      type: 'hanger',
    }).document;
    doc = step(doc, 'add_steel_member', {
      role: 'beam',
      profile: 'IPE200',
      start: [2000, 2000, -700],
      end: [4000, 2000, -700],
      levelId: 'level-2',
    });
    const found = clashes(doc).filter(
      (clash) => clash.a === 'pipeSupport-1' || clash.b === 'pipeSupport-1',
    );
    expect(found.length).toBeGreaterThan(0);
    let shoe = execute(shoeDoc(), 'add_pipe_support', { ...SHOE_AT }).document;
    shoe = step(shoe, 'add_pipe_run', {
      levelId: 'level-1',
      dn: 50,
      points: [
        [3000, 0, 2985],
        [3000, 4000, 2985],
      ],
    });
    expect(
      clashes(shoe).some((clash) => clash.a === 'pipeSupport-1' || clash.b === 'pipeSupport-1'),
    ).toBe(true);
  });

  it('does not clash two supports with each other', () => {
    let doc = execute(shoeDoc(), 'add_pipe_support', { ...SHOE_AT }).document;
    doc = execute(doc, 'add_pipe_support', {
      pipeId: 'pipe-1',
      at: [[3150, 2000, 3027.15]],
      type: 'guide',
    }).document;
    expect(
      clashes(doc).filter(
        (clash) => clash.a.startsWith('pipeSupport') && clash.b.startsWith('pipeSupport'),
      ),
    ).toEqual([]);
  });
});
