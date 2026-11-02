/** Binding a pipe element to a spec (plant 01 PSC M3): the spec revision and size a pipe is resolved against, and the OD / wall / schedule it gets. */

import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { refuse } from '../catalog/codes';
import type { SpecBinding } from '../catalog/types';
import { loadSpec, isLoaded } from './commands/answer';
import { resolveComponent } from './resolve';
import { keyIn } from './size';
import { latestApproved } from './store';
import type { PipeSpec } from './types';

interface BindRequest {
  readonly specId: string;
  /** Spec revision; default the newest approved one, else the newest. */
  readonly revision?: number | undefined;
  readonly nps?: string | number | undefined;
  readonly dn?: string | number | undefined;
  /** The schedule the caller expects at this size: the spec decides, a different one is refused. */
  readonly schedule?: string | undefined;
}

export interface Bound {
  readonly spec: PipeSpec;
  readonly binding: SpecBinding;
  /** DN paired with the size (the legacy `PipeElement.dn`), when the pairing is defined. */
  readonly dn: number | null;
  /** Coded warnings (not refusals): PSC_SPEC_NOT_APPROVED, PSC_DATA_UNVERIFIED. */
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

/**
 * Resolve the spec pipe at the size and build the binding.
 * @failure unknown spec / catalogue -> PSC_SPEC_UNKNOWN / PSC_CATALOG_UNKNOWN; size missing or unknown -> PSC_SIZE_UNKNOWN; out of range -> PSC_SIZE_OUT_OF_RANGE;
 *   no pipe component -> PSC_NO_COMPONENT; no OD / wall row -> PSC_CATALOG_ROW_MISSING; schedule differs from the spec's -> PSC_SCHEDULE_UNKNOWN
 */
export function bindPipe(doc: CadDocument, command: string, request: BindRequest): Bound | CommandResult {
  const revision = request.revision ?? latestApproved(doc, request.specId)?.revision;
  const loaded = loadSpec(doc, command, request.specId, revision);
  if (!isLoaded(loaded)) return loaded;
  const { spec, catalogs } = loaded;
  const outcome = resolveComponent(spec, catalogs, { type: 'pipe', nps: request.nps, dn: request.dn });
  if (!outcome.ok) return refuse(doc, command, outcome.code, outcome.message, outcome.ids, outcome.paths);
  const { resolved } = outcome;
  const od = resolved.outsideDiameterMm;
  const wall = resolved.wallMm;
  if (od === undefined || wall === undefined)
    return refuse(
      doc,
      command,
      'PSC_CATALOG_ROW_MISSING',
      `spec ${spec.id} r${spec.revision} gives no outside diameter / wall for ${resolved.size.system} ${resolved.size.key} (component ${resolved.component.id})`,
      [resolved.component.id],
      ['nps'],
    );
  if (request.schedule !== undefined && request.schedule !== resolved.schedule)
    return refuse(
      doc,
      command,
      'PSC_SCHEDULE_UNKNOWN',
      `spec ${spec.id} r${spec.revision} selects schedule ${resolved.schedule ?? 'none'} at ${resolved.size.system} ${resolved.size.key}, not ${request.schedule}: the spec decides`,
      [resolved.component.id],
      ['schedule'],
    );
  const warnings = [
    ...(spec.status === 'approved'
      ? []
      : [
          {
            code: 'PSC_SPEC_NOT_APPROVED',
            message: `spec ${spec.id} r${spec.revision} is ${spec.status}: approve_pipe_spec needs a human signature`,
          },
        ]),
    ...(resolved.verified
      ? []
      : [{ code: 'PSC_DATA_UNVERIFIED', message: `unverified dimensions: ${resolved.unverifiedDims.join(', ') || 'no catalogue row'}` }]),
  ];
  const dnKey = keyIn(resolved.size, 'DN');
  const specSystem = spec.sizeRange.from.system;
  const specKey = keyIn(resolved.size, specSystem);
  return {
    spec,
    dn: dnKey === null ? null : Number(dnKey),
    warnings,
    binding: {
      specId: spec.id,
      revision: spec.revision,
      nps: specKey ?? resolved.size.key,
      sizeSystem: specKey === null ? resolved.size.system : specSystem,
      ...(resolved.schedule === undefined ? {} : { schedule: resolved.schedule }),
      odMm: od,
      wallMm: wall,
      dimensionalStandard: resolved.dimensionalStandard ?? spec.dimensionalStandard,
      verified: resolved.verified,
    },
  };
}

export const isBound = (value: Bound | CommandResult): value is Bound => 'binding' in value;
