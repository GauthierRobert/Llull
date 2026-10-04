/**
 * DSTV NC1 text rendering and grouping of identical pieces into files.
 * @layer domain-aec
 * @pure
 */

import { fileSlug } from '../model';
import type { NcPiece } from './ncMemberPieces';

export interface NcFile {
  readonly name: string;
  readonly content: string;
  readonly mark: string;
  readonly kind: 'member' | 'plate';
  readonly profile: string;
  readonly quantity: number;
  readonly length: number;
  readonly sourceIds: string[];
}

function numberField(value: number): string {
  return `  ${value.toFixed(2).padStart(10)}`;
}

function textField(value: string): string {
  return `  ${value}`;
}

/** DSTV NC1 text for one piece (`quantity` pieces of the same mark). */
function renderPiece(
  piece: NcPiece,
  quantity: number,
  orderNumber: string,
  drawingNumber: string,
): string {
  const lines: string[] = [
    'ST',
    textField(orderNumber),
    textField(drawingNumber),
    textField('1'),
    textField(piece.mark),
    textField(piece.grade),
    textField(String(quantity)),
    textField(piece.profileName),
    textField(piece.code),
    ...[
      piece.length,
      piece.height,
      piece.flangeWidth,
      piece.flangeThickness,
      piece.webThickness,
      0,
      piece.massPerMetre,
      piece.paintPerMetre,
      ...piece.cuts,
    ].map(numberField),
    textField(''),
  ];
  if (piece.contour.length > 0) {
    lines.push('AK', ...piece.contour.map(([x, y]) => `  o${numberField(x)}${numberField(y)}`));
  }
  if (piece.holes.length > 0) {
    lines.push(
      'BO',
      ...piece.holes.map(
        (hole) =>
          `  ${hole.face}${numberField(hole.x)}${numberField(hole.y)}${numberField(hole.diameter)}`,
      ),
    );
  }
  lines.push('EN');
  return `${lines.join('\n')}\n`;
}

function pieceKey(piece: NcPiece): string {
  const holes = piece.holes.map((hole) => `${hole.face},${hole.x},${hole.y},${hole.diameter}`);
  return [
    piece.kind,
    piece.profileName,
    piece.grade,
    piece.length,
    piece.height,
    piece.cuts.join(','),
    holes.sort().join(';'),
  ].join('|');
}

export function buildFiles(
  pieces: ReadonlyArray<NcPiece>,
  orderNumber: string,
  drawingNumber: string,
): NcFile[] {
  const groups = new Map<string, NcPiece[]>();
  for (const piece of pieces) {
    const key = pieceKey(piece);
    groups.set(key, [...(groups.get(key) ?? []), piece]);
  }
  const usedNames = new Set<string>();
  const files: NcFile[] = [];
  for (const group of groups.values()) {
    const first = group[0] as NcPiece;
    const slug = fileSlug(first.mark, first.kind);
    let name = `${slug}.nc1`;
    for (let suffix = 2; usedNames.has(name); suffix++) name = `${slug}-${suffix}.nc1`;
    usedNames.add(name);
    files.push({
      name,
      content: renderPiece(first, group.length, orderNumber, drawingNumber),
      mark: first.mark,
      kind: first.kind,
      profile: first.profileName,
      quantity: group.length,
      length: first.length,
      sourceIds: group.flatMap((piece) => piece.sourceIds),
    });
  }
  return files;
}
