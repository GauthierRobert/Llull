import type { ToolCall } from '../contract';
import type { CivilIntent } from './intent';

/**
 * @layer tests/production/civil
 *
 * The tool calls a competent civil engineer makes for the site job, on an empty document. Ids it
 * refers to (`surface-1`, `platform-1`, `alignment-1`, `manhole-n`) are the ones llull mints in
 * creation order.
 */
export function civilScript(intent: CivilIntent): ToolCall[] {
  const { pad, road, drainage } = intent;
  const calls: ToolCall[] = [
    { tool: 'set_units', args: { units: 'm' } },
    { tool: 'set_project_info', args: { ...intent.project } },
    {
      tool: 'import_survey_points',
      args: { name: 'Survey', text: intent.surveyText, format: 'PENZD', sourceUnit: 'm' },
    },
    { tool: 'create_surface', args: { name: 'EG', contourInterval: 0.5, majorEvery: 5 } },
    { tool: 'surface_report', args: { surfaceId: 'surface-1' } },
    {
      tool: 'add_platform',
      args: {
        surfaceId: 'surface-1',
        name: pad.name,
        boundary: pad.boundary,
        elevation: 110,
        cutSlope: pad.cutSlope,
        fillSlope: pad.fillSlope,
      },
    },
    { tool: 'balance_platform', args: { platformId: 'platform-1', swellFactor: pad.swellFactor } },
    {
      tool: 'add_alignment',
      args: {
        name: road.name,
        points: road.points,
        radii: road.radii,
        spirals: road.spirals,
        stationInterval: road.stationInterval,
        surfaceId: 'surface-1',
      },
    },
    { tool: 'set_alignment_profile', args: { alignmentId: 'alignment-1', pvis: road.pvis } },
    {
      tool: 'set_road_section',
      args: {
        alignmentId: 'alignment-1',
        laneWidth: road.laneWidth,
        shoulderWidth: road.shoulderWidth,
        crossfall: road.crossfall,
      },
    },
    {
      tool: 'set_superelevation',
      args: { alignmentId: 'alignment-1', maxRate: road.maxSuperelevation },
    },
    {
      tool: 'alignment_report',
      args: { alignmentId: 'alignment-1', designSpeedKmh: road.designSpeedKmh },
    },
  ];
  for (const manhole of drainage.manholes) {
    calls.push({
      tool: 'add_manhole',
      args: {
        name: manhole.name,
        location: manhole.location,
        invertElevation: manhole.invert,
        surfaceId: 'surface-1',
        ...(manhole.catchment
          ? {
              catchmentAreaHa: manhole.catchment.areaHa,
              runoffCoefficient: manhole.catchment.runoffCoefficient,
            }
          : {}),
      },
    });
  }
  for (const [from, to] of drainage.pipes) {
    calls.push({
      tool: 'add_pipe',
      args: {
        fromId: `manhole-${from + 1}`,
        toId: `manhole-${to + 1}`,
        manningN: drainage.manningN,
      },
    });
  }
  calls.push(
    {
      tool: 'size_drainage_pipes',
      args: {
        idf: drainage.idf,
        minVelocity: drainage.minVelocity,
        diameters: drainage.diametersMm,
      },
    },
    {
      tool: 'check_drainage_network',
      args: {
        idf: drainage.idf,
        outfallLevel: drainage.outfallLevel,
        minCoverM: drainage.minCoverM,
        minVelocity: drainage.minVelocity,
      },
    },
    {
      tool: 'export_plan_profile_sheet',
      args: { alignmentId: 'alignment-1', paper: intent.sheetPaper },
    },
    { tool: 'export_landxml', args: { date: intent.project.date } },
  );
  return calls;
}
