/** CalculiX `.frd` reader (05 §5.7): fixed-column ASCII result blocks -> `FeResultsArtifact.steps`. */

import type { FeResultsArtifact } from '@core/model/analysis';

type Steps = FeResultsArtifact['steps'];
type Fields = Record<string, { components: string[]; values: Record<string, number[]> }>;

/** Result blocks that carry no physics (CalculiX error estimator). */
const IGNORED_FIELDS: ReadonlySet<string> = new Set(['ERROR']);
const VALUE_WIDTH = 12;
const VALUES_START = 13;

interface ResultSet {
  step: number;
  increment: number;
  time: number;
  fields: Fields;
}

/** Number of a 12-character value cell (`-1.31024E-19` has no separating blank), NaN for blanks. */
const cell = (line: string, index: number): number =>
  Number.parseFloat(line.slice(VALUES_START + index * VALUE_WIDTH, VALUES_START + (index + 1) * VALUE_WIDTH));

/**
 * Parse the nodal result blocks of a CalculiX FRD file. One entry per result set (`100CL`): `step` is the CalculiX step number
 * (`1PSTEP`, one per load case / `*STEP`), `time` the cumulative total time, `fields` keyed by block name (`DISP`, `STRESS`, `TOSTRAIN`,
 * `NDTEMP`, `FLUX`, `RFL`, ...) with the data component names as CalculiX writes them (derived `ALL` entries are skipped) and the values by
 * node id. Node (`2C`) and element (`3C`) blocks are skipped; the `ERROR` block is dropped. Transient files give one entry per written increment.
 * @failure unreadable lines are ignored, never thrown; text without result blocks -> []
 */
export function parseFrd(text: string): Steps {
  const sets: ResultSet[] = [];
  let pending: { step: number; increment: number } | null = null;
  let current: ResultSet | null = null;
  let field: Fields[string] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const tag = line.slice(0, 5);
    if (line.trim().startsWith('1PSTEP')) {
      const numbers = line.trim().slice(6).trim().split(/\s+/).map(Number);
      pending = { increment: numbers[1] ?? 1, step: numbers[2] ?? 1 };
      field = null;
    } else if (line.includes('100CL')) {
      const at = line.indexOf('100CL') + 5;
      const time = Number.parseFloat(line.slice(at + 5, at + 17));
      const step = pending?.step ?? 1;
      const increment = pending?.increment ?? 1;
      current = sets.find((set) => set.step === step && set.increment === increment) ?? null;
      if (current === null) {
        current = { step, increment, time: Number.isFinite(time) ? time : 0, fields: {} };
        sets.push(current);
      }
    } else if (tag === ' -4  ' && current !== null) {
      const name = line.slice(5, 13).trim();
      field = IGNORED_FIELDS.has(name) ? null : { components: [], values: {} };
      if (field !== null) current.fields[name] = field;
    } else if (tag === ' -5  ' && field !== null) {
      const match = /^ -5\s+(\S+)\s+\d+\s+\d+\s+\d+\s+\d+(\s+\S.*)?$/.exec(line);
      if (match !== null && match[2] === undefined && match[1] !== undefined) field.components.push(match[1]);
    } else if (line.startsWith(' -1') && field !== null && field.components.length > 0) {
      const node = Number.parseInt(line.slice(3, 13), 10);
      if (Number.isFinite(node)) field.values[String(node)] = field.components.map((_name, index) => cell(line, index));
    } else if (line.startsWith(' -3')) {
      field = null;
    }
  }
  return sets.filter((set) => Object.keys(set.fields).length > 0).map(({ step, time, fields }) => ({ step, time, fields }));
}

/**
 * Location of the first non-finite value (NaN from a blank or unreadable cell, Infinity from an overflowing one) in parsed steps, as
 * `step <n> field <name> node <id>`, or null when every value is finite.
 */
export function firstNonFinite(steps: Steps): string | null {
  for (const { step, fields } of steps)
    for (const [name, field] of Object.entries(fields))
      for (const [node, values] of Object.entries(field.values))
        if (values.some((value) => !Number.isFinite(value))) return `step ${step} field ${name} node ${node}`;
  return null;
}
