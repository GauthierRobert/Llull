/**
 * export_code — the document as parametric source code: CadQuery / build123d / OpenSCAD / FreeCAD
 * (parameters → variables, `=expr` dimensions → expressions, features in history order).
 * The reverse direction is apply_code_trace (code_trace.ts).
 *
 * @layer core/commands
 */

import type { CommandDefinition, CommandResult } from './types';
import { getCommand } from './registry';
import { buildFeatureProgram } from '../codegen/featureProgram';
import { emitPython } from '../codegen/python';
import { emitOpenScad } from '../codegen/openscad';
import { emitFreeCad } from '../codegen/freecad';

// ---------------------------------------------------------------------------
// export_code
// ---------------------------------------------------------------------------

type CodeLanguage = 'cadquery' | 'build123d' | 'openscad' | 'freecad';

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
    const base =
      (name ?? 'model')
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/^[._]+/, '')
        .slice(0, 64) || 'model';
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
