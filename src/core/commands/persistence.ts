/**
 * @command load_document
 * @pure
 * @layer core/commands
 * @affects replaces all entities in the document with the loaded ones
 * @invariant parsed document satisfies CadDocument structural + value constraints
 * @failure invalid JSON / wrong format or version / structural or value validation error -> no-op, affected:[]
 */

import type {
  CadDocument,
  Component,
  Configuration,
  DocumentUnit,
  EntityKind,
  FeatureStep,
  Layer,
  CameraState,
  Vec3,
  Parameter,
  Animation,
  Material,
  Recipe,
} from '../model/types';
import type { CommandDefinition, CommandResult } from './types';

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

interface DocumentEnvelope {
  format: 'llull-document';
  version: 1;
  document: CadDocument;
}

// ---------------------------------------------------------------------------
// Current schema version — bump whenever a breaking field is added.
// Migration steps in `migrate()` handle older documents.
// ---------------------------------------------------------------------------
const CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a CadDocument to a stable JSON string.
 *
 * Wraps the document in an envelope `{ format: 'llull-document', version: 1, document }`
 * so future schema migrations can be detected. The output is deterministic (standard
 * JSON.stringify with no replacer); entity ordering follows `doc.order`.
 */
export function serializeDocument(doc: CadDocument): string {
  const envelope: DocumentEnvelope = {
    format: 'llull-document',
    version: CURRENT_SCHEMA_VERSION,
    document: doc,
  };
  return JSON.stringify(envelope);
}

// ---------------------------------------------------------------------------
// Primitive type-narrowing helpers (no `any`)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** A Vec3 where all three components are finite numbers. */
function isFiniteVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x))
  );
}

/** /^#[0-9a-fA-F]{6}$/ — the only hex format accepted by the renderer. */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function isValidHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_COLOR_RE.test(v);
}

/** All legal entity kinds (must stay in sync with EntityKind union in types.ts). */
const VALID_ENTITY_KINDS: ReadonlySet<string> = new Set<EntityKind>([
  // 3D solids
  'box', 'cylinder', 'sphere', 'extrusion', 'mesh', 'cone', 'torus', 'wedge', 'pyramid', 'revolution',
  // 2D shapes
  'line', 'polyline', 'arc', 'circle', 'rectangle', 'point', 'ellipse', 'spline', 'text', 'dimension',
  // Assembly
  'instance',
]);

const VALID_UNITS: ReadonlySet<string> = new Set<DocumentUnit>(['mm', 'cm', 'm', 'in', 'ft']);

// ---------------------------------------------------------------------------
// Structural + value validators
// ---------------------------------------------------------------------------

function validateCamera(v: unknown): v is CameraState {
  if (!isRecord(v)) return false;
  return (
    isFiniteVec3(v['target']) &&
    typeof v['azimuth'] === 'number' && Number.isFinite(v['azimuth']) &&
    typeof v['polar'] === 'number' && Number.isFinite(v['polar']) &&
    typeof v['distance'] === 'number' && Number.isFinite(v['distance'])
  );
}

function validateLayer(v: unknown): v is Layer {
  if (!isRecord(v)) return false;
  return (
    typeof v['id'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['visible'] === 'boolean' &&
    typeof v['locked'] === 'boolean'
  );
}

/**
 * Validate the base fields shared by all entities, plus kind-specific numeric fields.
 * Returns a descriptive error string on failure, or `null` on success.
 */
function validateEntityValue(v: unknown): string | null {
  if (!isRecord(v)) return 'entity is not an object';

  const id = v['id'];
  const kind = v['kind'];
  const position = v['position'];
  const rotation = v['rotation'];
  const layerId = v['layerId'];
  const color = v['color'];

  if (typeof id !== 'string') return 'entity.id is not a string';
  if (typeof kind !== 'string') return `entity ${id}: kind is not a string`;
  if (!VALID_ENTITY_KINDS.has(kind)) return `entity ${id}: unknown kind '${kind}'`;
  if (!isFiniteVec3(position)) return `entity ${id}: position must be a Vec3 of finite numbers`;
  if (!isFiniteVec3(rotation)) return `entity ${id}: rotation must be a Vec3 of finite numbers`;
  if (typeof layerId !== 'string') return `entity ${id}: layerId is not a string`;
  if (!isValidHexColor(color)) return `entity ${id}: color '${String(color)}' is not a valid hex color (#rrggbb)`;

  // Kind-specific numeric invariants.
  switch (kind) {
    case 'box':
    case 'wedge': {
      const size = v['size'];
      if (!Array.isArray(size) || size.length !== 3) return `entity ${id} (${kind}): size must be a 3-element array`;
      for (let i = 0; i < 3; i++) {
        const c = size[i] as unknown;
        if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0)
          return `entity ${id} (${kind}): size[${i}] must be finite and > 0, got ${String(c)}`;
      }
      break;
    }
    case 'cylinder':
    case 'cone': {
      const radius = v['radius'];
      const height = v['height'];
      if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0)
        return `entity ${id} (${kind}): radius must be finite and > 0, got ${String(radius)}`;
      if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0)
        return `entity ${id} (${kind}): height must be finite and > 0, got ${String(height)}`;
      break;
    }
    case 'sphere': {
      const radius = v['radius'];
      if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0)
        return `entity ${id} (sphere): radius must be finite and > 0, got ${String(radius)}`;
      break;
    }
    case 'torus': {
      const ringRadius = v['ringRadius'];
      const tubeRadius = v['tubeRadius'];
      if (typeof ringRadius !== 'number' || !Number.isFinite(ringRadius) || ringRadius <= 0)
        return `entity ${id} (torus): ringRadius must be finite and > 0, got ${String(ringRadius)}`;
      if (typeof tubeRadius !== 'number' || !Number.isFinite(tubeRadius) || tubeRadius <= 0)
        return `entity ${id} (torus): tubeRadius must be finite and > 0, got ${String(tubeRadius)}`;
      break;
    }
    case 'pyramid': {
      const baseWidth = v['baseWidth'];
      const baseDepth = v['baseDepth'];
      const height = v['height'];
      if (typeof baseWidth !== 'number' || !Number.isFinite(baseWidth) || baseWidth <= 0)
        return `entity ${id} (pyramid): baseWidth must be finite and > 0, got ${String(baseWidth)}`;
      if (typeof baseDepth !== 'number' || !Number.isFinite(baseDepth) || baseDepth <= 0)
        return `entity ${id} (pyramid): baseDepth must be finite and > 0, got ${String(baseDepth)}`;
      if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0)
        return `entity ${id} (pyramid): height must be finite and > 0, got ${String(height)}`;
      break;
    }
    case 'extrusion': {
      const depth = v['depth'];
      if (typeof depth !== 'number' || !Number.isFinite(depth))
        return `entity ${id} (extrusion): depth must be a finite number, got ${String(depth)}`;
      break;
    }
    // 2D shapes: radius-bearing kinds
    case 'arc':
    case 'circle': {
      const radius = v['radius'];
      if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0)
        return `entity ${id} (${kind}): radius must be finite and > 0, got ${String(radius)}`;
      break;
    }
    case 'rectangle': {
      const width = v['width'];
      const height = v['height'];
      if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0)
        return `entity ${id} (rectangle): width must be finite and > 0, got ${String(width)}`;
      if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0)
        return `entity ${id} (rectangle): height must be finite and > 0, got ${String(height)}`;
      break;
    }
    case 'ellipse': {
      const radiusX = v['radiusX'];
      const radiusY = v['radiusY'];
      if (typeof radiusX !== 'number' || !Number.isFinite(radiusX) || radiusX <= 0)
        return `entity ${id} (ellipse): radiusX must be finite and > 0, got ${String(radiusX)}`;
      if (typeof radiusY !== 'number' || !Number.isFinite(radiusY) || radiusY <= 0)
        return `entity ${id} (ellipse): radiusY must be finite and > 0, got ${String(radiusY)}`;
      break;
    }
    case 'text': {
      const height = v['height'];
      if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0)
        return `entity ${id} (text): height must be finite and > 0, got ${String(height)}`;
      break;
    }
    case 'instance': {
      const componentId = v['componentId'];
      if (typeof componentId !== 'string' || componentId.length === 0)
        return `entity ${id} (instance): componentId must be a non-empty string, got ${String(componentId)}`;
      // scale is optional; when present must be a 3-element finite array
      const scale = v['scale'];
      if (scale !== undefined) {
        if (!Array.isArray(scale) || scale.length !== 3)
          return `entity ${id} (instance): scale must be a 3-element array when present`;
        for (let i = 0; i < 3; i++) {
          const c = scale[i] as unknown;
          if (typeof c !== 'number' || !Number.isFinite(c))
            return `entity ${id} (instance): scale[${i}] must be a finite number, got ${String(c)}`;
        }
      }
      break;
    }
    // 'line', 'polyline', 'point', 'spline', 'dimension', 'mesh' — no extra numeric invariants enforced here
    default:
      break;
  }

  return null; // valid
}

/**
 * Validate a Material entry. Returns a descriptive error string on failure, or `null` on success.
 */
function validateMaterialValue(name: string, v: unknown): string | null {
  if (!isRecord(v)) return `material '${name}' is not an object`;
  const { density, color, metalness, roughness } = v;
  if (typeof density !== 'number' || !Number.isFinite(density) || density <= 0)
    return `material '${name}': density must be finite and > 0, got ${String(density)}`;
  if (!isValidHexColor(color))
    return `material '${name}': color '${String(color)}' is not a valid hex color (#rrggbb)`;
  if (typeof metalness !== 'number' || !Number.isFinite(metalness) || metalness < 0 || metalness > 1)
    return `material '${name}': metalness must be a finite number in [0, 1], got ${String(metalness)}`;
  if (typeof roughness !== 'number' || !Number.isFinite(roughness) || roughness < 0 || roughness > 1)
    return `material '${name}': roughness must be a finite number in [0, 1], got ${String(roughness)}`;
  return null;
}

/**
 * Validate a Parameter entry. Returns a descriptive error string or `null`.
 */
function validateParameterValue(name: string, v: unknown): string | null {
  if (!isRecord(v)) return `parameter '${name}' is not an object`;
  if (typeof v['name'] !== 'string') return `parameter '${name}': name field must be a string`;
  if (typeof v['expression'] !== 'string') return `parameter '${name}': expression must be a string`;
  if (typeof v['value'] !== 'number') return `parameter '${name}': value must be a number`;
  return null;
}

/**
 * Validate a Recipe entry. Returns a descriptive error string on failure, or `null` on success.
 */
function validateRecipeValue(name: string, v: unknown): string | null {
  if (!isRecord(v)) return `recipe '${name}' is not an object`;
  if (typeof v['name'] !== 'string') return `recipe '${name}': name field must be a string`;
  if (!Array.isArray(v['steps'])) return `recipe '${name}': steps must be an array`;
  for (let i = 0; i < v['steps'].length; i++) {
    const step = v['steps'][i] as unknown;
    if (!isRecord(step)) return `recipe '${name}': steps[${i}] is not an object`;
    if (typeof step['id'] !== 'string') return `recipe '${name}': steps[${i}].id must be a string`;
    if (typeof step['name'] !== 'string') return `recipe '${name}': steps[${i}].name must be a string`;
  }
  return null;
}

/**
 * Structural validation of the raw document record (shape-only, no value checks).
 * Value checks are done in `validateDocumentValues`.
 */
function validateDocumentShape(v: unknown): v is Record<string, unknown> {
  if (!isRecord(v)) return false;
  const { entities, order, layers, layerOrder, selection, camera } = v;
  if (!isRecord(entities)) return false;
  if (!isStringArray(order)) return false;
  if (!isStringArray(layerOrder)) return false;
  if (!isStringArray(selection)) return false;
  if (!isRecord(layers)) return false;
  if (!validateCamera(camera)) return false;
  return true;
}

/**
 * Deep value validation of the document record. Returns an array of error strings.
 * An empty array means the document is valid.
 */
function validateDocumentValues(v: Record<string, unknown>): string[] {
  const errors: string[] = [];

  // Entities
  const entities = v['entities'] as Record<string, unknown>;
  for (const [eid, entity] of Object.entries(entities)) {
    const err = validateEntityValue(entity);
    if (err !== null) errors.push(err);

    // Validate layer reference
    const layerIdVal = isRecord(entity) ? entity['layerId'] : undefined;
    const layers = v['layers'] as Record<string, unknown>;
    if (typeof layerIdVal === 'string' && !Object.prototype.hasOwnProperty.call(layers, layerIdVal)) {
      errors.push(`entity ${eid}: layerId '${layerIdVal}' does not reference a known layer`);
    }
  }

  // Layers
  const layers = v['layers'] as Record<string, unknown>;
  for (const layer of Object.values(layers)) {
    if (!validateLayer(layer)) errors.push(`layer entry is malformed: ${JSON.stringify(layer)}`);
  }

  // Materials (optional field — only validate if present and non-empty)
  if (isRecord(v['materials'])) {
    const mats = v['materials'] as Record<string, unknown>;
    for (const [mname, mat] of Object.entries(mats)) {
      const err = validateMaterialValue(mname, mat);
      if (err !== null) errors.push(err);
    }
  }

  // Parameters (optional field — only validate if present and non-empty)
  if (isRecord(v['parameters'])) {
    const params = v['parameters'] as Record<string, unknown>;
    for (const [pname, param] of Object.entries(params)) {
      const err = validateParameterValue(pname, param);
      if (err !== null) errors.push(err);
    }
  }

  // Recipes (optional field — only validate if present)
  if (isRecord(v['recipes'])) {
    const recs = v['recipes'] as Record<string, unknown>;
    for (const [rname, rec] of Object.entries(recs)) {
      const err = validateRecipeValue(rname, rec);
      if (err !== null) errors.push(err);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Migration seam
// ---------------------------------------------------------------------------

/**
 * Upgrade a raw document object from an older schema version to the current one.
 *
 * This is the SINGLE place where back-compat defaults and structural upgrades live.
 * When a new optional field is added to `CadDocument`, add a default here instead of
 * scattering ad-hoc defaults through `deserializeDocument`.
 *
 * @param raw   - The raw document object (already passed shape validation).
 * @param _fromVersion - The envelope `version` field (for future multi-step migrations).
 * @returns A new object with all missing fields filled in to current defaults.
 */
function migrate(raw: Record<string, unknown>, _fromVersion: number): Record<string, unknown> {
  // Units
  const units: DocumentUnit =
    typeof raw['units'] === 'string' && VALID_UNITS.has(raw['units']) ? (raw['units'] as DocumentUnit) : 'mm';

  // Display precision
  const displayPrecision: number =
    typeof raw['displayPrecision'] === 'number' &&
    raw['displayPrecision'] >= 0 &&
    Number.isInteger(raw['displayPrecision'])
      ? raw['displayPrecision']
      : 3;

  // Parameters
  const parameters: Record<string, Parameter> = isRecord(raw['parameters'])
    ? (raw['parameters'] as Record<string, Parameter>)
    : {};

  // Animations
  const animations: Record<string, Animation> = isRecord(raw['animations'])
    ? (raw['animations'] as Record<string, Animation>)
    : {};

  // Feature history
  const featureHistory: FeatureStep[] = Array.isArray(raw['featureHistory'])
    ? (raw['featureHistory'] as FeatureStep[])
    : [];

  // Configurations
  const configurations: Record<string, Configuration> = isRecord(raw['configurations'])
    ? (raw['configurations'] as Record<string, Configuration>)
    : {};

  // Materials
  const materials: Record<string, Material> = isRecord(raw['materials'])
    ? (raw['materials'] as Record<string, Material>)
    : {};

  // Groups (added after initial release)
  const groups: Record<string, unknown> = isRecord(raw['groups'])
    ? (raw['groups'] as Record<string, unknown>)
    : {};

  // Recipes (added in AI6)
  const recipes: Record<string, Recipe> = isRecord(raw['recipes'])
    ? (raw['recipes'] as Record<string, Recipe>)
    : {};

  // Components (added in NF1 — assembly support)
  const components: Record<string, Component> = isRecord(raw['components'])
    ? (raw['components'] as Record<string, Component>)
    : {};

  return {
    ...raw,
    units,
    displayPrecision,
    parameters,
    animations,
    featureHistory,
    configurations,
    materials,
    groups,
    recipes,
    components,
  };
}

// ---------------------------------------------------------------------------
// Public deserialization API
// ---------------------------------------------------------------------------

/**
 * Parse and validate a JSON string produced by `serializeDocument`.
 *
 * Throws a descriptive `Error` on any failure:
 * - invalid JSON
 * - missing or wrong `format` field (expected 'llull-document')
 * - wrong or missing `version` field (expected 1)
 * - structurally invalid `document` (missing required fields / wrong types)
 * - value-level validation failure (NaN/infinite size, bad hex color, unknown kind,
 *   invalid material density/metalness/roughness, dangling layerId reference)
 *
 * The error message names the specific field that failed so callers can surface it.
 * `load_document` catches this and returns it as a graceful no-op summary.
 *
 * Back-compat: documents missing optional fields (`parameters`, `configurations`,
 * `materials`, `featureHistory`, `animations`, `groups`) load via `migrate()` which
 * fills in correct defaults — no manual ad-hoc defaults scattered elsewhere.
 */
export function deserializeDocument(json: string): CadDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('load_document: invalid JSON — could not parse input string.');
  }

  if (!isRecord(parsed)) {
    throw new Error('load_document: expected a JSON object at the root level.');
  }

  if (parsed['format'] !== 'llull-document') {
    throw new Error(
      `load_document: unrecognized format '${String(parsed['format'])}' — expected 'llull-document'.`,
    );
  }

  if (parsed['version'] !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `load_document: unsupported version ${String(parsed['version'])} — expected ${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  const rawDoc = parsed['document'];
  if (!validateDocumentShape(rawDoc)) {
    throw new Error(
      'load_document: document structure is invalid — missing or malformed required fields ' +
        '(entities, order, layers, layerOrder, selection, camera).',
    );
  }

  // Apply migration (fills in back-compat defaults for optional fields).
  const migratedDoc = migrate(rawDoc, parsed['version'] as number);

  // Deep value validation on the migrated document.
  const valueErrors = validateDocumentValues(migratedDoc);
  if (valueErrors.length > 0) {
    throw new Error(
      `load_document: document contains invalid values:\n  ${valueErrors.join('\n  ')}`,
    );
  }

  return migratedDoc as unknown as CadDocument;
}

// ---------------------------------------------------------------------------
// load_document command
// ---------------------------------------------------------------------------

interface LoadDocumentParams {
  json: string;
}

export const loadDocument: CommandDefinition<LoadDocumentParams> = {
  name: 'load_document',
  description:
    'Replace the current document with one parsed from a serialized JSON string ' +
    'produced by serializeDocument (envelope format: llull-document v1). ' +
    'On parse or validation failure the document is left unchanged.',
  annotations: { metaHistory: true, idempotent: true },
  paramsSchema: {
    type: 'object',
    properties: {
      json: {
        type: 'string',
        description:
          'A JSON string produced by serializeDocument — the full llull-document v1 envelope ' +
          '({ format: "llull-document", version: 1, document: { ... } }). ' +
          'Must contain a valid CadDocument with entities, order, layers, layerOrder, selection, and camera.',
      },
    },
    required: ['json'],
  },
  run: (doc, { json }): CommandResult => {
    let parsed: CadDocument;
    try {
      parsed = deserializeDocument(json);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { document: doc, summary: message, affected: [] };
    }

    const entityCount = Object.keys(parsed.entities).length;
    const layerCount = Object.keys(parsed.layers).length;

    return {
      document: parsed,
      summary: `Loaded document: ${entityCount} ${entityCount === 1 ? 'entity' : 'entities'}, ${layerCount} ${layerCount === 1 ? 'layer' : 'layers'}.`,
      affected: parsed.order,
    };
  },
};
