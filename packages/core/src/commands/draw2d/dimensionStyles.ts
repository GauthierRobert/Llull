/**
 * Dimension styles (ROADMAP v1.0): named presentation of dimensions — text height, arrowheads, extension lines, number format — kept in
 * `CadDocument.dimensionStyles`, named by `DimensionEntity.styleId`, read by the viewport, render_view, scene and the DXF / SVG exports
 * through `@core/geometry/dimensionAnnotation`.
 */

import type { CadDocument, DimensionEntity, Entity } from '../../model/types';
import {
  DECIMAL_SEPARATORS,
  DIMENSION_ARROW_STYLES,
  MAX_DIMENSION_AFFIX_LENGTH,
  type DimensionStyle,
  type DimensionStyleSettings,
} from '../../model/dimensionStyle';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { nextId } from '../../lib/id';
import { changed, noop } from '../noop';
import { isHexColor } from '../../lib/isHexColor';
import { MAX_DISPLAY_PRECISION } from '../limits';
import { replaceEntitiesById } from '../entity/entityOps';

const settingsFields = {
  textHeight: z
    .number()
    .describe('Value text cap height in drawing units, > 0. Default: 0.5 in the viewport, 0.6 in DXF / SVG exports.')
    .optional(),
  arrowSize: z.number().describe('Arrowhead length in drawing units, > 0. Default 0.3.').optional(),
  arrowStyle: z
    .enum(DIMENSION_ARROW_STYLES)
    .describe(
      "Arrowhead shape: 'open' (two wings, default), 'closed' (filled-outline triangle), 'tick' (architectural 45° slash), 'dot', 'none'.",
    )
    .optional(),
  extensionGap: z
    .number()
    .describe('Gap between the measured geometry and the start of each extension line, drawing units, >= 0. Default 0.')
    .optional(),
  extensionBeyond: z.number().describe('How far extension lines run past the dimension line, drawing units, >= 0. Default 0.').optional(),
  precision: z
    .number()
    .int()
    .describe(
      `Decimals of lengths, 0..${MAX_DISPLAY_PRECISION}; a dimension's own precision still wins. Default: the document displayPrecision.`,
    )
    .optional(),
  angularPrecision: z.number().int().describe(`Decimals of angles, 0..${MAX_DISPLAY_PRECISION}. Default 1.`).optional(),
  decimalSeparator: z.enum(DECIMAL_SEPARATORS).describe("Decimal separator: '.' (default) or ',' (ISO / European drawings).").optional(),
  prefix: z
    .string()
    .describe(`Text before the value (after Ø on a diameter), e.g. 'R'. At most ${MAX_DIMENSION_AFFIX_LENGTH} characters.`)
    .optional(),
  suffix: z
    .string()
    .describe(`Text after the value, before any tolerance, e.g. ' mm'. At most ${MAX_DIMENSION_AFFIX_LENGTH} characters.`)
    .optional(),
  color: z.string().describe('Stroke and text colour #rrggbb; default the colour of each dimension entity.').optional(),
};

type SettingsInput = { [K in keyof DimensionStyleSettings]?: DimensionStyleSettings[K] | undefined };

/** Why `settings` is not a valid style, or null. */
function settingsProblem(settings: SettingsInput): string | null {
  for (const key of ['textHeight', 'arrowSize'] as const) {
    const value = settings[key];
    if (value !== undefined && !(Number.isFinite(value) && value > 0)) return `${key} must be a finite number > 0 (got ${value})`;
  }
  for (const key of ['extensionGap', 'extensionBeyond'] as const) {
    const value = settings[key];
    if (value !== undefined && !(Number.isFinite(value) && value >= 0)) return `${key} must be a finite number >= 0 (got ${value})`;
  }
  for (const key of ['precision', 'angularPrecision'] as const) {
    const value = settings[key];
    if (value !== undefined && (value < 0 || value > MAX_DISPLAY_PRECISION))
      return `${key} must be an integer 0..${MAX_DISPLAY_PRECISION} (got ${value})`;
  }
  for (const key of ['prefix', 'suffix'] as const) {
    const value = settings[key];
    if (value !== undefined && value.length > MAX_DIMENSION_AFFIX_LENGTH)
      return `${key} is longer than ${MAX_DIMENSION_AFFIX_LENGTH} characters`;
  }
  if (settings.color !== undefined && !isHexColor(settings.color)) return `color must be a #rrggbb hex string (got "${settings.color}")`;
  return null;
}

const definedSettings = (settings: SettingsInput): DimensionStyleSettings =>
  Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)) as DimensionStyleSettings;

const styleOf = (doc: CadDocument, id: string): DimensionStyle | undefined =>
  doc.dimensionStyles !== undefined && Object.hasOwn(doc.dimensionStyles, id) ? doc.dimensionStyles[id] : undefined;

const withStyle = (doc: CadDocument, style: DimensionStyle): CadDocument => ({
  ...doc,
  dimensionStyles: { ...doc.dimensionStyles, [style.id]: style },
});

const dimensionsOf = (doc: CadDocument): DimensionEntity[] =>
  doc.order.map((id) => doc.entities[id]).filter((entity): entity is DimensionEntity => entity?.kind === 'dimension');

const describeSettings = (settings: DimensionStyleSettings): string => {
  const parts = Object.entries(settings).map(([key, value]) => `${key} ${JSON.stringify(value)}`);
  return parts.length === 0 ? 'renderer defaults' : parts.join(', ');
};

/**
 * @affects creates 1 dimension style in `dimensionStyles`; affected = [] (styles are not entities); data = { styleId }
 * @invariant with makeActive the new style becomes `activeDimensionStyleId`
 * @failure empty name, name already used, non-positive textHeight / arrowSize, negative gap / beyond, precision out of range, affix too long,
 *   non-#rrggbb color -> no-op
 */
export const createDimensionStyle = defineCommand({
  name: 'create_dimension_style',
  description:
    'Create a named dimension style: value text height, arrowhead size and shape, extension-line gap and overshoot, decimals, decimal separator, ' +
    'prefix / suffix and colour. Fields not given keep the renderer defaults. Apply it with apply_dimension_style, or pass makeActive so every new ' +
    'add_dimension uses it. The style is read by the 2D viewport, render_view, scene_snapshot and the DXF / SVG drafting exports. data.styleId is its id.',
  params: z.object({
    name: z.string().describe('Unique display name, e.g. "ISO 129 - 3.5" or "Architectural".'),
    ...settingsFields,
    makeActive: z.boolean().describe('Also make it the active style that add_dimension gives new dimensions. Default false.').optional(),
  }),
  run: (doc, { name, makeActive, ...settings }): CommandResult => {
    const trimmed = name.trim();
    if (trimmed === '') return noop(doc, 'create_dimension_style: name must not be empty; no style created.');
    if (Object.values(doc.dimensionStyles ?? {}).some((style) => style.name === trimmed))
      return noop(doc, `create_dimension_style: a style named "${trimmed}" already exists; no style created.`);
    const problem = settingsProblem(settings);
    if (problem !== null) return noop(doc, `create_dimension_style: ${problem}; no style created.`);
    const style: DimensionStyle = { id: nextId('dimstyle'), name: trimmed, ...definedSettings(settings) };
    const created = withStyle(doc, style);
    const document = makeActive === true ? { ...created, activeDimensionStyleId: style.id } : created;
    return {
      ...changed(
        document,
        `Created dimension style ${style.id} ("${trimmed}"): ${describeSettings(definedSettings(settings))}.${makeActive === true ? ' It is now the active style.' : ''}`,
        [],
      ),
      data: { styleId: style.id },
    };
  },
});

/**
 * @affects updates the given fields of 1 dimension style; dimensions using it redraw; affected = ids of the dimensions using it
 * @invariant fields not given are kept; `reset` fields return to the renderer defaults
 * @failure unknown style, nothing to change, empty or duplicate name, invalid field -> no-op
 */
export const updateDimensionStyle = defineCommand({
  name: 'update_dimension_style',
  annotations: { idempotent: true },
  description:
    'Change fields of a dimension style (same fields as create_dimension_style); every dimension using it redraws. `reset` lists fields to drop ' +
    'back to the renderer default. affected lists the dimensions that use the style.',
  params: z.object({
    styleId: z.string().describe('Id of the style (from create_dimension_style or list_dimension_styles).'),
    name: z.string().describe('New unique display name.').optional(),
    ...settingsFields,
    reset: z
      .array(
        z.enum([
          'textHeight',
          'arrowSize',
          'arrowStyle',
          'extensionGap',
          'extensionBeyond',
          'precision',
          'angularPrecision',
          'decimalSeparator',
          'prefix',
          'suffix',
          'color',
        ]),
      )
      .describe('Fields to remove from the style so the renderer default applies again.')
      .optional(),
  }),
  run: (doc, { styleId, name, reset = [], ...settings }): CommandResult => {
    const style = styleOf(doc, styleId);
    if (style === undefined) return noop(doc, `update_dimension_style: no dimension style '${styleId}'.`);
    const patch = definedSettings(settings);
    if (name === undefined && Object.keys(patch).length === 0 && reset.length === 0)
      return noop(doc, 'update_dimension_style: give at least one field to change (or reset); nothing changed.');
    const trimmed = name?.trim();
    if (trimmed === '') return noop(doc, 'update_dimension_style: name must not be empty; nothing changed.');
    if (trimmed !== undefined && Object.values(doc.dimensionStyles ?? {}).some((other) => other.id !== styleId && other.name === trimmed))
      return noop(doc, `update_dimension_style: a style named "${trimmed}" already exists; nothing changed.`);
    const problem = settingsProblem(settings);
    if (problem !== null) return noop(doc, `update_dimension_style: ${problem}; nothing changed.`);
    const kept = Object.fromEntries(Object.entries(style).filter(([key]) => !(reset as readonly string[]).includes(key))) as DimensionStyle;
    const next: DimensionStyle = { ...kept, ...patch, id: style.id, name: trimmed ?? style.name };
    if (JSON.stringify(Object.entries(next).sort()) === JSON.stringify(Object.entries(style).sort()))
      return noop(doc, `update_dimension_style: style ${styleId} already has those values; nothing changed.`);
    const users = dimensionsOf(doc)
      .filter((dimension) => dimension.styleId === styleId)
      .map((dimension) => dimension.id);
    return changed(
      withStyle(doc, next),
      `Updated dimension style ${styleId} ("${next.name}"): ${describeSettings(Object.fromEntries(Object.entries(next).filter(([key]) => key !== 'id' && key !== 'name')))}; ${users.length} dimension(s) use it.`,
      users,
    );
  },
});

/**
 * @affects removes 1 dimension style; its dimensions move to `replaceWith` (or to no style); affected = those dimension ids
 * @invariant no dimension and no `activeDimensionStyleId` names a removed style
 * @failure unknown style or unknown / same replaceWith -> no-op
 */
export const deleteDimensionStyle = defineCommand({
  name: 'delete_dimension_style',
  annotations: { destructive: true },
  description:
    'Delete a dimension style. Dimensions that use it switch to `replaceWith` (another style id) or, without it, back to the renderer defaults; ' +
    'if it was the active style, `replaceWith` (or none) becomes active. affected lists the dimensions that changed.',
  params: z.object({
    styleId: z.string().describe('Id of the style to delete.'),
    replaceWith: z.string().describe('Id of the style its dimensions use instead. Omit to clear their style.').optional(),
  }),
  run: (doc, { styleId, replaceWith }): CommandResult => {
    if (styleOf(doc, styleId) === undefined) return noop(doc, `delete_dimension_style: no dimension style '${styleId}'.`);
    if (replaceWith !== undefined && (replaceWith === styleId || styleOf(doc, replaceWith) === undefined))
      return noop(doc, `delete_dimension_style: replaceWith '${replaceWith}' must be another existing style; nothing deleted.`);
    const users = dimensionsOf(doc).filter((dimension) => dimension.styleId === styleId);
    const moved = users.map((dimension): Entity => restyled(dimension, replaceWith));
    const { [styleId]: _removed, ...remaining } = doc.dimensionStyles ?? {};
    const { activeDimensionStyleId, ...rest } = replaceEntitiesById(doc, moved);
    const active = activeDimensionStyleId === styleId ? replaceWith : activeDimensionStyleId;
    const document: CadDocument = {
      ...rest,
      dimensionStyles: remaining,
      ...(active === undefined ? {} : { activeDimensionStyleId: active }),
    };
    return changed(
      document,
      `Deleted dimension style ${styleId}; ${users.length} dimension(s) moved to ${replaceWith === undefined ? 'no style' : replaceWith}.`,
      users.map((dimension) => dimension.id),
    );
  },
});

const restyled = (dimension: DimensionEntity, styleId: string | undefined): DimensionEntity => {
  const { styleId: _old, ...rest } = dimension;
  return styleId === undefined ? rest : { ...rest, styleId };
};

/**
 * @affects sets `styleId` on the given dimensions (all dimensions when entityIds is omitted); affected = those ids
 * @failure unknown style, an id that is not a dimension, no dimension to restyle -> no-op
 */
export const applyDimensionStyle = defineCommand({
  name: 'apply_dimension_style',
  annotations: { idempotent: true },
  description:
    'Give dimensions a dimension style (styleId) or clear it (styleId null: back to the renderer defaults). entityIds lists the dimension ids; omit ' +
    'it to restyle every dimension in the document.',
  params: z.object({
    styleId: z.string().nullable().describe('Style id to apply, or null to clear the style of the dimensions.'),
    entityIds: z.array(z.string()).describe('Dimension entity ids. Omit for every dimension of the document.').optional(),
  }),
  run: (doc, { styleId, entityIds }): CommandResult => {
    if (styleId !== null && styleOf(doc, styleId) === undefined)
      return noop(doc, `apply_dimension_style: no dimension style '${styleId}'.`);
    const targets: DimensionEntity[] = [];
    for (const id of entityIds ?? dimensionsOf(doc).map((dimension) => dimension.id)) {
      const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
      if (entity?.kind !== 'dimension')
        return noop(
          doc,
          `apply_dimension_style: '${id}' is ${entity === undefined ? 'not in the document' : `a ${entity.kind}, not a dimension`}.`,
        );
      targets.push(entity);
    }
    if (targets.length === 0)
      return noop(
        doc,
        entityIds === undefined
          ? 'apply_dimension_style: the document has no dimensions to restyle.'
          : 'apply_dimension_style: entityIds is empty; nothing to restyle.',
      );
    const moved = targets.map((dimension) => restyled(dimension, styleId ?? undefined));
    return changed(
      replaceEntitiesById(doc, moved),
      `${styleId === null ? 'Cleared the dimension style of' : `Applied dimension style ${styleId} to`} ${targets.length} dimension(s).`,
      targets.map((dimension) => dimension.id),
    );
  },
});

/**
 * @affects sets or clears `activeDimensionStyleId` (the style add_dimension gives new dimensions); affected = []
 * @failure unknown style -> no-op
 */
export const setActiveDimensionStyle = defineCommand({
  name: 'set_active_dimension_style',
  annotations: { idempotent: true },
  description:
    'Choose the dimension style that add_dimension gives new dimensions when it is not passed a style; null clears it (new dimensions then use the ' +
    'renderer defaults). Existing dimensions are not changed (use apply_dimension_style).',
  params: z.object({ styleId: z.string().nullable().describe('Style id, or null for none.') }),
  run: (doc, { styleId }): CommandResult => {
    if (styleId !== null && styleOf(doc, styleId) === undefined)
      return noop(doc, `set_active_dimension_style: no dimension style '${styleId}'.`);
    const { activeDimensionStyleId: _previous, ...rest } = doc;
    return changed(
      styleId === null ? rest : { ...rest, activeDimensionStyleId: styleId },
      styleId === null ? 'New dimensions use no dimension style.' : `New dimensions use dimension style ${styleId}.`,
      [],
    );
  },
});

/**
 * @affects none (query); data = { activeStyleId, styles: [{ ...style, dimensionCount }] }
 */
export const listDimensionStyles = defineCommand({
  name: 'list_dimension_styles',
  annotations: { readOnly: true },
  description: 'List the dimension styles of the document with their fields, how many dimensions use each, and the active style.',
  params: z.object({}),
  run: (doc): CommandResult => {
    const dimensions = dimensionsOf(doc);
    const styles = Object.values(doc.dimensionStyles ?? {}).map((style) => ({
      ...style,
      dimensionCount: dimensions.filter((dimension) => dimension.styleId === style.id).length,
    }));
    const active = doc.activeDimensionStyleId ?? null;
    return {
      document: doc,
      summary:
        styles.length === 0
          ? 'No dimension styles (dimensions use the renderer defaults).'
          : `${styles.length} dimension style(s): ${styles.map((style) => `${style.id} "${style.name}" (${style.dimensionCount} dimension(s))`).join(', ')}; active: ${active ?? 'none'}.`,
      affected: [],
      data: { activeStyleId: active, styles },
    };
  },
});
