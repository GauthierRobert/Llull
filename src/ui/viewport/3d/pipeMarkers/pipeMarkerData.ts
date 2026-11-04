// Pure helpers of the pipe-content markers: parse the read-only `pipe_markers` answer into arrow placements (absolute mm) and one text label
// per run, and write the instance matrices (document units) of the arrows. The arrow geometry points along +Y, like the port glyphs.

import type { Vec3 } from '@core/model/types';
import { arrowQuaternion } from '../ports/portGlyphs';

export interface PipeMarker {
  readonly positionMm: Vec3;
  readonly tangent: Vec3;
  /** Field colour of the run's rule (#rrggbb). */
  readonly colour: string;
}

interface PipeMarkerLabel {
  readonly runId: string;
  readonly positionMm: Vec3;
  readonly letters: string;
  readonly colour: string;
}

export interface PipeMarkerScene {
  readonly markers: readonly PipeMarker[];
  readonly labels: readonly PipeMarkerLabel[];
}

/** Arrow length in mm (a legible marker on a DN 100 - 600 line; the answer carries no pipe diameter). */
export const MARKER_LENGTH_MM = 320;
/** Labels drawn at most (text meshes are not instanced). */
export const MAX_LABELS = 200;

const HEX = /^#[0-9a-fA-F]{6}$/;

const isVec3 = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

/** Markers of a `pipe_markers` answer; runs without a matching rule (no colour) and malformed placements are skipped. */
export function parsePipeMarkers(data: unknown): PipeMarkerScene {
  const runs = record(data)?.['runs'];
  if (!Array.isArray(runs)) return { markers: [], labels: [] };
  const markers: PipeMarker[] = [];
  const labels: PipeMarkerLabel[] = [];
  for (const run of runs) {
    const rule = record(record(run)?.['rule']);
    const placements = record(run)?.['markers'];
    const colour = rule?.['fieldHex'];
    if (rule === null || typeof colour !== 'string' || !HEX.test(colour) || !Array.isArray(placements)) continue;
    const own: PipeMarker[] = [];
    for (const placement of placements) {
      const entry = record(placement);
      if (entry !== null && isVec3(entry['positionMm']) && isVec3(entry['tangent'])) {
        own.push({ positionMm: entry['positionMm'], tangent: entry['tangent'], colour });
      }
    }
    markers.push(...own);
    const letters = rule['markerLetters'];
    const middle = own[Math.floor(own.length / 2)];
    if (middle !== undefined && typeof letters === 'string' && letters !== '' && labels.length < MAX_LABELS) {
      const letterHex = rule['letterHex'];
      labels.push({
        runId: String(record(run)?.['id'] ?? ''),
        positionMm: middle.positionMm,
        letters,
        colour: typeof letterHex === 'string' && HEX.test(letterHex) ? letterHex : '#ffffff',
      });
    }
  }
  return { markers, labels };
}

/** Column-major 4x4 matrices (16 floats per marker) in document units: arrow of `lengthMm` along the tangent, base at the placement. */
export function markerMatrices(markers: readonly PipeMarker[], mmPerUnit: number, lengthMm: number = MARKER_LENGTH_MM): Float32Array {
  const out = new Float32Array(markers.length * 16);
  const scale = lengthMm / mmPerUnit;
  markers.forEach((marker, index) => {
    const [x, y, z, w] = arrowQuaternion(marker.tangent);
    const [x2, y2, z2] = [x + x, y + y, z + z];
    const [xx, xy, xz, yy, yz, zz] = [x * x2, x * y2, x * z2, y * y2, y * z2, z * z2];
    const [wx, wy, wz] = [w * x2, w * y2, w * z2];
    out.set(
      [
        (1 - (yy + zz)) * scale,
        (xy + wz) * scale,
        (xz - wy) * scale,
        0,
        (xy - wz) * scale,
        (1 - (xx + zz)) * scale,
        (yz + wx) * scale,
        0,
        (xz + wy) * scale,
        (yz - wx) * scale,
        (1 - (xx + yy)) * scale,
        0,
        marker.positionMm[0] / mmPerUnit,
        marker.positionMm[1] / mmPerUnit,
        marker.positionMm[2] / mmPerUnit,
        1,
      ],
      index * 16,
    );
  });
  return out;
}
