/**
 * export_drainage_long_section: SVG long section of a pipe run with the hydraulic grade line.
 * @layer domain-aec/civil
 */

import type { CivilModel, PipeObject } from '@core/model/civil';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { safeFileName } from '@lib/safeFileName';
import { toMetres, toMm } from '../model';
import { civilObject, civilObjectsOf, getCivil } from './model';
import { criteriaFrom, idfField, intensityField } from './drainageAnalysisCommands';
import { computeFlows } from './drainageFlow';
import { computeHgl } from './drainageHgl';
import { pipePlanLength, pipeSlope } from './drainageTopology';
import { drainageLongSectionSvg, type RunSegment, type RunStation } from './drainageLongSectionSvg';

/** Pipes from `fromId` to `toId` (any route), or the main run (largest pipe at each fork) to an outfall. */
function runPipes(civil: CivilModel, fromId: string, toId: string | undefined): PipeObject[] {
  const pipes = civilObjectsOf(civil, 'pipe');
  const search = (id: string, seen: ReadonlySet<string>): PipeObject[] | null => {
    if (id === toId) return [];
    if (seen.has(id)) return null;
    for (const pipe of pipes.filter((p) => p.fromId === id)) {
      const rest = search(pipe.toId, new Set([...seen, id]));
      if (rest) return [pipe, ...rest];
    }
    return null;
  };
  if (toId !== undefined) return search(fromId, new Set()) ?? [];
  const run: PipeObject[] = [];
  let current = fromId;
  for (;;) {
    const next = pipes
      .filter((p) => p.fromId === current)
      .sort((a, b) => b.diameter - a.diameter || a.id.localeCompare(b.id))[0];
    if (!next) return run;
    run.push(next);
    current = next.toId;
  }
}

/**
 * @command export_drainage_long_section
 * @pure
 * @affects none (read-only)
 * @failure unknown manholes / no connecting run / bad criteria -> no-op
 */
export const exportDrainageLongSection = defineCommand({
  name: 'export_drainage_long_section',
  description:
    'Long section of a drainage pipe run as SVG text in `data.text` (`data.fileName`): ground (rim) ' +
    'line, manholes with labels, pipe invert and obvert, the hydraulic grade line (same method as ' +
    'check_drainage_network) and a table band of chainage, rim, invert, pipe (diameter, slope, length) ' +
    'and HGL. The run starts at `fromManholeId` and ends at `toManholeId`, or, when omitted, follows the ' +
    'largest pipe at each fork down to the outfall. Returns data { text, fileName, pipeIds, manholeIds }.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    fromManholeId: z
      .string()
      .describe('Upstream manhole id where the run starts, e.g. "manhole-1".'),
    toManholeId: z
      .string()
      .optional()
      .describe(
        'Downstream manhole id where the run ends. Default: follow the main run to the outfall.',
      ),
    rainfallIntensityMmH: intensityField,
    idf: idfField,
    outfallLevel: z
      .number()
      .optional()
      .describe(
        'Tailwater elevation at the outfall(s), document units. Default: outlet normal depth.',
      ),
    manholeLossK: z.number().optional().describe('Manhole loss coefficient K (>= 0). Default 0.5.'),
    freeboardM: z
      .number()
      .optional()
      .describe('Flooding freeboard below rim in metres. Default 0.3.'),
  }),
  run: (doc, params): CommandResult => {
    const criteria = criteriaFrom(params);
    if (typeof criteria === 'string') {
      return noop(doc, `export_drainage_long_section failed: ${criteria}`);
    }
    const civil = getCivil(doc);
    const start = civilObject(civil, params.fromManholeId, 'manhole');
    if (!start) {
      return noop(doc, `export_drainage_long_section failed: no manhole ${params.fromManholeId}.`);
    }
    if (params.toManholeId !== undefined && !civilObject(civil, params.toManholeId, 'manhole')) {
      return noop(doc, `export_drainage_long_section failed: no manhole ${params.toManholeId}.`);
    }
    const run = runPipes(civil, start.id, params.toManholeId);
    if (run.length === 0) {
      return noop(
        doc,
        `export_drainage_long_section failed: no pipe run from ${start.id}` +
          (params.toManholeId ? ` to ${params.toManholeId}.` : ' (it has no outgoing pipe).'),
      );
    }
    const flows = computeFlows(doc, civil, criteria);
    const hgl = computeHgl(doc, civil, criteria, flows);
    const stations: RunStation[] = [];
    const segments: RunSegment[] = [];
    let chainage = 0;
    const ids = [start.id, ...run.map((pipe) => pipe.toId)];
    ids.forEach((id, index) => {
      const manhole = civilObject(civil, id, 'manhole');
      const pipe = run[index] ?? run[index - 1];
      if (!manhole || !pipe) return;
      const outgoing = run[index];
      const level = hgl.manholes.get(id);
      stations.push({
        id,
        name: manhole.name,
        chainageM: chainage,
        rimM: toMetres(doc, manhole.rimElevation),
        invertM: toMetres(doc, outgoing ? outgoing.invertFrom : pipe.invertTo),
        hglM: level?.hglM ?? 0,
        flooding: level?.flooding ?? false,
      });
      if (!outgoing) return;
      const lengthM = toMetres(doc, pipePlanLength(civil, outgoing) ?? 0);
      const result = hgl.pipes.get(outgoing.id);
      segments.push({
        id: outgoing.id,
        diameterMm: Math.round(toMm(doc, outgoing.diameter)),
        lengthM,
        slopePct: pipeSlope(civil, outgoing) * 100,
        startM: chainage,
        endM: chainage + lengthM,
        invertUpM: toMetres(doc, outgoing.invertFrom),
        invertDownM: toMetres(doc, outgoing.invertTo),
        hglUpM: result?.hglUpM ?? 0,
        hglDownM: result?.hglDownM ?? 0,
        surcharged: result?.surcharged ?? false,
      });
      chainage += lengthM;
    });
    const text = drainageLongSectionSvg(
      `${start.name} to ${civilObject(civil, ids[ids.length - 1] ?? '', 'manhole')?.name ?? ''}`,
      stations,
      segments,
    );
    const fileName = `${safeFileName(start.name, start.id)}_drainage_long_section.svg`;
    return {
      document: doc,
      summary:
        `Drainage long section ${start.id} to ${ids[ids.length - 1]}: ${segments.length} pipe(s), ` +
        `${chainage.toFixed(1)} m, ${segments.filter((s) => s.surcharged).length} surcharged, ` +
        `${stations.filter((s) => s.flooding).length} flooding manhole(s); ${fileName} (${text.length} bytes).`,
      affected: [],
      data: { text, fileName, pipeIds: run.map((p) => p.id), manholeIds: ids },
    };
  },
});
