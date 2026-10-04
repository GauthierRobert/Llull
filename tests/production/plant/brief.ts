import { PIPE_OD, section } from '../oracle/steel';
import { gridCoordinates, letterLabels, type PlantIntent } from './intent';
import { OPENING_MARGIN } from './script';

/**
 * @layer tests/production/plant
 *
 * Renders a plant intent as the brief a lead engineer hands to a designer: rules for the steel
 * structure, tables for equipment and lines, and the deliverables expected. The structural rules
 * are stated, not enumerated — the designer derives the members, as in a real office.
 */

const mm = (value: number): string => `${Math.round(value * 10) / 10}`;
const point = (values: readonly number[]): string => `(${values.map(mm).join(', ')})`;

function profilesOf(intent: PlantIntent, role: string): string[] {
  return [...new Set(intent.members.filter((m) => m.role === role).map((m) => m.profile))];
}

export function plantBrief(intent: PlantIntent, extra: string[] = []): string {
  const xs = gridCoordinates(intent.grid.xSpacings);
  const ys = gridCoordinates(intent.grid.ySpacings);
  const letters = letterLabels(ys.length);
  const beams = profilesOf(intent, 'beam');
  const grating = intent.floors[0]?.thickness ?? 0;
  const buildingRules: string[] = [
    '## Steel structure (S355)',
    `- Columns ${profilesOf(intent, 'column').join(', ')} at every grid intersection, one continuous member from ${mm(0)} to ${mm(Math.max(...intent.members.filter((m) => m.role === 'column').map((m) => m.end[2])))} (belongs to the ground level).`,
    `- Every floor level above ground carries ${grating} mm gratings on steel beams: top of steel = FFL − ${grating}. Member axes are section centroid lines, so a beam axis is at FFL − ${grating} − h/2.`,
    `- Main beams ${beams[0] ?? ''} (h = ${section(beams[0] ?? '')?.h ?? '?'} mm) along Y on every numbered axis, one member per bay between lettered axes.`,
    `- Secondary beams ${beams[1] ?? ''} (h = ${section(beams[1] ?? '')?.h ?? '?'} mm) along X on every lettered axis, one member per bay between numbered axes.`,
    `- Vertical X-bracing ${profilesOf(intent, 'brace').join(', ')} in every storey: bays 1–2 and ${xs.length - 1}–${xs.length} on axes ${letters[0]} and ${letters.at(-1)}, and bay ${letters[0]}–${letters[1]} on axes 1 and ${xs.length}. Work points: column base at ground, then the secondary-beam axis of each floor. Two diagonals per braced bay and storey.`,
    `- Floors: ${grating} mm ${intent.floors[0]?.material ?? ''} over the full grid footprint on every level above ground (top at FFL).`,
    '',
  ];
  const equipmentAndAccess: string[] = [
    '## Process equipment',
    '| Tag | Name | Level | Centre (x, y) | Size L×W×H | Operating weight | Clearance |',
    '| --- | ---- | ----- | ------------- | ---------- | ---------------- | --------- |',
    ...intent.equipment.map(
      (e) =>
        `| ${e.tag} | ${e.name} | ${intent.levels[e.level]?.name ?? ''} | ${point(e.location)} | ${e.size.map(mm).join(' × ')} | ${e.weight} kg | ${e.clearance} |`,
    ),
    `Where an equipment passes through a floor, cut the grating around its footprint with a ${OPENING_MARGIN} mm margin.`,
    '',
    '## Access',
    ...intent.stairs.map(
      (s) =>
        `- Straight stair from "${intent.levels[s.level]?.name ?? ''}" to the level above: first riser centre ${point(s.start)}, climbing at ${mm((s.angle * 180) / Math.PI)}° from +X, width ${s.width}. Cut its stair well in the floor above.`,
    ),
    '',
  ];
  const trayLines: string[] = [
    '## Cable trays',
    ...(intent.trays ?? []).map(
      (t) =>
        `- ${t.system} cable tray ${t.width} wide × ${t.height} side height, centreline (z = tray centre): ${t.route.map(point).join(' → ')}.`,
    ),
    '',
  ];
  const lines: string[] = [
    `# ${intent.project.name} — structure, equipment and piping model`,
    '',
    `Client: ${intent.project.client}. Drawing number ${intent.project.drawingNumber}, revision ${intent.project.revision}, date ${intent.project.date}, drawn by "${intent.project.author}".`,
    'Units: millimetres. Absolute coordinates: x east, y north, z up from ground FFL ±0.00.',
    '',
    '## Grid and levels',
    `- Numbered axes 1–${xs.length} along X at x = ${xs.map(mm).join(', ')}; lettered axes ${letters.join(', ')} along Y at y = ${ys.map(mm).join(', ')}.`,
    ...intent.levels.map(
      (level) =>
        `- Level "${level.name}": FFL ${mm(level.elevation)}, storey height ${mm(level.height)}.`,
    ),
    '',
    ...(intent.structureBrief ?? buildingRules),
    ...(intent.equipment.length > 0 || intent.stairs.length > 0 ? equipmentAndAccess : []),
    '## Process lines (absolute centreline routes)',
    '| Line | Service | DN (OD) | From | To | Route |',
    '| ---- | ------- | ------- | ---- | -- | ----- |',
    ...intent.pipes.map(
      (p) =>
        `| ${p.line} | ${p.service} | DN${p.dn} (${PIPE_OD[p.dn] ?? '?'}) | ${p.from} | ${p.to} | ${p.route.map(point).join(' → ')} |`,
    ),
    `Battery-limit tie-ins (lines may end open there): ${Object.entries(intent.tieIns)
      .map(([id, p]) => `${id} ${point(p)}`)
      .join('; ')}.`,
    '',
    ...(intent.trays !== undefined && intent.trays.length > 0 ? trayLines : []),
    '## Deliverables and acceptance',
    '- The model must be clash-free (no hard clash, no clearance violation).',
    '- The office will issue from the model: IFC for coordination, a DXF plan and a plan sheet per level, a south elevation, member / equipment / pipe schedules and the quantity takeoff, and the saved project file.',
    ...extra,
  ];
  return lines.join('\n');
}
