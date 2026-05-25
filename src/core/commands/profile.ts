/**
 * @command extrude_sketch
 * @command revolve_profile
 * @pure
 * @layer core/commands
 * @affects extrude_sketch: creates 1 extrusion entity from a closed 2D shape entity
 * @affects revolve_profile: no-op stub; reserved for future surface-of-revolution kernel
 * @invariant extrude_sketch: source entity remains in document; only depth > 0 is accepted
 * @failure missing id -> no-op, affected:[]
 * @failure non-closed or non-2D entity -> no-op, affected:[]
 * @failure depth <= 0 -> no-op, affected:[]
 * @failure revolve_profile -> always no-op (not yet implemented)
 */

import type { CadDocument, Entity, ExtrusionEntity } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';

/** Number of polygon segments used to approximate a circle. */
const CIRCLE_SEGMENTS = 32;

/** Helper: clone the document shallowly adding a new entity. */
function withEntity(doc: CadDocument, entity: Entity): CadDocument {
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: [...doc.order, entity.id],
  };
}

// ---------------------------------------------------------------------------
// extrude_sketch
// ---------------------------------------------------------------------------

interface ExtrudeSketchParams {
  /** Id of the existing closed 2D shape entity to extrude (circle, rectangle, or closed polyline). */
  id: string;
  /** Extrusion depth in world units along Z. Must be > 0. */
  depth: number;
}

/**
 * @command extrude_sketch
 * @pure
 * Derives a polygon profile from the given closed 2D shape entity and builds a
 * new extrusion solid. The source entity is kept in the document (non-destructive).
 *
 * Profile derivation per kind:
 *   circle      → 32-segment regular polygon centred at entity.center
 *   rectangle   → 4 corners from lower-left origin (respects B1 convention)
 *   polyline    → its points when closed === true; no-op when open
 *   line / arc / open polyline / point / 3D solid → graceful no-op
 */
export const extrudeSketch: CommandDefinition<ExtrudeSketchParams> = {
  name: 'extrude_sketch',
  description:
    'Extrude a closed 2D shape entity (circle, rectangle, or closed polyline) into a 3D extrusion solid. Keeps the source entity. depth must be > 0.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Id of the closed 2D shape entity to extrude. Must be a circle, rectangle, or polyline with closed=true.',
      },
      depth: {
        type: 'number',
        description: 'Extrusion depth in world units along the Z axis. Must be greater than 0.',
      },
    },
    required: ['id', 'depth'],
  },
  run: (doc, { id, depth }): CommandResult => {
    // --- guard: depth ---
    if (typeof depth !== 'number' || depth <= 0) {
      return {
        document: doc,
        summary: `extrude_sketch: depth must be > 0 (got ${depth}); entity ${id} unchanged.`,
        affected: [],
      };
    }

    // --- guard: entity exists ---
    const source = doc.entities[id];
    if (!source) {
      return {
        document: doc,
        summary: `extrude_sketch: no entity with id "${id}".`,
        affected: [],
      };
    }

    // --- derive profile polygon ---
    let profile: ReadonlyArray<readonly [number, number]> | null = null;

    if (source.kind === 'circle') {
      const { center, radius } = source;
      const pts: Array<readonly [number, number]> = [];
      for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const angle = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
        pts.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
      }
      profile = pts;
    } else if (source.kind === 'rectangle') {
      const { width, height } = source;
      // lower-left origin (B1 convention); corners in CCW order
      profile = [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
      ];
    } else if (source.kind === 'polyline') {
      if (!source.closed) {
        return {
          document: doc,
          summary: `extrude_sketch: polyline "${id}" is not closed; cannot extrude an open profile.`,
          affected: [],
        };
      }
      if (source.points.length < 3) {
        return {
          document: doc,
          summary: `extrude_sketch: polyline "${id}" has fewer than 3 points; not a valid closed profile.`,
          affected: [],
        };
      }
      profile = source.points as ReadonlyArray<readonly [number, number]>;
    } else {
      // line, arc, point, 3D solids — not a closed 2D profile
      return {
        document: doc,
        summary: `extrude_sketch: entity "${id}" (kind="${source.kind}") is not a closed 2D profile. Use a circle, rectangle, or closed polyline.`,
        affected: [],
      };
    }

    // --- build new extrusion ---
    const extId = nextId('ext');
    const extrusion: ExtrusionEntity = {
      id: extId,
      kind: 'extrusion',
      profile,
      depth,
      position: [source.position[0], source.position[1], source.position[2]],
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color: '#c8553d',
    };

    return {
      document: withEntity(doc, extrusion),
      summary: `extrude_sketch: created extrusion "${extId}" from ${source.kind} "${id}" (${profile.length}-point profile, depth=${depth}).`,
      affected: [extId],
    };
  },
};

// ---------------------------------------------------------------------------
// revolve_profile (stub)
// ---------------------------------------------------------------------------

interface RevolveProfileParams {
  /** Id of the 2D profile entity to revolve. */
  id: string;
  /**
   * Revolution angle in radians. Default is 2π (full revolution).
   * Note: this parameter is accepted but ignored in the current stub.
   */
  angle?: number;
}

/**
 * @command revolve_profile
 * @pure
 * STUB — reserved tool name across UI / AI / MCP. Returns a graceful no-op until a
 * surface-of-revolution kernel is available. Planned: revolve a closed 2D profile
 * around the Y axis by `angle` radians (default 2π) to produce a solid of revolution.
 *
 * @failure always returns no-op with explanatory summary; affected:[]
 */
export const revolveProfile: CommandDefinition<RevolveProfileParams> = {
  name: 'revolve_profile',
  description:
    'PLANNED: revolve a closed 2D profile entity around the Y axis to produce a solid of revolution. Currently a stub — registers the tool name for UI/AI/MCP discovery but does not yet produce geometry (requires a surface-of-revolution kernel).',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Id of the closed 2D shape entity to revolve.',
      },
      angle: {
        type: 'number',
        description:
          'Revolution angle in radians. Defaults to 2π (full revolution). Currently ignored (stub).',
      },
    },
    required: ['id'],
  },
  run: (doc, { id }): CommandResult => {
    return {
      document: doc,
      summary: `revolve_profile is not yet implemented (needs a surface-of-revolution kernel); entity "${id}" unchanged.`,
      affected: [],
    };
  },
};
