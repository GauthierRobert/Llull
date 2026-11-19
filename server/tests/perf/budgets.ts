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
} as const satisfies Record<string, Budget>;

export type BudgetId = keyof typeof BUDGETS;
