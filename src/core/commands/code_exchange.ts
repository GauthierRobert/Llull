/**
 * Parametric code exchange — the document as source code and back.
 *
 * `export_code` lowers the feature history to CadQuery / build123d / OpenSCAD / FreeCAD source
 * (parameters → variables, `=expr` dimensions → expressions, features in history order).
 * `apply_code_trace` rebuilds the document from the LLULL_TRACE recorded by running a generated (and
 * possibly agent-edited) CadQuery / build123d script, so code edits regenerate an editable model.
 *
 * @layer core/commands
 */

import type { CadDocument } from '../model/types';
import { createEmptyDocument } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { execute, getCommand } from './registry';
import { executeRecorded } from './record';
import { buildParamEnv } from './regenerate';
import { evaluateExpression, extractReferences } from './expression';
import { MAX_TRACE_FEATURES } from './limits';
import { buildFeatureProgram } from '../codegen/featureProgram';
import { emitPython } from '../codegen/python';
import { emitOpenScad } from '../codegen/openscad';
import { emitFreeCad } from '../codegen/freecad';

// ---------------------------------------------------------------------------
// export_code
// ---------------------------------------------------------------------------

export type CodeLanguage = 'cadquery' | 'build123d' | 'openscad' | 'freecad';

const LANGUAGES: readonly CodeLanguage[] = ['cadquery', 'build123d', 'openscad', 'freecad'];

const FILE_EXTENSIONS: Readonly<Record<CodeLanguage, string>> = {
  cadquery: 'py',
  build123d: 'py',
  openscad: 'scad',
  freecad: 'FCMacro',
};

interface ExportCodeParams {
  language: CodeLanguage;
  name?: string;
}

/**
 * @command export_code
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data.text regenerates the document's 3D solids; data.source tells whether it came
 *   from the feature history ('history', parametric) or the current geometry ('snapshot')
 * @failure unknown language -> no-op with summary, affected:[]
 */
export const exportCode: CommandDefinition<ExportCodeParams> = {
  name: 'export_code',
  description:
    'Export the model as parametric source code: CadQuery or build123d (Python), OpenSCAD, or a FreeCAD ' +
    'macro. Parameters become named variables, parameter-driven dimensions stay expressions, and every ' +
    'feature (primitive, boolean, move, delete, rename) appears in feature-history order, so the code ' +
    'states exact dimensions and build order. CadQuery/build123d output can be edited and re-imported ' +
    'with import_code. Read-only: returns data.text (plus fileName, language, source, counts).',
  paramsSchema: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        description: 'Target: "cadquery" | "build123d" | "openscad" | "freecad".',
        enum: LANGUAGES,
      },
      name: {
        type: 'string',
        description: 'Base file name without extension (sanitized). Default "model".',
      },
    },
    required: ['language'],
  },
  annotations: { readOnly: true, idempotent: true },
  run: (doc, { language, name }): CommandResult => {
    if (!LANGUAGES.includes(language)) {
      return {
        document: doc,
        summary: `export_code: unknown language "${String(language)}"; use one of ${LANGUAGES.join(', ')}.`,
        affected: [],
      };
    }
    const program = buildFeatureProgram(doc, getCommand);
    const text =
      language === 'openscad'
        ? emitOpenScad(program)
        : language === 'freecad'
          ? emitFreeCad(program)
          : emitPython(program, language);
    const base = (name ?? 'model').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'model';
    const fileName = `${base}.${FILE_EXTENSIONS[language]}`;
    const notes = program.notes.length > 0 ? ` Notes: ${program.notes.join(' ')}` : '';
    return {
      document: doc,
      summary:
        `export_code (${language}): ${program.parameters.length} parameter(s), ${program.features.length} ` +
        `feature(s), ${program.outputs.length} solid(s) from ${program.source}; ${text.length} chars → ${fileName}.${notes}`,
      affected: [],
      data: {
        format: 'code',
        language,
        fileName,
        source: program.source,
        parameterCount: program.parameters.length,
        featureCount: program.features.length,
        solidCount: program.outputs.length,
        notes: program.notes,
        text,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// apply_code_trace
// ---------------------------------------------------------------------------

interface TraceParameter {
  name: string;
  expression: string;
}

interface TraceFeature {
  command: string;
  params: Record<string, unknown>;
  ref?: string;
  name?: string;
}

interface CodeTrace {
  parameters: TraceParameter[];
  features: TraceFeature[];
}

interface ApplyCodeTraceParams {
  trace: CodeTrace;
  mode?: 'replace' | 'append';
}

/** Commands the generated runtime records. A trace can never reach any other command. */
const TRACE_COMMANDS: ReadonlySet<string> = new Set([
  'add_box',
  'add_cylinder',
  'add_sphere',
  'add_cone',
  'add_torus',
  'add_wedge',
  'add_pyramid',
  'extrude_profile',
  'revolve_profile',
  'import_mesh',
  'boolean_union',
  'boolean_subtract',
  'boolean_intersect',
  'move_entity',
  'delete_entity',
  'set_entity_name',
]);

const PARAMETER_NAME = /^[A-Za-z_]\w*$/;

interface Lowered {
  /** Params passed to the command (numbers, entity ids). */
  run: unknown;
  /** Params recorded in featureHistory (`=expr` kept where it is parameter-driven). */
  record: unknown;
}

type LowerResult = Lowered | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `(a + b)` → `a + b` when the outer parentheses enclose the whole expression. */
export function stripOuterParens(expression: string): string {
  let text = expression.trim();
  while (text.startsWith('(') && text.endsWith(')')) {
    let depth = 0;
    let enclosesAll = true;
    for (let i = 0; i < text.length - 1; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      if (depth === 0) {
        enclosesAll = false;
        break;
      }
    }
    if (!enclosesAll) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** A runtime term `{ value, expression? }`. */
function isTerm(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    typeof value.value === 'number' &&
    keys.every((k) => k === 'value' || k === 'expression') &&
    (value.expression === undefined || typeof value.expression === 'string')
  );
}

function lowerTerm(
  term: Record<string, unknown>,
  env: Readonly<Record<string, number>>,
  parameters: CadDocument['parameters'],
): LowerResult {
  const value = term.value as number;
  if (!Number.isFinite(value)) return { error: `non-finite number ${String(value)}` };
  if (typeof term.expression !== 'string') return { run: value, record: value };
  const expression = stripOuterParens(term.expression);
  const refs = [...extractReferences(expression)];
  if (refs.length === 0 || !refs.every((r) => r in parameters))
    return { run: value, record: value };
  const evaluated = evaluateExpression(expression, env);
  if (!evaluated.ok) return { run: value, record: value };
  return { run: evaluated.value, record: `=${expression}` };
}

/** Resolve terms and `{ ref }` placeholders inside a feature's params. */
function lowerParams(
  value: unknown,
  refs: ReadonlyMap<string, string>,
  env: Readonly<Record<string, number>>,
  parameters: CadDocument['parameters'],
): LowerResult {
  if (Array.isArray(value)) {
    const run: unknown[] = [];
    const record: unknown[] = [];
    for (const item of value) {
      const lowered = lowerParams(item, refs, env, parameters);
      if ('error' in lowered) return lowered;
      run.push(lowered.run);
      record.push(lowered.record);
    }
    return { run, record };
  }
  if (isRecord(value)) {
    if (isTerm(value)) return lowerTerm(value, env, parameters);
    if (typeof value.ref === 'string' && Object.keys(value).length === 1) {
      const id = refs.get(value.ref);
      return id === undefined
        ? { error: `unknown solid reference "${value.ref}"` }
        : { run: id, record: id };
    }
    const run: Record<string, unknown> = {};
    const record: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const lowered = lowerParams(item, refs, env, parameters);
      if ('error' in lowered) return lowered;
      run[key] = lowered.run;
      record[key] = lowered.record;
    }
    return { run, record };
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { error: `non-finite number ${String(value)}` };
  }
  return { run: value, record: value };
}

function validateTrace(trace: unknown): string | null {
  if (!isRecord(trace)) return 'trace must be an object';
  const { parameters, features } = trace;
  if (!Array.isArray(parameters) || !Array.isArray(features)) {
    return 'trace needs "parameters" and "features" arrays';
  }
  if (features.length > MAX_TRACE_FEATURES) {
    return `${features.length} features exceeds MAX_TRACE_FEATURES (${MAX_TRACE_FEATURES})`;
  }
  for (const [i, p] of parameters.entries()) {
    if (!isRecord(p) || typeof p.name !== 'string' || !PARAMETER_NAME.test(p.name)) {
      return `parameter ${i}: name must be an identifier`;
    }
    if (typeof p.expression !== 'string' || p.expression.trim() === '') {
      return `parameter ${p.name}: expression must be a non-empty string`;
    }
  }
  for (const [i, f] of features.entries()) {
    if (!isRecord(f) || typeof f.command !== 'string' || !isRecord(f.params)) {
      return `feature ${i}: needs { command, params }`;
    }
    if (!TRACE_COMMANDS.has(f.command))
      return `feature ${i}: command "${f.command}" is not allowed in a code trace`;
  }
  return null;
}

/** Fresh geometry, keeping view and organisation state the code does not describe. */
function replaceBase(doc: CadDocument): CadDocument {
  return {
    ...createEmptyDocument(),
    camera: doc.camera,
    units: doc.units,
    displayPrecision: doc.displayPrecision,
    layers: doc.layers,
    layerOrder: doc.layerOrder,
    materials: doc.materials,
  };
}

function abort(doc: CadDocument, reason: string): CommandResult {
  return {
    document: doc,
    summary: `apply_code_trace: ${reason} — document unchanged.`,
    affected: [],
  };
}

/**
 * @command apply_code_trace
 * @pure
 * @layer core/commands
 * @affects replace (default): parameters, featureHistory and solids rebuilt from the trace;
 *   append: trace added on top. affected = live solids created by the trace, in creation order
 * @invariant every trace feature is recorded as one FeatureStep; parameter-driven terms are stored as
 *   `=expr` so set_parameter + replay_history regenerates the model
 * @failure malformed trace, disallowed command, unknown ref or a failing feature -> full rollback
 */
export const applyCodeTrace: CommandDefinition<ApplyCodeTraceParams> = {
  name: 'apply_code_trace',
  description:
    'Rebuild the model from a feature trace (LLULL_TRACE) recorded by running llull-generated CadQuery or ' +
    'build123d code — normally called for you by the import_code tool. Parameters are set first, then each ' +
    'traced feature runs as its llull command, keeping parameter expressions in the feature history. ' +
    'mode "replace" (default) swaps the current solids/parameters/history for the trace; "append" adds to them.',
  paramsSchema: {
    type: 'object',
    properties: {
      trace: {
        type: 'object',
        description:
          'The trace: { parameters: [{ name, expression }], features: [{ command, params, ref?, name? }] }. ' +
          'Numbers in params may be { value, expression? } terms; solids are referenced as { ref: "f3" }.',
      },
      mode: {
        type: 'string',
        description: '"replace" (default) or "append".',
        enum: ['replace', 'append'],
      },
    },
    required: ['trace'],
  },
  annotations: { metaHistory: true, destructive: true },
  run: (doc, { trace, mode = 'replace' }): CommandResult => {
    const invalid = validateTrace(trace);
    if (invalid !== null) return abort(doc, invalid);

    let current = mode === 'append' ? doc : replaceBase(doc);
    for (const { name, expression } of trace.parameters) {
      const parameter = { name, expression: stripOuterParens(expression) };
      const result = execute(current, 'set_parameter', parameter);
      const stored = result.document.parameters[parameter.name];
      if (stored === undefined || stored.error !== undefined) {
        return abort(
          doc,
          `parameter ${parameter.name} = ${parameter.expression}: ${result.summary}`,
        );
      }
      current = result.document;
    }

    const refs = new Map<string, string>();
    const created: string[] = [];
    for (const [i, feature] of trace.features.entries()) {
      const env = buildParamEnv(current.parameters);
      const lowered = lowerParams(feature.params, refs, env, current.parameters);
      if ('error' in lowered)
        return abort(doc, `feature ${i} (${feature.command}): ${lowered.error}`);
      const result = executeRecorded(current, feature.command, lowered.run, lowered.record);
      if (result.document === current && result.affected.length === 0) {
        return abort(doc, `feature ${i} (${feature.command}) failed: ${result.summary}`);
      }
      current = result.document;
      if (feature.ref !== undefined && result.affected[0] !== undefined) {
        refs.set(feature.ref, result.affected[0]);
        created.push(...result.affected);
      }
      const id = feature.ref !== undefined ? refs.get(feature.ref) : undefined;
      if (typeof feature.name === 'string' && feature.name !== '' && id !== undefined) {
        current = execute(current, 'set_entity_name', { id, name: feature.name }).document;
      }
    }

    const live = created.filter((id) => current.entities[id] !== undefined);
    const parameterNames = trace.parameters.map((p) => p.name);
    return {
      document: current,
      summary:
        `apply_code_trace (${mode}): ${trace.parameters.length} parameter(s)` +
        (parameterNames.length > 0 ? ` [${parameterNames.join(', ')}]` : '') +
        `, ${trace.features.length} feature(s) → ${live.length} solid(s): ${live.join(', ') || 'none'}.`,
      affected: live,
    };
  },
};
