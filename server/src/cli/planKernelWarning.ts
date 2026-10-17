/**
 * `llull run --validate` warning: a dry run checks structure and params, not geometry, so a plan using fillet / chamfer / shell
 * passes although the default Manifold kernel (a mesh kernel: `supports(op)` false) then no-ops them.
 */

import { isRecord } from '@lib/isRecord';

/** Commands whose recipe op (fillet, chamfer, shell, blend) Manifold cannot perform: they need `--kernel occt`. */
export const OCCT_ONLY_COMMANDS: readonly string[] = ['fillet_edge', 'chamfer_edge', 'shell_solid', 'blend_union'];

function collect(items: unknown, found: Set<string>): void {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const command = item['command'];
    if (typeof command === 'string' && OCCT_ONLY_COMMANDS.includes(command)) found.add(command);
    collect(item['actions'], found); // loop nodes nest their body
  }
}

/** Warnings for a plan about to run on `kernel`; empty on OCC or when the plan needs no exact-B-rep command. */
export function planKernelWarnings(plan: unknown, kernel: string): string[] {
  if (kernel === 'occt' || !isRecord(plan)) return [];
  const found = new Set<string>();
  collect(plan['actions'], found);
  if (found.size === 0) return [];
  return [
    `the plan uses ${[...found].join(', ')}, which the ${kernel} kernel cannot perform (they no-op or fail at run time, and --validate does not run geometry): run with --kernel occt.`,
  ];
}
