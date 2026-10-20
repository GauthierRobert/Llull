/**
 * Checks of the CAx-IF structure of a file against the plies and surface recorded next to it: the structure itself (table, ordered sequences, plies with
 * material, rosette, orientation angle, thickness and ply pieces) and every composite validation property the practice names, recomputed.
 * A property the file lacks is not checkable; a structure that disagrees is red.
 */

import type { CompositePart, Ply } from '@core/model/composites';
import type { Vec3 } from '@core/model/types';
import { piecesOf } from '../geometry2d';
import { fromFlat } from '../surface';
import type { CompositeRecord, PlyRecord } from './interchange';
import { curveLength, orientationList, sequencesOf } from './standard';
import type { StandardRead } from './standardReader';
import { type ValidationFinding, type ValidationReport, checkValidation, compare, plyArea, worstBand } from './validation';
import type { EmbeddedValidation } from './reader';

type Rebuilt = readonly { readonly record: PlyRecord; readonly ply: Ply }[];

const find = (std: StandardRead, level: string, subject: string, name: string): number | string | undefined =>
  std.validation.find((entry) => entry.level === level && entry.subject === subject && entry.name === name)?.value;

export function standardFindings(
  record: Omit<CompositeRecord, 'validation'>,
  part: CompositePart,
  plies: Rebuilt,
  std: StandardRead,
): ValidationFinding[] {
  if (!std.present) return [];
  const ordered = [...plies].sort((a, b) => a.record.order - b.record.order);
  const sequences = sequencesOf(ordered.map((entry) => entry.record));
  const areas = new Map(ordered.map((entry) => [entry.record.name, plyArea(part, entry.ply)] as const));
  const curves = (entry: { record: PlyRecord; ply: Ply }): Vec3[][] =>
    piecesOf(entry.ply, part).map((piece) => piece.map((uv) => fromFlat(part.surface, uv)));
  const lengths = new Map(ordered.map((entry) => [entry.record.name, curveLength(curves(entry))] as const));
  const angles = ordered.map((entry) => entry.record.rosetteOrientation ?? entry.record.orientation);
  const orientationCount = new Set(orientationList(angles).split(' ')).size;
  const sum = (values: Iterable<number>): number => [...values].reduce((total, value) => total + value, 0);
  const totalArea = sum(areas.values());
  const findings: ValidationFinding[] = [];
  const structure = (what: string, subject: string, found: number | string | undefined, expected: number | string): void => {
    findings.push(compare(`structure: ${what}`, subject, found, expected));
  };

  structure('ply laminate table', record.name, std.table, record.name);
  structure(
    'ordered sequences',
    record.name,
    std.sequences.map((sequence) => sequence.name).join('|'),
    sequences.map((sequence) => sequence.name).join('|'),
  );
  structure('ordered plies', record.name, std.plies.map((ply) => ply.name).join('|'), ordered.map((entry) => entry.record.name).join('|'));
  for (const { record: ply } of ordered) {
    const found = std.plies.find((candidate) => candidate.name === ply.name);
    const rosette = ply.rosette || record.partRosette;
    structure('ply material', ply.name, found?.material, ply.material);
    structure('ply rosette', ply.name, found?.rosette, rosette);
    structure('ply orientation angle', ply.name, found?.angle, ply.rosetteOrientation ?? ply.orientation);
    structure('ply thickness', ply.name, found?.thickness, ply.thickness);
    structure('ply pieces', ply.name, found?.pieces.join('|'), ply.solids.join('|'));
  }

  const counts: [string, number][] = [
    ['number of sequences', sequences.length],
    ['number of plies', ordered.length],
    ['number of cores', 0],
    ['number of materials', record.materials.length],
    ['number of orientations', orientationCount],
  ];
  const part_ = std.validation.find((entry) => entry.level === 'part')?.subject ?? `${record.name} laminate`;
  for (const [name, value] of [
    ['number of tables', 1] as [string, number],
    ...counts,
    ['number of rosettes', record.rosettes.length] as [string, number],
  ])
    findings.push(compare(name, part_, find(std, 'part', part_, name), value));
  findings.push(compare('total ply surface area', part_, find(std, 'part', part_, 'total ply surface area'), totalArea));
  findings.push(
    compare(
      'ordered list of orientation values',
      part_,
      find(std, 'part', part_, 'ordered list of orientation values'),
      orientationList(angles),
    ),
  );
  for (const [name, value] of counts) findings.push(compare(name, `${record.name} (table)`, find(std, 'table', record.name, name), value));
  findings.push(
    compare('total ply surface area', `${record.name} (table)`, find(std, 'table', record.name, 'total ply surface area'), totalArea),
  );
  findings.push(
    compare(
      'ordered sequences per laminate table',
      record.name,
      find(std, 'table', record.name, 'ordered sequences per laminate table'),
      sequences.map((sequence) => sequence.name).join('|'),
    ),
  );
  for (const sequence of sequences)
    findings.push(
      compare(
        'number of plies',
        `${sequence.name} (sequence)`,
        find(std, 'sequence', sequence.name, 'number of plies'),
        sequence.plies.length,
      ),
    );
  for (const { record: ply } of ordered) {
    findings.push(
      compare('curve length measure', ply.name, find(std, 'ply', ply.name, 'curve length measure'), lengths.get(ply.name) as number),
    );
    if (ply.solids.length > 0)
      findings.push(
        compare('number of ply pieces per ply', ply.name, find(std, 'ply', ply.name, 'number of ply pieces per ply'), ply.solids.length),
      );
  }
  for (const rosette of record.rosettes) {
    const users = ordered.filter((entry) => (entry.record.rosette || record.partRosette) === rosette.name);
    findings.push(
      compare('number of plies', `${rosette.name} (rosette)`, find(std, 'rosette', rosette.name, 'number of plies'), users.length),
    );
    findings.push(
      compare(
        'total boundary curve length',
        `${rosette.name} (rosette)`,
        find(std, 'rosette', rosette.name, 'total boundary curve length'),
        sum(users.map((entry) => lengths.get(entry.record.name) as number)),
      ),
    );
  }
  for (const material of record.materials) {
    const area = sum(
      ordered.filter((entry) => entry.record.material === material.name).map((entry) => areas.get(entry.record.name) as number),
    );
    findings.push(
      compare(
        'total ply surface area',
        `${material.name} (material)`,
        find(std, 'material', material.name, 'total ply surface area'),
        area,
      ),
    );
  }
  return findings;
}

/** Every check of a read file: the llull validation properties and, when the file carries the CAx-IF structure, the structure and the practice's properties. */
export function checkComposite(
  record: Omit<CompositeRecord, 'validation'>,
  part: CompositePart,
  plies: Rebuilt,
  embedded: EmbeddedValidation,
  std: StandardRead,
): ValidationReport {
  const base = checkValidation(record, part, plies, embedded);
  const findings = [...base.findings, ...standardFindings(record, part, plies, std)];
  return { ...base, band: worstBand(findings), findings };
}
