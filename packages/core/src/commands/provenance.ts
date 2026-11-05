/** Result provenance (FR-INT-07): which kernel answered a geometry command and whether that is the degraded (mesh) path. */

import type { CommandDefinition, CommandResult, ExecutionContext, ResultProvenance } from './types';

/**
 * Provenance of a kernel-using command run with `ctx`, read from the kernel's own description (`GeometryKernel.info`).
 * @invariant a kernel without `info()` reads as the in-process Manifold with exact not requested (never degraded): the renderer's local-mode kernel is that
 *   Manifold by design, so the degraded chip of the UI relies on the backend's `/health` (requested vs active), not on this function
 * @invariant known gap: a native sidecar that dies permanently after install still describes itself as `occt-native` (TR-INT-09 open item)
 */
export function kernelProvenance(ctx: ExecutionContext): ResultProvenance {
  const kernel = ctx.kernel;
  if (kernel === null) return { kernel: 'none', exactRequested: false };
  const info = kernel.info?.();
  const active = info?.active ?? (info?.occtVersion !== undefined || kernel.name === 'occt' ? 'occt-native' : 'manifold');
  return {
    kernel: active,
    exactRequested: info?.exactRequested ?? false,
    ...(info?.fallbackReason === undefined ? {} : { fallbackReason: info.fallbackReason }),
  };
}

/** True when the exact kernel was asked for and the mesh kernel answered. */
export function isDegraded(provenance: ResultProvenance | undefined): provenance is ResultProvenance {
  return provenance !== undefined && provenance.exactRequested && provenance.kernel !== 'occt-native';
}

/**
 * `result` with its provenance: its own when `def` uses the kernel (`requiresKernel` / `kernelOptional`) and the result carries none, else the one it
 * already has; the degraded one of the executes nested in the run (`nested`) wins over a non-degraded own, so a command composing others reports the worst.
 */
export function withProvenance(
  def: CommandDefinition<unknown>,
  ctx: ExecutionContext,
  result: CommandResult,
  nested: ResultProvenance | null,
): CommandResult {
  const annotations = def.annotations;
  const usesKernel = annotations?.requiresKernel === true || annotations?.kernelOptional === true;
  const own = result.provenance ?? (usesKernel ? kernelProvenance(ctx) : undefined);
  const provenance = isDegraded(own) ? own : (nested ?? own);
  return provenance === undefined || provenance === result.provenance ? result : { ...result, provenance };
}
