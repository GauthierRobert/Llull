import type { CivilIntent } from './intent';

/**
 * @layer tests/production/civil
 *
 * Renders the civil intent as the brief a lead engineer hands to a designer: the survey file, the
 * layout decisions (pad outline, road PIs and design speed, manhole positions and catchments), the
 * design storm and the deliverables. Levels, profile and inverts are left to the designer — the
 * acceptance criteria check the outcome.
 */

const xy = ([e, n]: readonly number[]): string => `(${e}, ${n})`;

export function civilBrief(intent: CivilIntent): string {
  const { pad, road, drainage } = intent;
  return [
    `# ${intent.project.name} — site development: earthworks, access road, storm drainage`,
    '',
    `Client: ${intent.project.client}. Drawing number ${intent.project.drawingNumber}, revision ${intent.project.revision}, date ${intent.project.date}.`,
    'Units: metres. Coordinates: local site grid (easting, northing), levels in metres above the site datum.',
    '',
    '## Survey',
    `The surveyor's topographic survey (${intent.surveyFile}, PENZD: point, easting, northing, level, code) is below. Import it, build the existing-ground model from every point.`,
    '```csv',
    intent.surveyText.trim(),
    '```',
    '',
    '## Building pad',
    `- Outline ${pad.boundary.map(xy).join(' → ')}; batters ${pad.cutSlope}H:1V in cut, ${pad.fillSlope}H:1V in fill.`,
    `- Set the pad level so the earthworks balance on site with a swell factor of ${pad.swellFactor} (cut × ${pad.swellFactor} = fill, residual below 1 %).`,
    '',
    '## Access road',
    `- "${road.name}" through the PIs ${road.points.map(xy).join(' → ')}, curve radius ${road.radii.join(', ')} m with clothoid transitions of ${road.spirals.join(', ')} m each side, stations every ${road.stationInterval} m.`,
    `- Design speed ${road.designSpeedKmh} km/h; maximum grade ${road.maxGrade * 100} %; the road report must show no design-check failure at that speed.`,
    `- Template: ${road.laneWidth} m lane and ${road.shoulderWidth} m shoulder each side, crossfall ${road.crossfall * 100} %; superelevation ${road.maxSuperelevation * 100} % on the curve.`,
    '- Design the vertical profile from the start to the end of the road, following the ground with vertical curves where the grade changes.',
    '',
    '## Storm drainage',
    '| Manhole | Position (E, N) | Catchment |',
    '| ------- | --------------- | --------- |',
    ...drainage.manholes.map(
      (m) =>
        `| ${m.name} | ${xy(m.location)} | ${m.catchment ? `${m.catchment.areaHa} ha, C ${m.catchment.runoffCoefficient}` : '— (outfall to the stream)'} |`,
    ),
    `- Pipes in flow order: ${drainage.pipes.map(([a, b]) => `${drainage.manholes[a]?.name} → ${drainage.manholes[b]?.name}`).join(', ')}; PVC, Manning n ${drainage.manningN}; rims at ground level.`,
    `- Design storm: IDF i = ${drainage.idf.a} / (t + ${drainage.idf.b})^${drainage.idf.c} mm/h (modified rational method). Size the pipes from the commercial diameters ${drainage.diametersMm.join(', ')} mm.`,
    `- Minimum cover ${drainage.minCoverM} m over the crown, self-cleansing velocity ≥ ${drainage.minVelocity} m/s, every pipe falling to the outfall.`,
    `- Hydraulic grade line from a stream tailwater of ${drainage.outfallLevel} m: no surcharged pipe and no flooding manhole.`,
    '',
    '## Deliverables',
    `- A plan-and-profile sheet of the access road on ${intent.sheetPaper} paper at a standard scale, with the title block.`,
    '- LandXML 1.2 for the contractor (Civil 3D / 12d): survey points, the existing-ground TIN, the road alignment with its profile, the storm pipe network.',
    '- The saved project file, which must reopen and regenerate identically.',
  ].join('\n');
}
