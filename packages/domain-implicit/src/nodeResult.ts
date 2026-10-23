/** Shared tail of every command that adds one field node: compile it (so a bad reference fails now), then report quality, bounds and warnings. */

import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { refuseImplicit } from './codes';
import { compileField } from './compile';
import { type FieldNode, withField } from './model';

/** `doc` + `node`, with `data` = node facts + `extra`; refused (unchanged document) when the node does not compile. */
export function addNode(
  doc: CadDocument,
  command: string,
  node: FieldNode,
  headline: string,
  extra: Record<string, unknown> = {},
): CommandResult {
  const next = withField(doc, node);
  const compiled = compileField(next, node.id);
  if (!compiled.ok) return refuseImplicit(doc, command, compiled.code, compiled.message, compiled.ids);
  const { program, warnings, unverified } = compiled;
  const warningText = warnings.length === 0 ? '' : ` Warnings: ${warnings.map((w) => `${w.code} (${w.message})`).join('; ')}.`;
  return {
    document: next,
    summary: `${command}: ${headline} -> field ${node.id} (distance ${program.quality}, Lipschitz ${program.lipschitz}, ${program.bounds === null ? 'unbounded' : 'bounded'}). Next: create_implicit_body field=${node.id} voxel=<mm> to realise it.${warningText}`,
    affected: [node.id],
    data: {
      id: node.id,
      op: node.op,
      distanceQuality: program.quality,
      lipschitzIsEstimate: program.quality === 'approximate',
      lipschitz: program.lipschitz,
      bounds: program.bounds,
      unit: program.unit,
      unverified,
      warnings: warnings.map(({ code, ids, message }) => ({ code, ids, message })),
      ...extra,
    },
  };
}
