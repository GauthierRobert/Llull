/**
 * Node extras of an instanced glTF node (export_gltf instancing "gpu"): the instance entity ids in instance order, as a plain list
 * (`llullIds`) or, when ids come in numbered runs (`<prefix><n>`, n, n+1, ... as step-scoped ids do), as `llullIdRuns`.
 */

/** One entry of `llullIdRuns`: an id kept as is, or `[prefix, first, last]` = the ids `prefix + n` for n = first..last (last >= first + 2). */
export type LlullIdRun = string | readonly [prefix: string, first: number, last: number];

/** Shortest run worth writing as a triple (`["e",1,3]` is no shorter than three short ids). */
const MIN_RUN = 3;
const NUMBERED = /^(.*?)(0|[1-9]\d{0,14})$/s;

/** Prefix and number of an id ending in a canonical decimal (no leading zero), else null. */
function numbered(id: string): { prefix: string; n: number } | null {
  const match = NUMBERED.exec(id);
  return match === null ? null : { prefix: match[1] ?? '', n: Number(match[2]) };
}

/**
 * `{ llullIds }` for `ids`, or `{ llullIdRuns }` when at least one run of MIN_RUN or more consecutive numbered ids exists.
 * @invariant expanding the runs in order gives `ids` back
 */
export function instanceIdExtras(ids: readonly string[]): { llullIds: string[] } | { llullIdRuns: LlullIdRun[] } {
  const runs: LlullIdRun[] = [];
  let compacted = false;
  for (let i = 0; i < ids.length; ) {
    const start = numbered(ids[i] ?? '');
    let end = i;
    if (start !== null) {
      let last = start.n;
      for (let j = i + 1; j < ids.length; j++) {
        const next = numbered(ids[j] ?? '');
        if (next === null || next.prefix !== start.prefix || next.n !== last + 1) break;
        last = next.n;
        end = j;
      }
      if (end - i + 1 >= MIN_RUN) {
        runs.push([start.prefix, start.n, last]);
        compacted = true;
        i = end + 1;
        continue;
      }
    }
    runs.push(ids[i] ?? '');
    i++;
  }
  return compacted ? { llullIdRuns: runs } : { llullIds: [...ids] };
}
