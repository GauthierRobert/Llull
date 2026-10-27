/**
 * Designs of the lifecycle contract: the action-matrix corpus, the golden plan sets that create plugin slices, and one seed document per plugin
 * that owns a document slice (tests/helpers/pluginSliceSeeds.ts). Also the coverage rule: every plugin with a document extension is exercised.
 */

import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { onPluginInstalled } from '@core/plugins/host';
import { compositePlans } from '../golden/compositePlans';
import { constraintPlans } from '../golden/plansConstraints';
import { deformPlans } from '../golden/deformPlans';
import { feaPlans } from '../golden/feaPlans';
import { implicitPlans } from '../golden/implicitPlans';
import { pipingPlans } from '../golden/pipingPlans';
import { pipingPlansV1 } from '../golden/pipingPlansV1';
import { pipingPlansV1b } from '../golden/pipingPlansV1b';
import { plmPlans } from '../golden/plmPlans';
import { SLICE_SEEDS } from '../helpers/pluginSliceSeeds';
import { loadDesigns } from './corpus';
import { buildDesign } from './matrixRunner';
import type { Design } from './types';

/** A design the lifecycle suite can build: a plan run through `build_project`, or a seed document of one plugin. */
export interface LifecycleDesign {
  readonly id: string;
  /** Command names the design uses (plans) or the whole command set of its plugin (seeds): drives the coverage rule. */
  readonly commands: ReadonlySet<string>;
  /** Cost proxy for choosing the cheapest design of a plugin. */
  readonly size: number;
  /** The built document, or null when the design does not build on this kernel. */
  readonly build: () => CadDocument | null;
  readonly context?: () => ExecutionContext | undefined;
}

const EXTRA_SETS: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>> = {
  fea: feaPlans,
  composite: compositePlans,
  constraint: constraintPlans,
  deform: deformPlans,
  implicit: implicitPlans,
  piping: pipingPlans,
  pipingV1: pipingPlansV1,
  pipingV1b: pipingPlansV1b,
  plm: plmPlans,
};

/** Every `command` name a plan mentions (nested `actions` included). */
function commandsOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) commandsOf(item, into);
  else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record['command'] === 'string') into.add(record['command']);
    for (const child of Object.values(record)) if (typeof child === 'object') commandsOf(child, into);
  }
  return into;
}

/** Plugins that own a document extension, with the names of their commands. */
function documentPlugins(): { name: string; commands: ReadonlySet<string> }[] {
  const plugins: { name: string; commands: ReadonlySet<string> }[] = [];
  onPluginInstalled((plugin) => {
    if (plugin.document !== undefined && !plugins.some((p) => p.name === plugin.name))
      plugins.push({ name: plugin.name, commands: new Set(plugin.commands.map((command) => command.name)) });
  });
  return plugins;
}

const planDesign = (design: Design): LifecycleDesign => ({
  id: design.id,
  commands: commandsOf(design.actions),
  size: JSON.stringify(design.actions).length,
  build: () => {
    const built = buildDesign(design);
    return built.row.outcome === 'ok' ? built.doc : null;
  },
});

/** Every lifecycle design, in a stable order. */
export function lifecycleDesigns(): LifecycleDesign[] {
  const extra = Object.entries(EXTRA_SETS).flatMap(([set, plans]) =>
    Object.keys(plans)
      .sort()
      .map((name) => planDesign({ id: `lifecycle/${set}/${name}`, corpus: 'golden', actions: plans[name] ?? [] })),
  );
  const seeds = documentPlugins().flatMap((plugin) => {
    const seed = SLICE_SEEDS[plugin.name];
    if (seed === undefined) return [];
    const design: LifecycleDesign = {
      id: `seed/${plugin.name}`,
      commands: plugin.commands,
      size: 0,
      build: seed.build,
      ...(seed.ctx === undefined ? {} : { context: seed.ctx }),
    };
    return [design];
  });
  return [...loadDesigns().map(planDesign), ...extra, ...seeds];
}

/** Plugins with a document extension and at least one command that no design exercises (a plugin without commands has no way to create its slice). */
export function uncoveredPlugins(designs: readonly LifecycleDesign[]): string[] {
  return documentPlugins()
    .filter(
      (plugin) => plugin.commands.size > 0 && !designs.some((design) => [...plugin.commands].some((name) => design.commands.has(name))),
    )
    .map((plugin) => plugin.name);
}
