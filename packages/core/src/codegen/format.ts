/**
 * Source-text formatting shared by every code emitter.
 *
 * @layer core/codegen
 * @pure
 */

import type { Feature, FeatureProgram, Term } from './program';

/** Shortest faithful decimal for a coordinate (12 significant digits, no `-0`). */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-12) return '0';
  return String(Number(value.toPrecision(12)));
}

/** A term's source: its parameter expression when bound, otherwise the literal number. */
export function formatTerm(term: Term): string {
  return term.expression ?? formatNumber(term.value);
}

/** Radians → degrees, keeping a parameter expression symbolic via `piName` (e.g. `math.pi`). */
export function formatDegrees(term: Term, piName: string): string {
  if (term.expression !== undefined) return `(${term.expression}) * 180 / ${piName}`;
  const degrees = (term.value * 180) / Math.PI;
  return Math.abs(degrees) < 1e-12 ? '0' : String(Number(degrees.toPrecision(15)));
}

/** `# ── TITLE ───…` comment rule, padded to 66 columns. */
export function sectionBanner(title: string): string {
  return `# ── ${title} `.padEnd(66, '─');
}

export function isZero(terms: readonly Term[]): boolean {
  return terms.every((t) => t.expression === undefined && t.value === 0);
}

/** A string literal valid in Python and OpenSCAD (JSON escapes are a subset of both). */
export function quote(text: string): string {
  return JSON.stringify(text);
}

/**
 * Text safe inside a single-line comment or a Python docstring of ANY target language: document
 * strings (names, command names) are untrusted, and a newline or `"""` would escape into code.
 */
export function commentText(text: string): string {
  return (
    String(text)
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\r\n\u2028\u2029\u0000-\u001f\u007f]+/g, ' ')
      .replace(/"""/g, "'''")
      .replace(/\*\//g, '* /')
  );
}

/** `# step 3 · add_box` style heading, emitted once per contiguous run of features from a step. */
export function stepHeading(feature: Feature, previous: Feature | undefined): string | null {
  if (feature.step === null) return commentText(feature.command);
  if (previous !== undefined && previous.step === feature.step) return null;
  return `step ${feature.step} · ${commentText(feature.command)}`;
}

/** One assignment line per program parameter (`(none)` placeholder when there are none). */
export function parameterLines(
  program: FeatureProgram,
  commentPrefix: string,
  assignment: (parameter: FeatureProgram['parameters'][number]) => string,
): string[] {
  if (program.parameters.length === 0) return [`${commentPrefix} (none)`];
  return program.parameters.map(assignment);
}

/** Feature lines, each contiguous run of a step introduced by its `stepHeading` comment. */
export function featureLinesWithHeadings(
  program: FeatureProgram,
  commentPrefix: string,
  featureLine: (feature: Feature) => string,
): string[] {
  const lines: string[] = [];
  program.features.forEach((feature, i) => {
    const heading = stepHeading(feature, program.features[i - 1]);
    if (heading !== null) lines.push(`${commentPrefix} ${heading}`);
    lines.push(featureLine(feature));
  });
  return lines;
}

/** Numbers packed `perLine` per line, for long mesh arrays. */
export function numberRows(values: readonly number[], perLine: number): string[] {
  const rows: string[] = [];
  for (let i = 0; i < values.length; i += perLine) {
    rows.push(
      values
        .slice(i, i + perLine)
        .map(formatNumber)
        .join(', '),
    );
  }
  return rows;
}

/** One-paragraph provenance shared by every emitter's header. */
export function provenance(program: FeatureProgram): string[] {
  const lines = [
    `Units: ${commentText(program.units)}. Right-handed frame, +Z up.`,
    program.source === 'history'
      ? 'Features follow the llull feature history in order; parameter-driven dimensions are expressions.'
      : 'The document had no reproducible feature history; this is its current geometry.',
  ];
  for (const note of program.notes) lines.push(`Note: ${commentText(note)}`);
  return lines;
}
