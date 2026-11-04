import type { LlullIdRun } from '@core/commands/exchange/gltfIds';

/** Instance entity ids of a node's extras (`llullIds` list or `llullIdRuns`), in instance order. */
export function nodeInstanceIds(extras: { llullIds?: readonly string[]; llullIdRuns?: readonly LlullIdRun[] } | undefined): string[] {
  if (extras?.llullIds !== undefined) return [...extras.llullIds];
  return (extras?.llullIdRuns ?? []).flatMap((run) =>
    typeof run === 'string' ? [run] : Array.from({ length: run[2] - run[1] + 1 }, (_, k) => `${run[0]}${run[1] + k}`),
  );
}
