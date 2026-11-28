/**
 * THE binding performance budgets of llull (docs/decisions/PERF1-performance-budgets.md §3). Wall-clock milliseconds on the reference
 * machine; `npm run perf` fails when a scenario is over its budget. A budget is only ever lowered: raising one is an owner decision
 * recorded in PERF1. `baselineMs` is what the scenario cost before the PERF1 work (null = the scenario did not exist or was not measured).
 */

/** PERF1 §1: `instant` = direct manipulation (100 ms), `responsive` = a read or a refresh (1 s), `job` = llull's own share of a long run. */
type BudgetClass = 'instant' | 'responsive' | 'job';

interface Budget {
  readonly title: string;
  readonly class: BudgetClass;
  readonly budgetMs: number;
  readonly baselineMs: number | null;
}

const budget = (klass: BudgetClass, budgetMs: number, baselineMs: number | null, title: string): Budget => ({
  title,
  class: klass,
  budgetMs,
  baselineMs,
});

export const BUDGETS = {
  'fea.mesh.record': budget('responsive', 700, 1420, 'store + summarise + record a 47k C3D10 / 68k node mesh (fea_mesh after the mesher)'),
  'fea.solve.overhead': budget('job', 2000, 5300, 'fea_solve on that mesh without the solver process: deck, FRD read, store, record'),
  'fea.query.cold': budget('responsive', 700, 2100, 'first analysis_report of a process on the solved case (CLI --doc)'),
  'fea.query.analysis_report': budget('instant', 100, 1530, 'analysis_report again in the same process (desktop backend)'),
  'fea.query.fea_result_field': budget('instant', 100, 1345, 'fea_result_field at a point, same process'),
  'fea.query.describe_analysis': budget('instant', 100, 1318, 'describe_analysis, same process'),
  'fea.query.compute_margins': budget('responsive', 200, 2177, 'compute_margins over 68k nodes, same process'),
  'fea.query.check_analysis': budget('responsive', 300, 3782, 'check_analysis, same process'),
  'fea.map.nodal68k': budget(
    'job',
    2500,
    8860,
    'mapNodalField (TypeScript, no llull-compute) of a 68k-node C3D10 field onto the same mesh',
  ),
  'dynamics.simulate.servo_arms': budget('job', 6000, 10400, 'simulate_motion 10 s, 50 bodies / 40 joints / 40 speed motors'),
  'dynamics.simulate.closed_loops': budget(
    'job',
    9000,
    15600,
    'simulate_motion 2 s, 8 slider-cranks (24 bodies, 8 closed loops) at 600 rpm',
  ),
  'dynamics.clearance.cranks3': budget('job', 7000, 29000, 'check_motion_clearance, 63 pairs x 361 samples, native distance engine'),
  'dynamics.clearance.cranks3_ts': budget(
    'job',
    20000,
    39000,
    'check_motion_clearance, 63 pairs x 361 samples, TypeScript meshBvh (no native engine)',
  ),
  'explicit.run.hex10k': budget('job', 20000, 77000, 'explicit_run, 10 240 hex8, 1 206 cycles (native llull-compute, 4 threads)'),
  'thermal.viewfactor.reciprocal3k': budget(
    'job',
    3000,
    24300,
    "compute_view_factors integration='reciprocal', closed 3 072-facet cube cavity, native llull-compute (before: the full rule)",
  ),
  'thermal.viewfactor.reciprocal3k_obstructed': budget(
    'job',
    5000,
    27900,
    "the same with obstruction and a baffle, integration='reciprocal' (before: the full rule)",
  ),
  'implicit.create.gyroid7m': budget(
    'job',
    20000,
    10170,
    'create_implicit_body, 7.3M-triangle gyroid sheet (124^3 grid, native field engine, mesh asset store)',
  ),
  'implicit.check.gyroid7m': budget('job', 4000, 5410, 'check_implicit of that body with wall and overhang limits, same process'),
  'implicit.properties.gyroid7m': budget('responsive', 1000, 1262, 'implicit_properties of that body, same process'),
  'document.command.draft20k': budget('instant', 100, null, 'draw_polyline + state hash on a 20 000-entity drawing'),
  'document.hash.mesh300k': budget('instant', 100, 780, 'state hash after a 300k-triangle mesh entity changed'),
  'document.save.incremental': budget('instant', 100, null, 'autosave text of a 20 000-entity document after one command'),
  'document.regenerate.late_edit': budget('responsive', 200, 1200, 'edit_step_params on the last of 2 000 steps'),
  'document.export.svg20k': budget('responsive', 400, 2100, 'export_svg of 20 000 2D entities'),
  'document.export.dxf20k': budget('responsive', 600, 3600, 'export_dxf of 20 000 2D entities'),
  'mesh.import.stl1m': budget('job', 3000, 6300, 'import_mesh_file of a 1M-triangle binary STL through the mesh asset store (fileKey)'),
  // provisional, reset from a quiet machine (measured at load 5-8 only). The first-frame budget sits above the 300 ms the per-frame job path
  // took, so it guards no regression yet: it only bounds the process start.
  'render.view.native1280_first': budget(
    'responsive',
    500,
    300,
    "render_view renderer='native' 1280 x 720, 36 parts: the first frame of a host (raster process start included)",
  ),
  'render.view.native1280_warm': budget(
    'responsive',
    300,
    300,
    "render_view renderer='native' 1280 x 720, 36 parts, on the running raster process",
  ),
  'mesh.import.obj1m': budget('job', 3000, 4400, 'import_mesh_file of a 1M-triangle OBJ through the mesh asset store (fileKey)'),
  'render.realistic.first256': budget(
    'job',
    1000,
    null,
    'render_realistic of the balls-uniform reference scene at 256 x 256, 16 samples: scene build, job files, native process start',
  ),
  'render.realistic.instances1m': budget(
    'job',
    7000,
    null,
    'add_instance_array of 1,000,000 box members + render_realistic 256 x 256, 4 samples (two-level BVH, no expansion)',
  ),
  // the guard counts the array members first (sceneGeometry arraysSurelyOverBudget) and refuses before placing any: 7 ms measured
  'render.realistic.refuse_too_large': budget(
    'instant',
    100,
    null,
    'render_realistic refusing 8,000,001 placed parts (RENDER_SCENE_TOO_LARGE)',
  ),
  'render.realistic.texture_budget': budget(
    'instant',
    100,
    null,
    'import_texture of 16 x 8192^2 PNGs (4 GiB decoded): 4 accepted, 12 refused TEXTURE_BUDGET_EXCEEDED',
  ),
} as const satisfies Record<string, Budget>;

export type BudgetId = keyof typeof BUDGETS;

interface MemoryBudget {
  readonly title: string;
  /** Ceiling in MiB (not scaled by the machine factor); lowered only, like the time budgets. */
  readonly budgetMiB: number;
}

/** Peak memory ceilings (PERF1 §3, RV1 §7 V4): native = peak RSS of the llull-compute job, host = growth of the Node process's max RSS. */
export const MEMORY_BUDGETS = {
  'render.realistic.instances1m.native': { title: 'llull-compute pathtrace peak RSS, 1,000,000 instances at 256 x 256', budgetMiB: 400 },
  'render.realistic.instances1m.host': { title: 'host max-RSS growth building and sending that scene', budgetMiB: 450 },
  // refused before any member is placed: 0 MiB measured
  'render.realistic.refuse_too_large.host': { title: 'host max-RSS growth while refusing 8,000,001 placed parts', budgetMiB: 64 },
} as const satisfies Record<string, MemoryBudget>;

export type MemoryBudgetId = keyof typeof MEMORY_BUDGETS;
