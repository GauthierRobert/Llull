/**
 * Parameter validation and defaulting of add_portal_frame_building.
 * @layer domain-aec
 * @pure
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import { fromMm } from '../model';
import { findProfile, type SteelProfile } from '../steel/profiles';
import type { PortalProfiles } from './portalGeometry';
import type { portalFrameParams } from './portalParams';
import type { z } from '@core/commands/schema';

type PortalParams = z.output<typeof portalFrameParams>;

interface PortalInputs {
  readonly mm: (value: number) => number;
  readonly origin: Vec2;
  readonly span: number;
  readonly spanCount: number;
  readonly hallLength: number;
  readonly targetBay: number;
  readonly eave: number;
  readonly pitchDegrees: number;
  readonly purlinSpacing: number;
  readonly railSpacing: number;
  readonly roofType: 'duopitch' | 'monopitch';
  readonly columnBase: 'pinned' | 'fixed';
  readonly profiles: PortalProfiles;
}

/** @failure any invalid dimension / profile / combination -> `{ reason }` (full failure summary) */
export function portalInputs(
  doc: CadDocument,
  params: PortalParams,
): PortalInputs | { reason: string } {
  const fail = (reason: string): { reason: string } => ({
    reason: `add_portal_frame_building failed: ${reason}`,
  });
  const mm = (value: number): number => fromMm(doc, value);
  const origin = params.origin ?? [0, 0];
  const span = params.spans ? Math.max(...params.spans) : (params.span ?? mm(24000));
  const hallLength = params.length ?? mm(48000);
  const targetBay = params.baySpacing ?? mm(6000);
  const eave = params.eaveHeight ?? mm(7000);
  const pitchDegrees = params.roofPitch ?? 6;
  const purlinSpacing = params.purlinSpacing ?? mm(1800);
  const railSpacing = params.railSpacing ?? mm(1800);
  if (
    params.spans &&
    (params.spans.length < 1 ||
      params.spans.length > 10 ||
      params.spans.some((width) => width <= 0))
  ) {
    return fail('spans must be 1–10 widths, each > 0.');
  }
  const spanCount = params.spans?.length ?? 1;
  const sizes = [span, hallLength, targetBay, eave, purlinSpacing, railSpacing];
  if (sizes.some((value) => value <= 0)) {
    return fail('all sizes > 0 required.');
  }
  if (pitchDegrees < 0 || pitchDegrees >= 45) {
    return fail('roofPitch must be in [0, 45) degrees.');
  }
  const roofType = params.roofType ?? 'duopitch';
  const columnBase = params.columnBase ?? 'pinned';
  if (columnBase === 'fixed' && params.basePlates === false) {
    return fail("columnBase 'fixed' needs base plates (basePlates must not be false).");
  }
  const names = {
    column: params.columnProfile ?? 'HEA400',
    rafter: params.rafterProfile ?? 'IPE450',
    purlin: params.purlinProfile ?? 'C200x75x2.5',
    rail: params.railProfile ?? 'C200x75x2.5',
    brace: params.braceProfile ?? 'CHS76.1x3.6',
    gable: params.gablePostProfile ?? 'HEA200',
  };
  const profiles = Object.fromEntries(
    Object.entries(names).map(([key, name]) => [key, findProfile(name)]),
  ) as Record<keyof typeof names, SteelProfile | undefined>;
  const missing = Object.entries(profiles).filter(([, profile]) => !profile);
  if (missing.length > 0) {
    return fail(
      `unknown profile(s) ${missing.map(([key]) => names[key as keyof typeof names]).join(', ')} (see list_steel_profiles).`,
    );
  }
  const p = profiles as PortalProfiles;
  if (params.crane && !(params.crane.railHeight > 0 && params.crane.railHeight < eave)) {
    return fail('crane.railHeight must be > 0 and below the eaves.');
  }
  return {
    mm,
    origin,
    span,
    spanCount,
    hallLength,
    targetBay,
    eave,
    pitchDegrees,
    purlinSpacing,
    railSpacing,
    roofType,
    columnBase,
    profiles: p,
  };
}
