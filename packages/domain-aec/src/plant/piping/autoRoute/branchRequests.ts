/** Structural check of the `branches` of an `auto_route_lines` request, shared by the command and the native planner (which runs it before its long plan). */

export interface BranchStructureError {
  readonly index: number;
  readonly lineId: string;
  readonly message: string;
}

/**
 * The first branch whose header is not one of `lines`, whose own line is one of `lines`, or that is listed twice; undefined when the structure is valid.
 * @failure entries that are not { lineId } / { lineId, headerLineId } objects are not judged here (the schema refuses them)
 */
export function branchStructureError(
  lines: readonly { readonly lineId: string }[],
  branches: readonly { readonly lineId: string; readonly headerLineId: string }[],
): BranchStructureError | undefined {
  const at = branches.findIndex(
    (branch, index) =>
      !lines.some((line) => line.lineId === branch.headerLineId) ||
      lines.some((line) => line.lineId === branch.lineId) ||
      branches.findIndex((other) => other.lineId === branch.lineId) !== index,
  );
  const bad = branches[at];
  if (bad === undefined) return undefined;
  return {
    index: at,
    lineId: bad.lineId,
    message: `branch ${bad.lineId}: its headerLineId must be a line of lines, and the branch line must not be one of lines nor listed twice`,
  };
}
