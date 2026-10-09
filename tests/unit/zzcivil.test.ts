import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
const O = [1000, 5000];
const p = (x: number, y: number) => [O[0]! + x, O[1]! + y];
it('civil', () => {
  const text = readFileSync('public/samples/pilot-site-survey.csv', 'utf8');
  const idf = { a: 1000, b: 10, c: 0.8 };
  const actions = [
    { command: 'set_units', params: { units: 'm' } },
    { command: 'import_survey_points', params: { name: 'Pilot survey', text, format: 'PENZD', sourceUnit: 'm' } },
    { command: 'create_surface', params: { name: 'EG', contourInterval: 0.5, majorEvery: 5 } },
    { command: 'add_platform', params: { surfaceId: 'surface-1', name: 'Building pad', boundary: [p(150,110),p(200,110),p(200,150),p(150,150)], elevation: 110.5 } },
    { command: 'balance_platform', params: { platformId: 'platform-1', swellFactor: 1.1 } },
    { command: 'add_alignment', params: { name: 'Access road', points: [p(110,5),p(175,35),p(170,105)], radii: [60], spirals: [40], stationInterval: 10, surfaceId: 'surface-1' } },
    { command: 'set_alignment_profile', params: { alignmentId: 'alignment-1', pvis: [{station:0,elevation:103.1},{station:70,elevation:105.7,curveLength:40},{station: 128, elevation: 109.4}] } },
    { command: 'set_road_section', params: { alignmentId: 'alignment-1', laneWidth: 3, shoulderWidth: 1, crossfall: 0.025 } },
    { command: 'set_superelevation', params: { alignmentId: 'alignment-1', maxRate: 0.06 } },
    { command: 'add_manhole', params: { name: 'MH1', location: p(178,100), invertElevation: 107.0, surfaceId: 'surface-1', catchmentAreaHa: 0.2, runoffCoefficient: 0.9 } },
    { command: 'add_manhole', params: { name: 'MH2', location: p(180,40), invertElevation: 104.3, surfaceId: 'surface-1', catchmentAreaHa: 0.12, runoffCoefficient: 0.85 } },
    { command: 'add_manhole', params: { name: 'MH3', location: p(120,12), invertElevation: 101.8, surfaceId: 'surface-1', catchmentAreaHa: 0.6, runoffCoefficient: 0.4 } },
    { command: 'add_manhole', params: { name: 'Outfall', location: p(72,12), invertElevation: 100.6, surfaceId: 'surface-1' } },
    { command: 'add_pipe', params: { fromId: 'manhole-1', toId: 'manhole-2' } },
    { command: 'add_pipe', params: { fromId: 'manhole-2', toId: 'manhole-3' } },
    { command: 'add_pipe', params: { fromId: 'manhole-3', toId: 'manhole-4' } },
    { command: 'size_drainage_pipes', params: { idf, minVelocity: 0.6 } },
  ];
  const r = execute(createEmptyDocument(), 'build_project', { actions });
  console.log(r.summary.slice(0, 3000));
  const d = r.document;
  const al = d.civil?.order.length;
  console.log('civil objects', al, Object.keys(d.entities).length);
  for (const c of ['alignment_report']) {
    const rr = execute(d, c, { alignmentId: 'alignment-1', designSpeedKmh: 40 });
    const data = rr.data as any;
    console.log(rr.summary, JSON.stringify(data.checks ?? data.designChecks ?? Object.keys(data)).slice(0, 1500));
  }
  const ch = execute(d, 'check_drainage_network', { idf, outfallLevel: 100.75 });
  console.log(ch.summary, JSON.stringify((ch.data as any).pipes).slice(0, 2500), JSON.stringify((ch.data as any).manholes).slice(0,1500));
  console.log(execute(d, 'balance_platform', { platformId: 'platform-1', swellFactor: 1.1 }).summary);
  const lx = execute(d, 'export_landxml', {});
  console.log(lx.summary, ((lx.data as any).text as string).length);
  const pp = execute(d, 'export_plan_profile_sheet', { alignmentId: 'alignment-1' });
  console.log(pp.summary);
});
