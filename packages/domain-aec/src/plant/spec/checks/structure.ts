/** Structural passes of `check_pipe_spec` (§5.6 1 to 4, 8): coverage, equal-priority overlaps, references, branch table, trust and status. */

import type { ComponentType } from '../../catalog/types';
import { resolveBranch } from '../resolve';
import { inRange, keyIn, rangesOverlap, sizeOrdinal } from '../size';
import { DEFAULT_PRIORITY, type PipeSpec, type SpecComponent } from '../types';
import { finding, listSizes, type CheckContext, type SpecFinding } from './finding';
import type { ComponentRows } from './rows';

const FLANGE_TYPES: readonly ComponentType[] = [
  'flangeWeldNeck',
  'flangeSlipOn',
  'flangeBlind',
  'flangeSocketWeld',
  'flangeThreaded',
  'flangeLapJoint',
];
const GASKET_TYPES: readonly ComponentType[] = ['gasketSpiralWound', 'gasketSheet', 'gasketRing'];

const covers = (spec: PipeSpec, types: readonly ComponentType[], size: Parameters<typeof inRange>[0]): boolean =>
  spec.components.some((component) => types.includes(component.type) && inRange(size, component.from, component.to));

/** Coverage (warn PSC_COVERAGE_GAP): pipe, elbow90, tee, reducerConcentric, and flange + gasket + boltSet where the spec has flanged ends. */
export function coverageFindings({ spec, sizes }: CheckContext): SpecFinding[] {
  const flanged = spec.components.some((component) => component.ends === 'FL' || FLANGE_TYPES.includes(component.type));
  const required: ReadonlyArray<{ readonly label: string; readonly types: readonly ComponentType[]; readonly skipFirst?: boolean }> = [
    { label: 'pipe', types: ['pipe'] },
    { label: 'elbow90', types: ['elbow90'] },
    { label: 'tee', types: ['tee'] },
    { label: 'reducerConcentric', types: ['reducerConcentric'], skipFirst: true },
    ...(flanged
      ? [
          { label: 'flange', types: FLANGE_TYPES },
          { label: 'gasket', types: GASKET_TYPES },
          { label: 'boltSet', types: ['boltSet'] as readonly ComponentType[] },
        ]
      : []),
  ];
  return required.flatMap(({ label, types, skipFirst }) => {
    const gaps = sizes.filter((size, index) => !(skipFirst === true && index === 0) && !covers(spec, types, size));
    return gaps.length === 0
      ? []
      : [
          finding(
            spec.id,
            'coverage',
            'PSC_COVERAGE_GAP',
            'warn',
            [label],
            ['components'],
            `spec ${spec.id} defines no ${label} for ${listSizes(gaps)}`,
            { gaps: gaps.length },
          ),
        ];
  });
}

const compatible = <T>(a: T | undefined, b: T | undefined): boolean => a === undefined || b === undefined || a === b;

function overlapping(a: SpecComponent, b: SpecComponent): boolean {
  if (a.type !== b.type || (a.priority ?? DEFAULT_PRIORITY) !== (b.priority ?? DEFAULT_PRIORITY)) return false;
  if (!rangesOverlap(a.from, a.to, b.from, b.to)) return false;
  if (a.branchFrom && a.branchTo && b.branchFrom && b.branchTo && !rangesOverlap(a.branchFrom, a.branchTo, b.branchFrom, b.branchTo))
    return false;
  return (
    compatible(a.ends, b.ends) &&
    compatible(a.facing, b.facing) &&
    compatible(a.radius, b.radius) &&
    compatible(a.class, b.class) &&
    compatible(a.pn, b.pn)
  );
}

/** Equal-priority overlaps of the same type (fail PSC_AMBIGUOUS_COMPONENT). */
export function overlapFindings({ spec }: CheckContext): SpecFinding[] {
  const out: SpecFinding[] = [];
  spec.components.forEach((a, i) =>
    spec.components.slice(i + 1).forEach((b, k) => {
      if (overlapping(a, b))
        out.push(
          finding(
            spec.id,
            'overlap',
            'PSC_AMBIGUOUS_COMPONENT',
            'fail',
            [a.id, b.id],
            [`components.${i}`, `components.${i + 1 + k}`],
            `${a.type} components ${a.id} and ${b.id} overlap in size at the same priority (${a.priority ?? DEFAULT_PRIORITY}); resolution would be ambiguous`,
          ),
        );
    }),
  );
  return out;
}

/** Catalogues the spec names that do not exist (fail), components whose rows are missing (warn PSC_CATALOG_ROW_MISSING). */
export function referenceFindings({ spec, missingCatalogs }: CheckContext, rows: readonly ComponentRows[]): SpecFinding[] {
  const unknown = missingCatalogs.map((reference) =>
    finding(
      spec.id,
      'references',
      'PSC_CATALOG_UNKNOWN',
      'fail',
      [reference],
      ['catalogs'],
      `spec ${spec.id} searches catalogue "${reference}", which is neither bundled nor imported`,
    ),
  );
  const missing = rows.flatMap((entry) =>
    entry.missing.length === 0
      ? []
      : [
          finding(
            spec.id,
            'references',
            'PSC_CATALOG_ROW_MISSING',
            'warn',
            [entry.component.id],
            [`components.${entry.index}.catalogRef`],
            `component ${entry.component.id} (${entry.component.type}, ${entry.component.catalogRef}) has no catalogue row for ${listSizes(entry.missing)} (${entry.missingReason ?? ''})`,
            { sizes: entry.missing.length },
          ),
        ],
  );
  return [...unknown, ...missing];
}

/** Branch table (warn PSC_BRANCH_UNDEFINED / the code of an unresolvable cell): every branch <= header is filled; each cell resolves to a component. */
export function branchFindings(context: CheckContext): SpecFinding[] {
  const { spec, catalogs } = context;
  const table = spec.branchTable;
  if (table === undefined)
    return [finding(spec.id, 'branch', 'PSC_BRANCH_UNDEFINED', 'warn', [spec.id], ['branchTable'], `spec ${spec.id} has no branch table`)];
  const headers = Object.keys(table.cells);
  const branches = [...new Set(headers.flatMap((header) => Object.keys(table.cells[header] ?? {})))];
  const empty: string[] = [];
  const out: SpecFinding[] = [];
  for (const header of headers) {
    const headerSize = context.sizes.find((size) => keyIn(size, table.system) === header);
    const headerOrdinal = headerSize === undefined ? Number.POSITIVE_INFINITY : sizeOrdinal(headerSize);
    for (const branch of branches) {
      const branchSize = context.sizes.find((size) => keyIn(size, table.system) === branch);
      if (branchSize === undefined || sizeOrdinal(branchSize) > headerOrdinal) continue;
      const fitting = table.cells[header]?.[branch];
      if (fitting === undefined) {
        empty.push(`${header}x${branch}`);
        continue;
      }
      const system = table.system === 'NPS' ? 'Nps' : 'Dn';
      const outcome = resolveBranch(spec, catalogs, { [`header${system}`]: header, [`branch${system}`]: branch });
      if (!outcome.ok)
        out.push(
          finding(
            spec.id,
            'branch',
            outcome.code,
            'warn',
            [`${header}x${branch}`],
            [`branchTable.cells.${header}.${branch}`],
            `branch cell ${header} x ${branch} (${fitting}): ${outcome.message}`,
          ),
        );
    }
  }
  if (empty.length > 0)
    out.unshift(
      finding(
        spec.id,
        'branch',
        'PSC_BRANCH_UNDEFINED',
        'warn',
        empty,
        ['branchTable.cells'],
        `branch table of ${spec.id} has no fitting for ${empty.length} header x branch pair(s) with branch <= header: ${empty.slice(0, 12).join(', ')}`,
        { empty: empty.length },
      ),
    );
  return out;
}

/** PSC_DATA_UNVERIFIED (warn, never suppressible) listing the components whose dimensions are not all grade A or have no catalogue row. */
export function trustFindings({ spec }: CheckContext, rows: readonly ComponentRows[]): SpecFinding[] {
  const ids = rows
    .filter((entry) => entry.unresolved !== undefined || entry.resolved.some((resolved) => !resolved.verified))
    .map((entry) => entry.component.id);
  if (ids.length === 0) return [];
  return [
    finding(
      spec.id,
      'trust',
      'PSC_DATA_UNVERIFIED',
      'warn',
      ids,
      ['components'],
      `${ids.length} component(s) use dimensions that are not grade A or have no catalogue row (verified: false): ${ids.join(', ')}`,
      { components: ids.length },
    ),
  ];
}

/** PSC_SPEC_NOT_APPROVED (warn) for a draft or superseded spec. */
export const statusFindings = ({ spec }: CheckContext): SpecFinding[] =>
  spec.status === 'approved'
    ? []
    : [
        finding(
          spec.id,
          'status',
          'PSC_SPEC_NOT_APPROVED',
          'warn',
          [spec.id],
          ['status'],
          `spec ${spec.id} revision ${spec.revision} is ${spec.status}, not approved`,
        ),
      ];
