import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { getCommand } from '@core/commands/registry';

/**
 * Static scan (TR-INT-09): a command that consumes the geometry kernel must be `requiresKernel` or `kernelOptional`, or `execute` stamps no
 * provenance on its result. A block of a `defineCommand(` file consumes the kernel when it reads `ctx.kernel` / `currentContext().kernel`
 * or calls one of KERNEL_HELPERS (exported helpers that take a `GeometryKernel` or read it from `ctx`). A hit before the file's first
 * `defineCommand(` (a file-level helper) counts for every command of the file.
 */
const KERNEL_HELPERS: readonly string[] = [
  'resolveMassProperties', // geometry/resolveMassProperties: exact mass through ctx.kernel
  'bodyMassProperties', // geometry/bodyMassProperties: rigid-body mass through a kernel
  'exactLeafVolume',
  'massProvenance',
  'buildSimulationModel', // domain-dynamics: body mass properties through a kernel
  'staticChecks', // domain-dynamics
  'sourceMeshOf', // deform
  'tessellateAt', // geometry/exactMesh: kernel mesh at explicit deflections
  'withExactMesh', // geometry/exactMesh
  'exactOrMesh',
  'exactRecipe',
  'evaluateRecipe',
  'operandRecipe',
  'collectParts', // geometry/assemblyParts
  'openSolid', // geometry/pmiFeatures
  'createSolidLookup', // pmi/refresh
  'kernelStampOf', // persistence/kernelStamp
  'runModelChecks',
  'featureReferenceIssues',
  'blendStepIssue',
  'buildSurface', // domain-aero cfd
  'prepareSurface', // domain-aero cfd
  'recognitionOf',
  'machinedPart',
  'resolveFace',
  'pickFaces',
  'buildBodies',
  'lawIndex',
  'checkBlendFaces',
  'spokeReachOf',
  'shapeFindings',
  'readChamferLegs',
  'readProfileNotes',
  'diagonalOf',
  'modifyFailure',
  'realiseJoint',
  'overlapOf',
  'validateParts',
  'analyzeDeformed',
  'attachPmi',
  'blendRefusal',
  'blendSectionsOf',
  'buildFlowJob',
  'buildStepExport',
  'chainOf',
  'checkRadius',
  'checkVolume',
  'chordsToRadii',
  'classifyPair',
  'cliffEdgeOf',
  'cliffOutcome',
  'commitKernelResult',
  'creaseOfCorners',
  'depthToFace',
  'exportLegacyStep',
  'importProductPmi',
  'midsurfaceOf',
  'modificationFeature',
  'overshootFindings',
  'pairedMidsurface',
  'partMidsurfaceGeometry',
  'planExchange',
  'planStepAssembly',
  'planeStressDomain',
  'prepareCase',
  'prepareCaseWithStage',
  'prepareProfile',
  'resolveExtents',
  'resolveFeature',
  'resolvePlaneStress',
  'resolveShell',
  'resolveToolFace',
  'resultStaleness',
  'runAssemblyCheck',
  'sideFaces',
  'spineStations',
  'unionRecipe',
  // helpers that take the ExecutionContext and read ctx.kernel
  'runFaceBlend',
  'runFaceOp',
  'filletEach',
  'loadTarget',
  'extrudeText',
  'thinExtrude',
  'solidVolume',
  'limitPatchEntity',
  'childVolume',
  'exactKernel',
  'openFace',
  'wrapFaceAt',
  'solidTarget',
  'resolveOn',
  'placementFor',
];

/** Commands that read the kernel without being kernel-optional, each with the reason. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  kernel_info: 'its data IS the kernel description (name, version, capabilities): a provenance on top would repeat it',
  set_modeling_tolerance: 'the kernel only names the stamp stored beside the tolerance; no geometry is computed',
};

const root = resolve(__dirname, '../../../packages');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const files = readdirSync(root).flatMap((pkg) => {
  try {
    return sourceFiles(join(root, pkg, 'src'));
  } catch {
    return [];
  }
});

const KERNEL_READ = /(?:\bctx\??|\bcurrentContext\(\)\)?)\.kernel\b/;
const helperCall = new RegExp(`(?<!function )\\b(?:${KERNEL_HELPERS.join('|')})\\(`);

interface Consumer {
  readonly command: string;
  readonly file: string;
}

function commandName(text: string, expr: string): string {
  return /^'([^']+)'$/.exec(expr)?.[1] ?? new RegExp(`const ${expr} = '([^']+)'`).exec(text)?.[1] ?? expr;
}

interface Region {
  readonly name: string;
  readonly text: string;
}

/** The file cut at its top-level declarations (a line starting `function` / `const` / `export ...` at column 0). */
function regionsOf(text: string): Region[] {
  const heads = [...text.matchAll(/^(?:export )?(?:async )?(?:function|const|let) (\w+)/gm)];
  return heads.map((head, i) => ({ name: head[1] ?? '', text: text.slice(head.index, heads[i + 1]?.index ?? text.length) }));
}

/** Regions that read the kernel, directly or through another region of the file that does (fixpoint over same-file calls). */
function kernelRegions(regions: readonly Region[]): Set<string> {
  const reading = new Set(regions.filter((r) => KERNEL_READ.test(r.text) || helperCall.test(r.text)).map((r) => r.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of regions) {
      if (reading.has(r.name)) continue;
      if ([...reading].some((name) => new RegExp(`(?<!function )\\b${name}\\(`).test(r.text))) grew = reading.add(r.name).has(r.name);
    }
  }
  return reading;
}

function consumers(): Consumer[] {
  const found: Consumer[] = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('defineCommand(')) continue;
    const regions = regionsOf(text);
    const reading = kernelRegions(regions);
    const file = relative(root, path).split(sep).join('/');
    for (const region of regions) {
      if (!reading.has(region.name)) continue;
      for (const start of region.text.matchAll(/defineCommand\(\{\s*name: ([^,]+),/g)) {
        found.push({ command: commandName(text, (start[1] ?? '').trim()), file });
      }
    }
  }
  return found;
}

describe('kernel-consuming commands carry the kernel annotation (TR-INT-09)', () => {
  it('every command that reads the kernel is requiresKernel or kernelOptional, or allowlisted with a reason', () => {
    const missing = consumers().filter(({ command }) => {
      const annotations = getCommand(command)?.annotations;
      return annotations?.requiresKernel !== true && annotations?.kernelOptional !== true && ALLOWLIST[command] === undefined;
    });
    expect(missing.map(({ command, file }) => `${command} (${file})`).sort()).toEqual([]);
  });

  it('every allowlist entry names a real, unannotated command with a reason', () => {
    for (const [name, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length).toBeGreaterThan(10);
      const annotations = getCommand(name)?.annotations;
      expect(getCommand(name), name).toBeDefined();
      expect(annotations?.kernelOptional === true || annotations?.requiresKernel === true, name).toBe(false);
    }
  });

  it('KERNEL_HELPERS lists every exported function that takes a GeometryKernel parameter', () => {
    const exported = new Set<string>();
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      for (const m of text.matchAll(/export (?:async )?function (\w+)\s*(?:<[^>]*>)?\(([^)]*)\)/g)) {
        if (/\bkernel\??\s*:\s*(?:GeometryKernel|ExecutionContext)/.test(m[2] ?? '')) exported.add(m[1] ?? '');
      }
    }
    const unlisted = [...exported].filter((name) => !KERNEL_HELPERS.includes(name) && name !== 'guardedKernel'); // guardedKernel wraps the kernel, it does not consume it
    expect(unlisted.sort()).toEqual([]);
  });
});
