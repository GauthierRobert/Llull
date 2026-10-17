/** kernel_info: which geometry kernel is active, its capabilities and the document's modelling tolerances (aerospace 01 TR-KRN-04/102). */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { currentContext } from '../context';
import { DEFAULT_MODELING_TOLERANCE, modelingToleranceOf } from '../../model/kernelSettings';
import { kernelMismatch, kernelStampOf } from '../persistence/kernelStamp';
import type { CadDocument } from '../../model/types';

interface NamedDefault {
  readonly value: number;
  readonly unit: 'mm' | 'rad';
  readonly source: string;
  /** True while the document keeps the policy default (never set, or set to the same value). */
  readonly defaulted: boolean;
}

const POLICY_SOURCES = {
  linear: 'OCCT STEP reader read.precision.val default (TR-KRN-11)',
  angular: 'llull policy TR-KRN-11 (above Precision::Angular 1e-12)',
  maxImportTolerance: 'llull policy TR-KRN-11',
} as const;

const UNITS = { linear: 'mm', angular: 'rad', maxImportTolerance: 'mm' } as const;

export function namedTolerances(doc: Pick<CadDocument, 'kernelSettings'>): Record<keyof typeof UNITS, NamedDefault> {
  const current = modelingToleranceOf(doc);
  const entry = (key: keyof typeof UNITS): NamedDefault => {
    const defaulted = doc.kernelSettings === undefined || current[key] === DEFAULT_MODELING_TOLERANCE[key];
    return {
      value: current[key],
      unit: UNITS[key],
      source: defaulted ? POLICY_SOURCES[key] : 'document kernelSettings (set_modeling_tolerance)',
      defaulted,
    };
  };
  return { linear: entry('linear'), angular: entry('angular'), maxImportTolerance: entry('maxImportTolerance') };
}

interface KernelIssue {
  readonly code: 'KRN_KERNEL_FALLBACK' | 'KRN_KERNEL_MISMATCH';
  readonly severity: 'warn';
  readonly message: string;
  readonly remediation: string;
}

/**
 * @invariant read-only: the document is returned unchanged
 * @failure no kernel installed -> still answers, active null and capabilities []
 */
export const kernelInfo = defineCommand({
  name: 'kernel_info',
  description:
    'Report which geometry kernel is active for this session: "occt" (exact B-rep: STEP import, fillets, exact volumes) or "manifold" (mesh booleans only), ' +
    'its OCCT version / build, the optional capabilities it has (topology, analyze, distance, exportStep, importShapes, brepBlobs, ...), the isolation ' +
    '(worker or in-process) and, when the exact kernel failed to start, the fallback reason. Also returns the document modelingTolerance ' +
    '(linear mm, angular rad, maxImportTolerance mm) with its source, and warnings KRN_KERNEL_FALLBACK / KRN_KERNEL_MISMATCH ' +
    '(the document was written by another kernel or OCCT version). Call this before relying on exact results.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({}),
  run: (doc, _params, ctx): CommandResult => {
    const kernel = (ctx ?? currentContext()).kernel;
    const info = kernel?.info?.();
    const stamp = kernelStampOf(kernel);
    const active = stamp?.kernel ?? (kernel?.name === 'occt' || kernel?.name === 'manifold' ? kernel.name : null);
    const issues: KernelIssue[] = [];
    if (info?.fallbackReason !== undefined)
      issues.push({
        code: 'KRN_KERNEL_FALLBACK',
        severity: 'warn',
        message: `the exact kernel failed to start (${info.fallbackReason}); ${active ?? 'no kernel'} is active`,
        remediation: 'restart the app and report the reason; exact results are unavailable until fixed',
      });
    const mismatch = kernelMismatch(doc, stamp);
    if (mismatch !== null)
      issues.push({
        code: 'KRN_KERNEL_MISMATCH',
        severity: 'warn',
        message: mismatch,
        remediation: 'recompute stored measures with the active kernel before relying on them',
      });
    const tolerance = namedTolerances(doc);
    const data = {
      active,
      ...(info?.occtVersion === undefined ? {} : { occtVersion: info.occtVersion }),
      ...(info?.build === undefined ? {} : { build: info.build }),
      capabilities: info?.capabilities ?? [],
      ...(info?.isolation === undefined ? {} : { isolation: info.isolation }),
      ...(info?.fallbackReason === undefined ? {} : { fallbackReason: info.fallbackReason }),
      ...(doc.kernelSettings === undefined ? {} : { documentKernel: doc.kernelSettings }),
      modelingTolerance: tolerance,
      issues,
    };
    const identity =
      active === null
        ? 'no geometry kernel installed'
        : `${active}${info?.occtVersion === undefined ? '' : ` (OCCT ${info.occtVersion}${info.build === undefined ? '' : `, ${info.build}`})`}`;
    const warnings = issues.map((entry) => ` ${entry.code}: ${entry.message}.`).join('');
    return report(
      doc,
      `kernel_info: ${identity}; capabilities [${data.capabilities.join(', ')}]; modelingTolerance linear ${tolerance.linear.value} mm, ` +
        `angular ${tolerance.angular.value} rad, maxImportTolerance ${tolerance.maxImportTolerance.value} mm.${warnings}`,
      data,
    );
  },
});
