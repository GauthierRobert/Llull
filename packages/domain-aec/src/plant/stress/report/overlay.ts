/**
 * render_view `overlay: "pipe_stress"` (07 PST M4, AF-22): the elements of every stress model coloured by their code stress ratio, drawn over an orthographic render.
 * Ratio colours: green below 0.8, amber from 0.8 to 1, red above 1; grey for an element with no stress station (no code case covers it).
 * @invariant pure query of the current document: the models are re-analysed, never read from the record; a model that cannot be analysed is listed in `detail.skipped` with its PST code and not drawn
 */

import type { RenderOverlay } from '@core/model/renderOverlay';
import { escapeXml } from '@lib/escapeXml';
import { analyzeStressModel } from '../analysis';
import { modelGeometry } from '../model/geometry';
import { getStress } from '../model/store';

export const RATIO_COLORS = { ok: '#35c759', warn: '#ffb020', over: '#ff3b30', none: '#8a8a99' } as const;
export type RatioBand = keyof typeof RATIO_COLORS;

/** Band of the governing ratio of an element (null = no stress station). */
export const bandOf = (ratio: number | null): RatioBand => (ratio === null ? 'none' : ratio > 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok');

export const pipeStressOverlay: RenderOverlay = {
  kind: 'pipe_stress',
  draw: (doc, view) => {
    const stress = getStress(doc);
    const svg: string[] = [];
    const entities: string[] = [];
    const models: Record<string, unknown>[] = [];
    const skipped: { modelId: string; code: string; message: string }[] = [];
    let lines = 0;
    for (const modelId of stress.modelOrder) {
      const model = stress.models[modelId];
      if (model === undefined) continue;
      const analysis = analyzeStressModel(doc, model);
      if (!analysis.ok) {
        skipped.push({ modelId, code: analysis.code, message: analysis.message });
        continue;
      }
      const worst = new Map<string, number>();
      for (const row of analysis.stress.rows) worst.set(row.element, Math.max(worst.get(row.element) ?? 0, row.ratio));
      const counts: Record<RatioBand, number> = { ok: 0, warn: 0, over: 0, none: 0 };
      const body: string[] = [];
      let maxRatio = 0;
      for (const element of modelGeometry(analysis.built).elements) {
        if (view.only !== undefined && !view.only.includes(element.pipeId)) continue;
        const [a, b] = element.pointsMm;
        const ratio = worst.get(element.id) ?? null;
        const band = bandOf(ratio);
        counts[band]++;
        maxRatio = Math.max(maxRatio, ratio ?? 0);
        const [x1, y1] = view.project(a);
        const [x2, y2] = view.project(b);
        const r2 = (n: number): number => Math.round(n * 100) / 100;
        body.push(
          `    <line x1="${r2(x1)}" y1="${r2(y1)}" x2="${r2(x2)}" y2="${r2(y2)}" stroke="${RATIO_COLORS[band]}" data-element="${escapeXml(element.id)}" data-pipe="${escapeXml(element.pipeId)}" data-ratio="${ratio === null ? '' : ratio.toFixed(3)}"/>`,
        );
        if (!entities.includes(element.pipeId)) entities.push(element.pipeId);
      }
      if (body.length === 0) continue;
      lines += body.length;
      models.push({ modelId, elements: body.length, ...counts, maxRatio: Number(maxRatio.toFixed(3)), status: analysis.status });
      svg.push(
        `  <g class="pipe-stress-overlay" data-model="${escapeXml(modelId)}" stroke-width="5" stroke-linecap="round" opacity="0.9">`,
        ...body,
        '  </g>',
      );
    }
    return { svg, stats: { entities, lines, points: 0, detail: { models, skipped } } };
  },
};
