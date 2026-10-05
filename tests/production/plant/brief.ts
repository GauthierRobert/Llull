import { PIPE_OD, section } from '../oracle/steel';
import { gridCoordinates, letterLabels, type IntentMember, type PlantIntent } from './intent';
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

/** Primary (grid) members: secondary steel with a `purpose` is listed separately. */
const primary = (intent: PlantIntent): IntentMember[] =>
  intent.members.filter((m) => m.purpose === undefined);

function profilesOf(intent: PlantIntent, role: string): string[] {
  return [
    ...new Set(
      primary(intent)
        .filter((m) => m.role === role)
        .map((m) => m.profile),
    ),
  ];
}

/** Secondary steel, grouped by purpose, every member with its exact axis. */
function secondarySteel(intent: PlantIntent): string[] {
  const groups = new Map<string, IntentMember[]>();
  for (const m of intent.members) {
    if (m.purpose !== undefined) groups.set(m.purpose, [...(groups.get(m.purpose) ?? []), m]);
  }
  if (groups.size === 0) return [];
  return [
    '## Secondary steel (S355, absolute axis end points)',
    ...[...groups].flatMap(([purpose, members]) => [
      `- ${purpose}:`,
      ...members.map(
        (m) =>
          `  - ${m.role} ${m.profile} on "${intent.levels[m.level]?.name ?? ''}" from ${point(m.start)} to ${point(m.end)}${m.startJoint === 'rigid' || m.endJoint === 'rigid' ? ' (rigid joints)' : ''}.`,
      ),
    ]),
    '',
  ];
}

function supportLines(intent: PlantIntent): string[] {
  const supports = intent.supports ?? [];
  if (supports.length === 0) return [];
  return [
    '## Pipe supports (absolute points on the line centreline; each bears on the steel below — shoe — or above — hanger)',
    ...supports.map((s) => `- ${s.line}: ${s.type} at ${s.at.map(point).join(', ')}.`),
    'Every line must keep its supports within the standard maximum span for its DN (MSS SP-69 / ASME B31.1, water-filled).',
    '',
  ];
}

type Axis = 'x' | 'y';
const runsAlong = (m: IntentMember): Axis =>
  Math.abs(m.end[0] - m.start[0]) >= Math.abs(m.end[1] - m.start[1]) ? 'x' : 'y';

/** The usual beam section along an axis (most frequent), and the members that differ from it. */
function beamRule(
  intent: PlantIntent,
  axis: Axis,
): { profile: string; exceptions: IntentMember[] } {
  const beams = primary(intent).filter((m) => m.role === 'beam' && runsAlong(m) === axis);
  const counts = new Map<string, number>();
  for (const beam of beams) counts.set(beam.profile, (counts.get(beam.profile) ?? 0) + 1);
  const profile = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return { profile, exceptions: beams.filter((b) => b.profile !== profile) };
}

export function plantBrief(intent: PlantIntent, extra: string[] = []): string {
  const xs = gridCoordinates(intent.grid.xSpacings);
  const ys = gridCoordinates(intent.grid.ySpacings);
  const letters = letterLabels(ys.length);
  const main = beamRule(intent, 'y');
  const secondary = beamRule(intent, 'x');
  const exceptions = [...main.exceptions, ...secondary.exceptions].map(
    (m) =>
      `  - ${m.profile} (h = ${section(m.profile)?.h ?? '?'} mm) instead, on "${intent.levels[m.level]?.name ?? ''}" from ${point(m.start.slice(0, 2))} to ${point(m.end.slice(0, 2))} (same top of steel).`,
  );
  const grating = intent.floors[0]?.thickness ?? 0;
  const buildingRules: string[] = [
    '## Steel structure (S355)',
    `- Columns ${profilesOf(intent, 'column').join(', ')} at every grid intersection, one continuous member from ${mm(0)} to ${mm(
      Math.max(
        ...primary(intent)
          .filter((m) => m.role === 'column')
          .map((m) => m.end[2]),
      ),
    )} (belongs to the ground level).`,
    `- Every floor level above ground carries ${grating} mm gratings on steel beams: top of steel = FFL − ${grating}. Member axes are section centroid lines, so a beam axis is at FFL − ${grating} − h/2.`,
    `- Main beams ${main.profile} (h = ${section(main.profile)?.h ?? '?'} mm) along Y on every numbered axis, one member per bay between lettered axes.`,
    `- Secondary beams ${secondary.profile} (h = ${section(secondary.profile)?.h ?? '?'} mm) along X on every lettered axis, one member per bay between numbered axes.`,
    ...(exceptions.length > 0 ? ['- Upsized beams (structural check):', ...exceptions] : []),
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
    ...secondarySteel(intent),
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
    ...supportLines(intent),
    '## Deliverables and acceptance',
    '- The model must be clash-free (no hard clash, no clearance violation).',
    '- The office will issue from the model: IFC for coordination, a DXF plan and a plan sheet per level, a south elevation, member / equipment schedules, the line list (line number, DN, from and to of every line) and the quantity takeoff, and the saved project file.',
    '- Every steel member must pass a structural verification (EN 1993) under its floor, equipment and pipe loads.',
    ...extra,
  ];
  return lines.join('\n');
}
