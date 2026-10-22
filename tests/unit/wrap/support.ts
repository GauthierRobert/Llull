/** Shared setup of the 03 WRP command suites: a fake exact kernel, the bundled font, and document builders. */

import { afterEach, beforeEach } from 'vitest';
import { setFontProvider } from '@core/commands/fontPort';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type NurbsCurveEntity, type MeshSolidEntity } from '@core/model/types';
import { fakeWrapKernel, type FakeWrapOptions } from '../../helpers/fakeWrapKernel';
import { firaProvider } from './fixtures';

/** Installs the fake kernel (with `options`) and the bundled font around each test of the calling suite. */
export function useFakeKernel(options: FakeWrapOptions = {}): void {
  beforeEach(() => {
    setGeometryKernel(fakeWrapKernel(options));
    setFontProvider(firaProvider());
  });
  afterEach(() => {
    setGeometryKernel(null);
    setFontProvider(null);
  });
}

export interface Made {
  readonly doc: CadDocument;
  readonly id: string;
}

export function make(doc: CadDocument, name: string, params: Record<string, unknown>): Made {
  const result = execute(doc, name, params);
  if (result.rejected === true || result.affected.length === 0) throw new Error(`${name}: ${result.summary}`);
  return { doc: result.document, id: result.affected[0] as string };
}

export const emptyDoc = (): CadDocument => ({ ...createEmptyDocument(), units: 'mm' });

export const cylinder = (): Made => make(emptyDoc(), 'add_cylinder', { radius: 20, height: 40 });
export const cone = (): Made => make(emptyDoc(), 'add_cone', { radius: 20, height: 40 });
export const sphere = (): Made => make(emptyDoc(), 'add_sphere', { radius: 25 });
export const box = (): Made => make(emptyDoc(), 'add_box', { size: [60, 40, 10] });

export const rectangleOn = (doc: CadDocument, width: number, height: number, x = 0, y = 0): Made =>
  make(doc, 'draw_rectangle', { width, height, position: [x - width / 2, y - height / 2, 0] });

export const labelOn = (doc: CadDocument, content: string, extra: Record<string, unknown> = {}): Made =>
  make(doc, 'add_text', { content, position: [0, 0, 0], height: 10, anchor: 'center', font: 'Fira Sans', ...extra });

export const FACE = { faceNear: [20, 0, 0] };

export const curveOf = (doc: CadDocument, id: string): NurbsCurveEntity => doc.entities[id] as NurbsCurveEntity;
export const meshOf = (doc: CadDocument, id: string): MeshSolidEntity => doc.entities[id] as MeshSolidEntity;
