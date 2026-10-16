/**
 * Part validity (FR-FPR-02): valid closed solid, non-empty, one lump, no sheet.
 * @invariant never a pass without a kernel verdict: a kernel without `analyze` yields one `not_run` item
 */

import { type CheckItem, findingKey } from '../../model/checkResult';
import type { GeometryKernel, ShapeAnalysis } from '../kernel';
import { type AssemblyPart, type CheckTolerances, KERNEL_REMEDIATION } from './partTypes';

/** Absolute volume (mm3) at or below which a part is empty. */
const EMPTY_VOLUME_MM3 = 1e-6;
/** Mean thickness proxy 2V/A (mm) below which a part is a sheet. */
const SHEET_THICKNESS_MM = 1e-3;

export const makeItem = (
  code: string,
  status: CheckItem['status'],
  ids: readonly string[],
  remediation: string,
  extra: Partial<CheckItem> = {},
): CheckItem => ({ code, status, ids: [...ids].sort(), findingKey: findingKey('assembly', code, ids), values: {}, remediation, ...extra });

export function kernelUnsupportedItem(ids: readonly string[], what: string): CheckItem {
  return makeItem('FPR_KERNEL_UNSUPPORTED', 'not_run', ids, KERNEL_REMEDIATION, {
    unverified: true,
    note: `${what} needs a kernel capability that is not installed`,
  });
}

export interface PartValidity {
  readonly items: CheckItem[];
  /** Analysis per part id (parts the kernel could analyze). */
  readonly analyses: ReadonlyMap<string, ShapeAnalysis>;
  /** Parts invalid or empty: left out of pair and thickness checks. */
  readonly excluded: ReadonlySet<string>;
}

function partItems(part: AssemblyPart, analysis: ShapeAnalysis, tolerances: CheckTolerances): CheckItem[] {
  const { mmPerUnit } = tolerances;
  const volumeMm3 = analysis.volume * mmPerUnit ** 3;
  const areaMm2 = analysis.area * mmPerUnit ** 2;
  const id = [part.id];
  if (!analysis.valid)
    return [
      makeItem(
        'FPR_PART_INVALID',
        'fail',
        id,
        'Rebuild the feature (boolean, fillet, shell) that produced this solid; the note holds the kernel status.',
        { note: analysis.status },
      ),
    ];
  if (volumeMm3 <= EMPTY_VOLUME_MM3)
    return [
      makeItem('FPR_PART_EMPTY', 'fail', id, 'Check the booleans that removed everything; delete the part or rebuild it.', {
        values: { volumeMm3 },
      }),
    ];
  const items: CheckItem[] = [];
  if (analysis.lumps.length > 1)
    items.push(
      makeItem('FPR_PART_DISCONNECTED', 'fail', id, 'Split the lumps into separate parts, or join them with material.', {
        values: {
          lumps: analysis.lumps.length,
          ...Object.fromEntries(analysis.lumps.map((lump, k) => [`lumpVolumeMm3_${k}`, lump.volume * mmPerUnit ** 3])),
        },
      }),
    );
  const proxyMm = areaMm2 > 0 ? (2 * volumeMm3) / areaMm2 : 0;
  if (analysis.freeFaces > 0 || (areaMm2 > 0 && proxyMm < SHEET_THICKNESS_MM))
    items.push(
      makeItem('FPR_PART_SHEET', 'fail', id, 'Give the surface thickness (shell, extrude) so it is a closed solid.', {
        values: { areaMm2, meanThicknessMm: proxyMm, freeFaces: analysis.freeFaces },
      }),
    );
  return items;
}

/** Analyze every part. */
export function validateParts(kernel: GeometryKernel, parts: readonly AssemblyPart[], tolerances: CheckTolerances): PartValidity {
  const analyses = new Map<string, ShapeAnalysis>();
  const excluded = new Set<string>();
  const analyze = kernel.analyze?.bind(kernel);
  if (analyze === undefined)
    return {
      items:
        parts.length === 0
          ? []
          : [
              kernelUnsupportedItem(
                parts.map((part) => part.id),
                'part validity',
              ),
            ],
      analyses,
      excluded,
    };
  const items: CheckItem[] = [];
  for (const part of parts) {
    const analysis = analyze(part.shape);
    if (analysis === null) {
      items.push(kernelUnsupportedItem([part.id], 'part validity'));
      continue;
    }
    analyses.set(part.id, analysis);
    const found = partItems(part, analysis, tolerances);
    if (found.some((entry) => entry.code === 'FPR_PART_INVALID' || entry.code === 'FPR_PART_EMPTY')) excluded.add(part.id);
    items.push(...found);
  }
  return { items, analyses, excluded };
}
