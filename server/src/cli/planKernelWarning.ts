/**
 * `llull run --validate` warning: a dry run checks structure and params, not geometry, so a plan using a command that needs or prefers the exact
 * kernel passes although a mesh kernel (Manifold, the fallback when the native `llull-kernel` is missing) then no-ops it or answers approximately
 * (FR-INT-07): one warning per distinct kernel-required (`requiresKernel`) or kernel-optional (`kernelOptional`) command of the plan.
 */

import type { GeometryKernel } from '@core/geometry/kernel';
import { getCommand } from '@core/commands/registry';
import { isRecord } from '@lib/isRecord';

/** Commands whose recipe op (fillet, chamfer, shell, blend) Manifold cannot perform: they need the native kernel. */
export const OCCT_ONLY_COMMANDS: readonly string[] = ['fillet_edge', 'chamfer_edge', 'shell_solid', 'blend_union'];

function collect(items: unknown, found: Set<string>): void {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const command = item['command'];
    if (typeof command === 'string') found.add(command);
    collect(item['actions'], found); // loop nodes nest their body
  }
}

function warning(command: string, kernelName: string): string | null {
  const annotations = getCommand(command)?.annotations;
  const advice = 'build or bundle the native llull-kernel (LLULL_NATIVE_DIR) and do not force --kernel manifold.';
  if (OCCT_ONLY_COMMANDS.includes(command))
    return `${command} cannot be performed by the ${kernelName} kernel (it no-ops or fails at run time, and --validate does not run geometry): ${advice}`;
  if (annotations?.requiresKernel === true)
    return `${command} needs a geometry kernel and the ${kernelName} kernel answers it with a mesh result, not exact geometry: ${advice}`;
  if (annotations?.kernelOptional === true)
    return `${command} is kernel-optional: the ${kernelName} kernel answers it on the mesh path (approximate), not on exact geometry: ${advice}`;
  return null;
}

/** Warnings for a plan about to run on the installed `kernel`; empty on an exact kernel or when the plan needs no kernel command. */
export function planKernelWarnings(plan: unknown, kernel: GeometryKernel | null): string[] {
  if (kernel?.supports('fillet') === true || !isRecord(plan)) return [];
  const commands = new Set<string>();
  collect(plan['actions'], commands);
  return [...commands].flatMap((command) => warning(command, kernel?.name ?? 'active') ?? []);
}
