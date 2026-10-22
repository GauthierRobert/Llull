/** Whether a recorded result still describes the case: its case hash and the hash of the flow surface the kernel builds now. */

import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import type { CfdCase } from '@aero/cfd/types';
import { caseHashOf } from './caseDoc';
import { collectBodies } from './flowSurface';
import { prepareSurface } from './surfaceStage';

export interface Staleness {
  readonly stale: boolean;
  readonly reasons: readonly string[];
  readonly caseHash: string;
  /** Null when the case has no 3D body any more. */
  readonly geometryHash: string | null;
}

export function resultStaleness(
  doc: CadDocument,
  cfdCase: CfdCase,
  recorded: { readonly caseHash: string; readonly geometryHash: string },
  kernel: GeometryKernel | null,
): Staleness {
  const caseHash = caseHashOf(cfdCase);
  const { leaves } = collectBodies(doc, cfdCase);
  const geometryHash = leaves.length === 0 ? null : prepareSurface(doc, cfdCase, leaves, kernel).geometryHash;
  const reasons = [
    ...(caseHash === recorded.caseHash ? [] : ['the case changed since the solve']),
    ...(geometryHash === recorded.geometryHash ? [] : ['the flow surface changed since the solve']),
  ];
  return { stale: reasons.length > 0, reasons, caseHash, geometryHash };
}
