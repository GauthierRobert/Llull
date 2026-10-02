/**
 * ifc: ifcStep.
 * @layer domain-aec
 */

import type { Vec2 } from '@core/model/types';
import { toCounterClockwise } from '@lib/polygon';

const GUID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** Deterministic 22-character IFC GlobalId derived from a seed (FNV-1a, 128 bits). */
export function ifcGuid(seed: string): string {
  const words = [0x811c9dc5, 0x01000193, 0x1b873593, 0xcc9e2d51];
  for (let index = 0; index < seed.length; index++) {
    const code = seed.charCodeAt(index);
    for (let word = 0; word < 4; word++) {
      words[word] = Math.imul((words[word] as number) ^ (code + word * 31), 0x01000193) >>> 0;
    }
  }
  let bits = '';
  for (const word of words) bits += word.toString(2).padStart(32, '0');
  let guid = GUID_ALPHABET[parseInt(bits.slice(0, 2), 2)] as string;
  for (let offset = 2; offset < 128; offset += 6) {
    guid += GUID_ALPHABET[parseInt(bits.slice(offset, offset + 6), 2)] as string;
  }
  return guid;
}

/** STEP string literal with IFC escapes (\X2\ for non-ASCII). */
export function ifcString(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 63;
    if (character === "'") out += "''";
    else if (character === '\\') out += '\\\\';
    else if (code >= 32 && code < 127) out += character;
    else if (code > 0xffff)
      out += `\\X4\\${code.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`;
    else out += `\\X2\\${code.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
  }
  return `'${out}'`;
}

/** STEP REAL: always carries a decimal point. */
export function ifcReal(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  if (rounded === 0) return '0.';
  const text = String(rounded);
  if (text.includes('e'))
    return rounded
      .toExponential()
      .replace('e', 'E')
      .replace(/^(-?\d+)E/, '$1.E');
  return text.includes('.') ? text : `${text}.`;
}

export class StepWriter {
  private readonly records: string[] = [];

  add(entity: string): string {
    this.records.push(entity);
    return `#${this.records.length}`;
  }

  get count(): number {
    return this.records.length;
  }

  data(): string {
    return this.records.map((record, index) => `#${index + 1}=${record};`).join('\n');
  }
}

export interface Context {
  readonly writer: StepWriter;
  /** GlobalId for a seed, salted with the building uid. */
  readonly guid: (seed: string) => string;
  readonly mm: (value: number) => number;
  readonly body: string;
  readonly zAxis: string;
  readonly xAxis: string;
}

export function point3(context: Context, x: number, y: number, z: number): string {
  return context.writer.add(`IFCCARTESIANPOINT((${ifcReal(x)},${ifcReal(y)},${ifcReal(z)}))`);
}

export function point2(context: Context, [x, y]: Vec2): string {
  return context.writer.add(`IFCCARTESIANPOINT((${ifcReal(x)},${ifcReal(y)}))`);
}

function axis3(context: Context, origin: string, angle = 0): string {
  const reference =
    angle === 0
      ? context.xAxis
      : context.writer.add(
          `IFCDIRECTION((${ifcReal(Math.cos(angle))},${ifcReal(Math.sin(angle))},0.))`,
        );
  return context.writer.add(`IFCAXIS2PLACEMENT3D(${origin},${context.zAxis},${reference})`);
}

export function placement(
  context: Context,
  relativeTo: string,
  x: number,
  y: number,
  z: number,
  angle = 0,
): string {
  return context.writer.add(
    `IFCLOCALPLACEMENT(${relativeTo},${axis3(context, point3(context, x, y, z), angle)})`,
  );
}

export function extrusion(
  context: Context,
  profile: string,
  depth: number,
  x = 0,
  y = 0,
  z = 0,
): string {
  return context.writer.add(
    `IFCEXTRUDEDAREASOLID(${profile},${axis3(context, point3(context, x, y, z))},${context.zAxis},${ifcReal(depth)})`,
  );
}

export function rectangleProfile(
  context: Context,
  center: Vec2,
  xDim: number,
  yDim: number,
): string {
  const position = context.writer.add(`IFCAXIS2PLACEMENT2D(${point2(context, center)},$)`);
  return context.writer.add(
    `IFCRECTANGLEPROFILEDEF(.AREA.,$,${position},${ifcReal(xDim)},${ifcReal(yDim)})`,
  );
}

export function polygonProfile(context: Context, points: ReadonlyArray<Vec2>): string {
  const refs = toCounterClockwise(points).map((point) => point2(context, point));
  const polyline = context.writer.add(`IFCPOLYLINE((${[...refs, refs[0]].join(',')}))`);
  return context.writer.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${polyline})`);
}

export function shape(context: Context, items: ReadonlyArray<string>): string {
  const representation = context.writer.add(
    `IFCSHAPEREPRESENTATION(${context.body},'Body','SweptSolid',(${items.join(',')}))`,
  );
  return context.writer.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${representation}))`);
}
