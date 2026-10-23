/** Document-scope pass of `check_pipe_spec` (§5.6 9): every pipe element against the spec revision it was resolved with. */

import type { CadDocument } from '@core/model/types';
import { toMm } from '@core/model/units';
import { elementsOf, getBuilding } from '../../../building/model';
import { resolveComponent } from '../resolve';
import { findSpec, latestApproved, latestSpec, specCatalogs } from '../store';
import { finding, type SpecFinding } from './finding';

/** Tolerance between a pipe diameter and its spec row (mm); the catalogue prints 0.01 mm. */
const OD_TOLERANCE_MM = 0.05;

export function pipeFindings(doc: CadDocument): SpecFinding[] {
  const pipes = elementsOf(getBuilding(doc), 'pipe');
  const unbound = pipes.filter((pipe) => pipe.spec === undefined).map((pipe) => pipe.id);
  const unknown: string[] = [];
  const stale: string[] = [];
  const mismatched: string[] = [];
  for (const pipe of pipes) {
    const binding = pipe.spec;
    if (binding === undefined) continue;
    const spec = findSpec(doc, binding.specId, binding.revision);
    if (spec === undefined) {
      unknown.push(pipe.id);
      continue;
    }
    const current = latestApproved(doc, binding.specId) ?? latestSpec(doc, binding.specId);
    if (current !== undefined && current.revision !== binding.revision) stale.push(pipe.id);
    const outcome = resolveComponent(spec, specCatalogs(doc, spec).catalogs, { type: 'pipe', nps: binding.nps });
    const expected = outcome.ok ? (outcome.resolved.outsideDiameterMm ?? binding.odMm) : binding.odMm;
    if (Math.abs(toMm(doc, pipe.diameter) - expected) > OD_TOLERANCE_MM || Math.abs(binding.odMm - expected) > OD_TOLERANCE_MM)
      mismatched.push(pipe.id);
  }
  const out: SpecFinding[] = [];
  const add = (code: string, status: 'fail' | 'warn', ids: readonly string[], message: string): void => {
    if (ids.length > 0)
      out.push(
        finding('document', 'document', code, status, ids, ['building.elements'], `${ids.length} pipe(s) ${message}`, {
          pipes: ids.length,
        }),
      );
  };
  add('PSC_SPEC_UNKNOWN', 'fail', unknown, 'name a spec revision that is not in this document');
  add('PSC_PIPE_SPEC_MISMATCH', 'fail', mismatched, 'have an outside diameter that differs from their spec row');
  add('PSC_PIPE_NO_SPEC', 'warn', unbound, 'have no spec (legacy DN table applies)');
  add('PSC_SPEC_REVISION_STALE', 'warn', stale, 'were resolved against an older revision than the latest approved one');
  return out;
}
