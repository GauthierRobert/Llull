import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { classifyAgainstSection, normalizeSectionPlanes, sectionBoxProblem } from '@core/geometry/sectionBox';
import type { SectionBox } from '@core/model/review';
import { validateDocumentValues } from '@core/commands/persistence/validation';
import { reviewProblems } from '@core/commands/persistence/reviewValidation';

/** SC-VIS-04 scene: a skid, a pipe crossing x = 1500 and a far box. */
function scene(): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [1000, 600, 800], position: [0, 0, 400] }).document;
  doc = execute(doc, 'add_cylinder', { radius: 100, height: 4000, position: [2000, 0, 600], axis: [1, 0, 0] }).document;
  doc = execute(doc, 'add_box', { size: [400, 400, 400], position: [6000, 0, 200] }).document;
  return doc;
}

const BOX = { name: 'skid box', min: [-1000, -1000, 0], max: [1500, 1000, 1500] };

describe('set_section_box / delete_section_box', () => {
  it('creates a box with a deterministic id, without a feature step, and can activate it', () => {
    const doc = scene();
    const result = execute(doc, 'set_section_box', { ...BOX, activate: true });
    expect(result.affected).toEqual(['sb-1']);
    expect(result.data).toEqual({ id: 'sb-1' });
    expect(result.document.review?.sectionBoxes['sb-1']).toEqual({
      id: 'sb-1',
      name: 'skid box',
      min: [-1000, -1000, 0],
      max: [1500, 1000, 1500],
    });
    expect(result.document.review?.activeSectionBoxId).toBe('sb-1');
    expect(result.document.featureHistory).toEqual(doc.featureHistory);
    expect(execute(doc, 'set_section_box', BOX).document.review?.activeSectionBoxId).toBeUndefined();
  });

  it('replaces a box by id and keeps rotationZ only when non-zero; stores planes with unit normals', () => {
    const doc = execute(scene(), 'set_section_box', BOX).document;
    const turned = execute(doc, 'set_section_box', { ...BOX, id: 'sb-1', rotationZ: Math.PI / 6 });
    expect(turned.document.review?.sectionBoxes['sb-1']?.rotationZ).toBeCloseTo(Math.PI / 6);
    expect(turned.document.review?.nextNumber).toBe(doc.review?.nextNumber);
    const flat = execute(turned.document, 'set_section_box', { ...BOX, id: 'sb-1', rotationZ: 0 });
    expect(flat.document.review?.sectionBoxes['sb-1']).not.toHaveProperty('rotationZ');
    const planes = execute(doc, 'set_section_box', { name: 'cut', planes: [{ normal: [0, 0, 5], offset: 10 }] });
    expect(planes.document.review?.sectionBoxes['sb-2']?.planes).toEqual([{ normal: [0, 0, 1], offset: 2 }]);
  });

  it('refuses invalid boxes with VIS_SECTION_BOX_INVALID and unknown ids with VIS_SECTION_BOX_NOT_FOUND', () => {
    const doc = scene();
    for (const params of [
      { name: 'a', min: [0, 0, 0], max: [0, 5, 5] },
      { name: 'b', min: [0, 0, 0] },
      { name: 'c' },
      { name: 'd', min: [0, 0, 0], max: [1, 1, 1], planes: [{ normal: [1, 0, 0], offset: 0 }] },
      { name: 'e', planes: [] },
      { name: 'f', planes: [{ normal: [0, 0, 0], offset: 0 }] },
      { name: 'g', planes: Array.from({ length: 7 }, () => ({ normal: [1, 0, 0], offset: 0 })) },
    ]) {
      const result = execute(doc, 'set_section_box', params);
      expect(result.error?.code, JSON.stringify(params)).toBe('VIS_SECTION_BOX_INVALID');
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
    expect(execute(doc, 'set_section_box', { ...BOX, id: 'sb-9' }).error?.code).toBe('VIS_SECTION_BOX_NOT_FOUND');
  });

  it('deletes a box, clears it when active, and refuses while a viewpoint uses it', () => {
    const doc = execute(scene(), 'set_section_box', { ...BOX, activate: true }).document;
    const deleted = execute(doc, 'delete_section_box', { id: 'sb-1' });
    expect(deleted.affected).toEqual(['sb-1']);
    expect(deleted.document.review?.sectionBoxes).toEqual({});
    expect(deleted.document.review?.activeSectionBoxId).toBeUndefined();
    expect(execute(doc, 'delete_section_box', { id: 'sb-7' }).error?.code).toBe('VIS_SECTION_BOX_NOT_FOUND');
    const used = execute(doc, 'save_viewpoint', { name: 'v', fromDocumentCamera: true, sectionBoxId: 'sb-1' }).document;
    const refused = execute(used, 'delete_section_box', { id: 'sb-1' });
    expect(refused.error).toMatchObject({ code: 'VIS_SECTION_BOX_IN_USE', ids: ['vp-2'] });
    expect(refused.document).toBe(used);
  });

  it('is pure', () => {
    const doc = execute(scene(), 'set_section_box', BOX).document;
    const before = JSON.stringify(doc);
    execute(doc, 'set_section_box', { ...BOX, id: 'sb-1', activate: true });
    execute(doc, 'delete_section_box', { id: 'sb-1' });
    execute(doc, 'section_box_report', { id: 'sb-1' });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('section_box_report (VC-VIS-12)', () => {
  it('classifies SC-VIS-04: skid inside, pipe crossing, far box outside', () => {
    const doc = execute(scene(), 'set_section_box', BOX).document;
    const result = execute(doc, 'section_box_report', { id: 'sb-1' });
    const ids = doc.order;
    expect(result.data).toMatchObject({
      inside: [ids[0]],
      crossing: [ids[1]],
      outside: [ids[2]],
      counts: { inside: 1, crossing: 1, outside: 1 },
      warnings: [],
    });
    expect(result.document).toBe(doc);
  });

  it('warns VIS_SECTION_BOX_EMPTY when nothing is inside or crossing, and refuses an unknown box', () => {
    const doc = execute(scene(), 'set_section_box', { name: 'void', min: [9000, 9000, 9000], max: [9100, 9100, 9100] }).document;
    const result = execute(doc, 'section_box_report', { id: 'sb-1' });
    expect((result.data as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toEqual(['VIS_SECTION_BOX_EMPTY']);
    expect(result.summary).toContain('(empty)');
    expect(execute(doc, 'section_box_report', { id: 'sb-4' }).error?.code).toBe('VIS_SECTION_BOX_NOT_FOUND');
  });
});

describe('classifyAgainstSection', () => {
  const bounds = (
    min: [number, number, number],
    max: [number, number, number],
  ): { min: [number, number, number]; max: [number, number, number] } => ({ min, max });
  const box: SectionBox = { id: 'sb-1', name: 'b', min: [0, 0, 0], max: [10, 10, 10] };

  it('is exact for axis-aligned boxes and counts touching as crossing', () => {
    expect(classifyAgainstSection(box, bounds([1, 1, 1], [9, 9, 9]))).toBe('inside');
    expect(classifyAgainstSection(box, bounds([0, 0, 0], [10, 10, 10]))).toBe('inside');
    expect(classifyAgainstSection(box, bounds([5, 5, 5], [11, 6, 6]))).toBe('crossing');
    expect(classifyAgainstSection(box, bounds([10, 0, 0], [12, 1, 1]))).toBe('crossing');
    expect(classifyAgainstSection(box, bounds([10.5, 0, 0], [12, 1, 1]))).toBe('outside');
    expect(classifyAgainstSection(box, bounds([-3, -3, -3], [-1, -1, -1]))).toBe('outside');
  });

  it('tests a rotated box in its own frame', () => {
    const turned: SectionBox = { ...box, rotationZ: Math.PI / 2, min: [0, -10, 0], max: [10, 10, 10] };
    // The box is 10 wide in its x and 20 in its y; turned 90 degrees about its centre (5, 0): it now spans x in [-5, 15] and y in [-5, 5].
    expect(classifyAgainstSection(turned, bounds([-4, -1, 1], [14, 1, 2]))).toBe('inside');
    expect(classifyAgainstSection(turned, bounds([1, 8, 1], [2, 9, 2]))).toBe('outside');
    expect(classifyAgainstSection(turned, bounds([1, 4, 1], [2, 9, 2]))).toBe('crossing');
  });

  it('classifies against half-space planes (normals point to the removed side)', () => {
    const cut: SectionBox = { id: 'sb-2', name: 'p', planes: [{ normal: [1, 0, 0], offset: 5 }] };
    expect(classifyAgainstSection(cut, bounds([0, 0, 0], [4, 1, 1]))).toBe('inside');
    expect(classifyAgainstSection(cut, bounds([4, 0, 0], [6, 1, 1]))).toBe('crossing');
    expect(classifyAgainstSection(cut, bounds([6, 0, 0], [7, 1, 1]))).toBe('outside');
    expect(classifyAgainstSection({ id: 'sb-3', name: 'empty' }, bounds([0, 0, 0], [1, 1, 1]))).toBe('crossing');
  });

  it('validates the two forms', () => {
    expect(sectionBoxProblem({ min: [0, 0, 0], max: [1, 1, 1] })).toBeNull();
    expect(sectionBoxProblem({ planes: normalizeSectionPlanes([{ normal: [0, 3, 4], offset: 5 }]) })).toBeNull();
    expect(normalizeSectionPlanes([{ normal: [0, 3, 4], offset: 5 }])[0]?.normal[1]).toBeCloseTo(0.6, 12);
    expect(sectionBoxProblem({ min: [0, 0, 0], max: [1, 1, Number.NaN] })).toMatch(/finite/);
    expect(sectionBoxProblem({ min: [0, 0, 0], max: [1, 1, 1], rotationZ: Number.NaN })).toMatch(/rotationZ/);
  });
});

describe('section boxes in the persisted review', () => {
  it('round-trips through JSON and validates; malformed boxes are reported', () => {
    let doc = execute(scene(), 'set_section_box', { ...BOX, activate: true }).document;
    doc = execute(doc, 'set_section_box', { name: 'cut', planes: [{ normal: [1, 0, 0], offset: 2 }] }).document;
    const raw = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    expect(validateDocumentValues(raw)).toEqual([]);
    expect(JSON.parse(JSON.stringify(doc.review))).toEqual(doc.review);
    const review = JSON.parse(JSON.stringify(doc.review)) as Record<string, unknown>;
    const withBox = (box: unknown): string[] => reviewProblems({ ...review, sectionBoxes: { 'sb-1': box } });
    expect(withBox({ id: 'sb-1', name: 'x', min: [0, 0, 0], max: [0, 1, 1] }).join()).toContain('min must be below max');
    expect(withBox({ id: 'sb-1', name: 1 }).join()).toContain('name must be a string');
    expect(withBox({ id: 'sb-1', name: 'x', planes: [{ normal: 'x', offset: 0 }] }).join()).toContain('planes must be');
    expect(withBox({ id: 'sb-1', name: 'x', min: 'x', max: [1, 1, 1] }).join()).toContain('min and max must be');
    expect(withBox({ id: 'sb-1', name: 'x', min: [0, 0, 0], max: [1, 1, 1], rotationZ: 'x' }).join()).toContain('rotationZ');
    expect(reviewProblems({ ...review, activeSectionBoxId: 'sb-9' }).join()).toContain('activeSectionBoxId');
  });
});
