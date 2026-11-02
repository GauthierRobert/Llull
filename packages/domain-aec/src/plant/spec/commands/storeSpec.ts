/** Spec storage shared by the spec commands: draft normalisation, revisions, and the import rules (`import_pipe_spec`, `import_pipe_spec_sheet`). */

import { changed, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { refuse } from '../../catalog/codes';
import { canonicalSpecText, type SpecIssue } from '../file';
import { getSpecModel, latestSpec, specRevisions, withSpecModel } from '../store';
import type { PipeSpec } from '../types';

/** The spec as a draft: status draft, no approval block. */
export const draftOf = (spec: PipeSpec): PipeSpec => ({
  ...(Object.fromEntries(Object.entries(spec).filter(([key]) => key !== 'approval')) as unknown as PipeSpec),
  status: 'draft',
});

/** A spec as a draft with no approval and revision 0: what two imports are compared on. */
export const content = (spec: PipeSpec): string => canonicalSpecText({ ...draftOf(spec), revision: 0 });

export function withRevisions(doc: CadDocument, spec: PipeSpec, replaceLast: boolean): CadDocument {
  const model = getSpecModel(doc);
  const revisions = specRevisions(doc, spec.id) ?? [];
  return withSpecModel(doc, {
    specs: { ...model.specs, [spec.id]: replaceLast ? [...revisions.slice(0, -1), spec] : [...revisions, spec] },
    specOrder: revisions.length === 0 ? [...model.specOrder, spec.id] : model.specOrder,
    ...(model.approvals === undefined ? {} : { approvals: model.approvals }),
  });
}

export const specStats = (spec: PipeSpec): string =>
  `${spec.components.length} component(s), ${Object.values(spec.branchTable?.cells ?? {}).reduce((count, row) => count + Object.keys(row).length, 0)} branch cell(s)`;

export const issueRefusal = (doc: CadDocument, command: string, issues: readonly SpecIssue[]): CommandResult => ({
  ...refuse(
    doc,
    command,
    issues[0]?.code ?? 'PSC_SPEC_INVALID',
    `${issues.length} problem(s), first: ${issues[0]?.message ?? 'invalid spec'}`,
    [],
    issues.map((issue) => issue.path),
  ),
  data: { issues },
});

export function storeImportedSpec(doc: CadDocument, command: string, incoming: PipeSpec, replace: boolean): CommandResult {
  const latest = latestSpec(doc, incoming.id);
  const forced = incoming.status !== 'draft';
  if (latest === undefined) {
    const stored = draftOf(incoming);
    return {
      ...changed(
        withRevisions(doc, stored, false),
        `Imported pipe spec ${stored.id} r${stored.revision} as draft: ${specStats(stored)}${forced ? ` (status ${incoming.status} in the file ignored: approval needs the human gate)` : ''}.`,
        [],
      ),
      data: {
        specId: stored.id,
        revision: stored.revision,
        status: 'draft',
        components: stored.components.length,
        statusForcedToDraft: forced,
        replaced: false,
      },
    };
  }
  if (content(latest) === content(incoming))
    return report(doc, `${command}: spec ${incoming.id} r${latest.revision} already present with identical content; nothing changed.`, {
      specId: incoming.id,
      revision: latest.revision,
      unchanged: true,
    });
  if (!replace)
    return refuse(
      doc,
      command,
      'PSC_SPEC_CONFLICT',
      `spec ${incoming.id} already exists (r${latest.revision}) with different content`,
      [incoming.id],
      ['spec.id'],
    );
  const inPlace = latest.status === 'draft';
  const stored = { ...draftOf(incoming), revision: inPlace ? latest.revision : latest.revision + 1 };
  return {
    ...changed(
      withRevisions(doc, stored, inPlace),
      `Imported pipe spec ${stored.id} as ${inPlace ? 'a replaced draft' : 'new draft revision'} r${stored.revision}: ${specStats(stored)}.`,
      [],
    ),
    data: {
      specId: stored.id,
      revision: stored.revision,
      status: 'draft',
      components: stored.components.length,
      statusForcedToDraft: forced,
      replaced: true,
    },
  };
}
