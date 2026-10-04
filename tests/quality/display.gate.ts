import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installDefaultPlugins } from '@app/plugins';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence';
import type { CadDocument } from '@core/model/types';
import { plans, type GoldenAction } from '../golden/plans';
import { runPlan } from '../golden/runPlan';
import { aspectOf, isFramed, shootCanvas, silhouette, type Silhouette } from './silhouette';

/**
 * @layer tests/quality
 *
 * Display quality gate: every corpus document is opened in the real app (offline mode) and must
 * render without console / page / WebGL errors, unstretched, visible, framed, with the on-screen
 * aspect ratio of its bounding box (no deformation). The silhouette is the pixel diff between a
 * shot and the same camera with every layer hidden. 3D documents are framed by the `fit_view`
 * command (top view), then the UI "Fit all" and "Top" buttons are checked; 2D uses zoom-extents.
 * Corpus: STEP files imported by `npm run quality:step` + native documents from golden plans.
 *
 *   npm run quality:display        # after quality:step; QUALITY_TIER=smoke|full|stress
 *
 * @invariant a check listed in knownIssues must FAIL (ratchet: a fix forces removing it)
 */

type CheckId =
  | 'errors'
  | 'stretch'
  | 'visible'
  | 'framed'
  | 'aspect'
  | 'fit-all-button'
  | 'top-view-button';
type View = '2D' | '3D';

interface DisplayCase {
  id: string;
  view: View;
  document: CadDocument;
  knownIssues: CheckId[];
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(ROOT, '.cache', 'quality-corpus');
const REPORT_FILE = path.join(CORPUS_DIR, 'reports', 'display.json');
const TIERS = ['smoke', 'full', 'stress'];
const TIER = process.env['QUALITY_TIER'] ?? 'full';
if (!TIERS.includes(TIER)) throw new Error(`QUALITY_TIER must be one of ${TIERS.join(', ')}`);
/** Perspective (3D) projects depth unevenly; the orthographic 2D view must be near exact. */
const ASPECT_TOLERANCE: Record<View, number> = { '3D': 0.15, '2D': 0.03 };
const MIN_FILL = 0.02;
/** Offline mode probes the optional llull server (architecture L6); a refused probe is expected. */
const OPTIONAL_SERVER = 'http://localhost:3001';
const NATIVE: Record<View, string[]> = {
  '2D': [
    '2d_lines_polylines',
    '2d_arcs_circles',
    '2d_rectangles',
    '2d_spline_ellipse',
    '2d_text_dimensions',
    'modify2d_offset_trim_extend',
    'modify2d_fillet_chamfer_explode',
  ],
  '3D': [
    '3d_box_cylinder_sphere',
    '3d_cone_torus_wedge_pyramid',
    'extrude_sketch_and_profile',
    'revolve_profile',
    'gears_spur_and_belt',
    'building_house_template',
  ],
};
/** Native-document checks expected to fail today (same ratchet as quality/corpus.json). */
const NATIVE_KNOWN_ISSUES: Record<string, CheckId[]> = {
  '2d_arcs_circles': ['aspect'],
  '2d_text_dimensions': ['aspect'],
  '3d_box_cylinder_sphere': ['top-view-button'],
  '3d_cone_torus_wedge_pyramid': ['fit-all-button', 'top-view-button'],
  extrude_sketch_and_profile: ['fit-all-button', 'top-view-button'],
  revolve_profile: ['fit-all-button'],
  gears_spur_and_belt: ['fit-all-button', 'top-view-button'],
  building_house_template: ['fit-all-button', 'top-view-button'],
};

interface StepEntry {
  id: string;
  format: string;
  tier: string;
  knownIssues: string[];
  displayKnownIssues?: CheckId[];
}

/** STEP entries of the selected tier whose import is expected to produce a document. */
function stepEntries(): StepEntry[] {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'quality', 'corpus.json'), 'utf8')) as {
    files: StepEntry[];
  };
  return manifest.files.filter(
    (entry) =>
      entry.format === 'step' &&
      TIERS.indexOf(entry.tier) <= TIERS.indexOf(TIER) &&
      !entry.knownIssues.includes('imports') &&
      !entry.knownIssues.includes('save-load'),
  );
}

function stepDocument(entry: StepEntry): string {
  return path.join(CORPUS_DIR, 'docs', `${entry.id}.llull.json`);
}

function stepCases(): DisplayCase[] {
  return stepEntries()
    .filter((entry) => existsSync(stepDocument(entry)))
    .map((entry) => ({
      id: `step/${entry.id}`,
      view: '3D' as const,
      document: deserializeDocument(readFileSync(stepDocument(entry), 'utf8')),
      knownIssues: entry.displayKnownIssues ?? [],
    }));
}

function planNamed(name: string): GoldenAction[] {
  const plan = plans[name];
  if (plan === undefined) throw new Error(`no golden plan named ${name}`);
  return plan;
}

function nativeCases(): DisplayCase[] {
  return (['2D', '3D'] as const).flatMap((view) =>
    NATIVE[view].map((name) => ({
      id: `native/${name}`,
      view,
      document: runPlan(planNamed(name)).document,
      knownIssues: NATIVE_KNOWN_ISSUES[name] ?? [],
    })),
  );
}

/** Run a fixture-preparation command; a rejected command would silently void the measurement. */
function apply(doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument {
  const result = execute(doc, name, params);
  if (result.document === doc) throw new Error(`fixture: ${result.summary}`);
  return result.document;
}

/** 3D documents are framed from the top by the `fit_view` command (what an MCP agent calls). */
function prepared(displayCase: DisplayCase): string {
  if (displayCase.view === '2D') return serializeDocument(displayCase.document);
  return serializeDocument(apply(displayCase.document, 'fit_view', { direction: 'top' }));
}

/** World-space X / Y extent ratio — what a top-down view must show. */
function expectedAspect(doc: CadDocument): number | null {
  const data = execute(doc, 'measure_bounding_box', {}).data as
    | { size: [number, number, number] }
    | undefined;
  if (!data || data.size[0] <= 0 || data.size[1] <= 0) return null;
  return data.size[0] / data.size[1];
}

/** Merge one case into the report file (Playwright restarts the worker after a failure). */
function record(id: string, metrics: Record<string, unknown>): void {
  const previous = existsSync(REPORT_FILE)
    ? (JSON.parse(readFileSync(REPORT_FILE, 'utf8')) as { cases: Record<string, unknown> }).cases
    : {};
  const cases = { ...previous, [id]: metrics };
  writeFileSync(REPORT_FILE, JSON.stringify({ tier: TIER, cases }, null, 2));
}

/**
 * Hide every layer shown in the viewport (local view state, camera untouched).
 * @returns a function that shows exactly those layers again
 */
async function hideVisibleLayers(page: Page): Promise<() => Promise<void>> {
  const toggles = page.locator('.layer-visibility-btn');
  const hidden: number[] = [];
  for (let index = 0; index < (await toggles.count()); index += 1) {
    if ((await toggles.nth(index).getAttribute('aria-pressed')) !== 'true') continue;
    await toggles.nth(index).click();
    hidden.push(index);
  }
  return async () => {
    for (const index of hidden) await toggles.nth(index).click();
  };
}

/** Silhouette = pixels that change when every layer is hidden, from the current camera. */
async function measure(page: Page, canvas: Locator, imageFile?: string): Promise<Silhouette> {
  const shot = await shootCanvas(page, canvas);
  if (imageFile !== undefined) {
    mkdirSync(path.dirname(imageFile), { recursive: true });
    writeFileSync(imageFile, shot);
  }
  const restore = await hideVisibleLayers(page);
  const baseline = await shootCanvas(page, canvas);
  await restore();
  return silhouette(page, shot, baseline);
}

installDefaultPlugins();
const cases = [...stepCases(), ...nativeCases()];

test.describe('display quality gate', () => {
  test('the STEP corpus has been imported (npm run quality:step)', () => {
    // Runs once per run (beforeAll would re-run in every worker Playwright restarts).
    mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
    writeFileSync(REPORT_FILE, JSON.stringify({ tier: TIER, cases: {} }));
    const missing = stepEntries().filter((entry) => !existsSync(stepDocument(entry)));
    expect(stepEntries().length).toBeGreaterThan(0);
    expect(missing.map((entry) => entry.id)).toEqual([]);
  });

  for (const displayCase of cases) {
    test(`${displayCase.id} renders without errors or deformation`, async ({ page }) => {
      const problems: string[] = [];
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        if (message.location().url.startsWith(OPTIONAL_SERVER)) return;
        problems.push(`console: ${message.text()}`);
      });
      page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
      await page.addInitScript(() => {
        window.addEventListener('webglcontextlost', () => console.error('webglcontextlost'), true);
      });
      await page.goto('/');
      await page.evaluate(() => window.localStorage.clear());
      await page.reload();

      // Open the Layers panel first: the canvas keeps one size for every screenshot.
      const showPanel = page.getByRole('button', { name: 'Show browser panel' });
      if (await showPanel.isVisible()) await showPanel.click();
      const layersTab = page.locator('#sidebar-tab-layers');
      if ((await layersTab.getAttribute('aria-selected')) !== 'true') await layersTab.click();
      await expect(page.getByRole('list', { name: 'Layer list' })).toBeVisible();
      const started = Date.now();
      await page.locator('[aria-label="Project file"] input[type="file"]').setInputFiles({
        name: `${displayCase.id.replace('/', '-')}.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(prepared(displayCase)),
      });
      await expect(page.getByLabel(/^Last command: Loaded document/)).toBeVisible({
        timeout: 120_000,
      });
      if (displayCase.view === '2D') {
        await page.getByRole('button', { name: '2D', exact: true }).click();
      }
      const canvas = page.locator(
        displayCase.view === '3D' ? '.viewport-3d-wrapper canvas' : '.viewport-2d-wrapper canvas',
      );
      await expect(canvas).toBeVisible();
      const buffer = await canvas.evaluate((element) => {
        const node = element as HTMLCanvasElement;
        const box = node.getBoundingClientRect();
        return { aspect: node.width / node.height, cssAspect: box.width / box.height };
      });
      const imageFile = path.join(path.dirname(REPORT_FILE), 'display', `${displayCase.id}.png`);
      const shape = await measure(page, canvas, imageFile);
      const loadMs = Date.now() - started;

      const expected = expectedAspect(displayCase.document);
      const framed = isFramed(shape, MIN_FILL);
      const aspectError =
        shape.rect === null || expected === null
          ? null
          : Math.abs(aspectOf(shape.rect) / expected - 1);
      const results: Partial<Record<CheckId, boolean>> = {
        errors: problems.length === 0,
        stretch: Math.abs(buffer.aspect / buffer.cssAspect - 1) <= 0.01,
        visible: shape.pixels >= shape.canvasWidth * shape.canvasHeight * 0.0005,
        framed,
      };
      // Aspect is only meaningful for a whole, framed silhouette.
      if (framed && aspectError !== null) {
        results.aspect = aspectError <= ASPECT_TOLERANCE[displayCase.view];
      }
      if (displayCase.view === '3D') {
        await page.getByRole('button', { name: 'Fit all into view' }).click();
        results['fit-all-button'] = isFramed(await measure(page, canvas), MIN_FILL);
        await page.getByRole('button', { name: 'Top view' }).click();
        results['top-view-button'] = isFramed(await measure(page, canvas), MIN_FILL);
      }
      const metrics = { loadMs, rect: shape.rect, expected, aspectError, results, problems };
      record(displayCase.id, metrics);

      const failed = Object.entries(results)
        .filter(([, ok]) => !ok)
        .map(([id]) => id as CheckId);
      const unexpectedFailures = failed.filter((id) => !displayCase.knownIssues.includes(id));
      // A known issue that passed, or that no longer runs for this case, is stale.
      const fixedKnownIssues = displayCase.knownIssues.filter((id) => results[id] !== false);
      expect({ unexpectedFailures, fixedKnownIssues }, JSON.stringify(metrics)).toEqual({
        unexpectedFailures: [],
        fixedKnownIssues: [],
      });
    });
  }
});
