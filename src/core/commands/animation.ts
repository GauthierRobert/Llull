/**
 * Animation commands — attach declarative motion clips to entities or groups.
 * No physics; the viewport player evaluates these per-frame as a render overlay.
 *
 * @layer core/commands
 */

import type { Animation, AnimationChannel, AnimationTrigger, CadDocument, Vec3 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolve `targetId` to its kind: 'group' if found in doc.groups, 'entity' if
 * found in doc.entities, or null when absent (caller must handle null as no-op).
 */
function resolveTargetKind(
  doc: CadDocument,
  targetId: string,
): 'entity' | 'group' | null {
  if (doc.groups[targetId] !== undefined) return 'group';
  if (doc.entities[targetId] !== undefined) return 'entity';
  return null;
}

/** Normalize an optional number[3] axis param; returns the Vec3 or the default [0,1,0]. */
function toAxis(raw: number[] | undefined): Vec3 {
  if (!raw || raw.length < 3) return [0, 1, 0];
  return [raw[0] ?? 0, raw[1] ?? 1, raw[2] ?? 0];
}

/** Append an Animation to the document, returning a new document (pure). */
function withAnimation(doc: CadDocument, anim: Animation): CadDocument {
  return {
    ...doc,
    animations: { ...doc.animations, [anim.id]: anim },
  };
}

// ---------------------------------------------------------------------------
// animate_spin
// ---------------------------------------------------------------------------

interface AnimateSpinParams {
  targetId: string;
  speed: number;
  axis?: number[];
  channel?: string;
  pivot?: number[];
  trigger?: string;
}

/**
 * @command animate_spin
 * @pure
 * @layer core/commands
 * @affects creates 1 animation record (not an entity)
 * @invariant targetId must exist in doc.entities or doc.groups
 * @failure missing targetId -> no-op, affected:[]
 */
export const animateSpin: CommandDefinition<AnimateSpinParams> = {
  name: 'animate_spin',
  description:
    'Attach a constant-velocity spin animation to an entity or group. ' +
    'For the rotation channel, speed is angular velocity in rad/s (e.g. 6.283 = 1 revolution/s). ' +
    'For the position channel, speed is linear velocity in document units per second. ' +
    'axis is the world-space direction vector ([0,1,0] = Y axis); it need not be unit-length — the viewport normalizes it. ' +
    'pivot is the world-space rotation pivot point; when omitted, the player defaults to the target entity/group position. ' +
    "trigger 'auto' runs the animation under the global Play button; 'click' toggles it when the user clicks the part in the viewport.",
  paramsSchema: {
    type: 'object',
    properties: {
      targetId: {
        type: 'string',
        description: 'Id of the entity or group to animate. Must exist in the document.',
      },
      speed: {
        type: 'number',
        description:
          'Constant velocity: rad/s for the rotation channel (e.g. 6.283 ≈ 1 rev/s), or document units/s for the position channel.',
      },
      axis: {
        type: 'array',
        description:
          'World-space direction vector [x, y, z] the spin acts along. ' +
          'For rotation this is the spin axle; for position this is the translation direction. ' +
          'Need not be unit-length. Defaults to [0, 1, 0] (Y axis).',
        items: { type: 'number' },
      },
      channel: {
        type: 'string',
        description:
          "Transform channel to drive: 'rotation' (default) spins the part; 'position' translates it at constant speed.",
      },
      pivot: {
        type: 'array',
        description:
          'World-space pivot point [x, y, z] for the rotation axis. ' +
          'Only meaningful for the rotation channel. ' +
          'When omitted the player uses the target entity/group position as the pivot.',
        items: { type: 'number' },
      },
      trigger: {
        type: 'string',
        description:
          "When to run the animation: 'auto' (default) starts under the global Play button; " +
          "'click' toggles the animation on/off when the user clicks the animated part in the viewport.",
      },
    },
    required: ['targetId', 'speed'],
  },
  run: (doc, { targetId, speed, axis, channel, pivot, trigger }): CommandResult => {
    const targetKind = resolveTargetKind(doc, targetId);
    if (targetKind === null) {
      return {
        document: doc,
        summary: `animate_spin: no entity or group ${targetId}.`,
        affected: [],
      };
    }

    const resolvedAxis = toAxis(axis);
    const resolvedChannel: AnimationChannel = channel === 'position' ? 'position' : 'rotation';
    const resolvedTrigger: AnimationTrigger = trigger === 'click' ? 'click' : 'auto';

    const id = nextId('anim');

    const anim: Animation = {
      id,
      targetId,
      targetKind,
      channel: resolvedChannel,
      axis: resolvedAxis,
      mode: 'spin',
      speed,
      amplitude: 0,
      frequency: 0,
      trigger: resolvedTrigger,
      ...(pivot && pivot.length >= 3
        ? { pivot: [pivot[0] ?? 0, pivot[1] ?? 0, pivot[2] ?? 0] as Vec3 }
        : {}),
    };

    return {
      document: withAnimation(doc, anim),
      summary: `Spin ${id}: ${targetKind} ${targetId} ${resolvedChannel === 'rotation' ? 'rotates' : 'translates'} about [${resolvedAxis.join(',')}] at ${speed.toFixed(3)} ${resolvedChannel === 'rotation' ? 'rad/s' : 'units/s'} (${resolvedTrigger}).`,
      affected: [],
    };
  },
};

// ---------------------------------------------------------------------------
// animate_oscillate
// ---------------------------------------------------------------------------

interface AnimateOscillateParams {
  targetId: string;
  amplitude: number;
  frequency: number;
  axis?: number[];
  channel?: string;
  pivot?: number[];
  trigger?: string;
}

/**
 * @command animate_oscillate
 * @pure
 * @layer core/commands
 * @affects creates 1 animation record (not an entity)
 * @invariant targetId must exist; amplitude > 0; frequency > 0
 * @failure missing targetId, amplitude <= 0, or frequency <= 0 -> no-op, affected:[]
 */
export const animateOscillate: CommandDefinition<AnimateOscillateParams> = {
  name: 'animate_oscillate',
  description:
    'Attach a sinusoidal oscillation animation to an entity or group. ' +
    'The motion follows sin(2π·frequency·t) · amplitude. ' +
    'amplitude is the peak displacement: radians for the rotation channel, document units for position. ' +
    'frequency is cycles per second (Hz); must be > 0. ' +
    'axis is the world-space direction vector ([0,1,0] = Y axis); it need not be unit-length — the viewport normalizes it. ' +
    'pivot is the world-space rotation pivot; when omitted the player uses the target position. ' +
    "trigger 'auto' runs under the global Play button; 'click' toggles when the user clicks the part.",
  paramsSchema: {
    type: 'object',
    properties: {
      targetId: {
        type: 'string',
        description: 'Id of the entity or group to animate. Must exist in the document.',
      },
      amplitude: {
        type: 'number',
        description:
          'Peak displacement of the oscillation. For the rotation channel this is radians; ' +
          'for the position channel this is document units. Must be greater than 0.',
      },
      frequency: {
        type: 'number',
        description:
          'Number of complete oscillation cycles per second (Hz). Must be greater than 0. ' +
          'Example: 0.5 = one full back-and-forth every 2 seconds; 2 = two cycles per second.',
      },
      axis: {
        type: 'array',
        description:
          'World-space direction vector [x, y, z] the oscillation acts along. ' +
          'For rotation this is the axle; for position this is the translation direction. ' +
          'Need not be unit-length. Defaults to [0, 1, 0] (Y axis).',
        items: { type: 'number' },
      },
      channel: {
        type: 'string',
        description:
          "Transform channel to drive: 'rotation' (default) rocks the part; 'position' slides it back and forth.",
      },
      pivot: {
        type: 'array',
        description:
          'World-space pivot point [x, y, z] for the rotation axis. ' +
          'Only meaningful for the rotation channel. ' +
          'When omitted the player uses the target entity/group position as the pivot.',
        items: { type: 'number' },
      },
      trigger: {
        type: 'string',
        description:
          "When to run the animation: 'auto' (default) starts under the global Play button; " +
          "'click' toggles the animation on/off when the user clicks the animated part in the viewport.",
      },
    },
    required: ['targetId', 'amplitude', 'frequency'],
  },
  run: (doc, { targetId, amplitude, frequency, axis, channel, pivot, trigger }): CommandResult => {
    const targetKind = resolveTargetKind(doc, targetId);
    if (targetKind === null) {
      return {
        document: doc,
        summary: `animate_oscillate: no entity or group ${targetId}.`,
        affected: [],
      };
    }

    if (amplitude <= 0) {
      return {
        document: doc,
        summary: `animate_oscillate: amplitude must be > 0 (got ${amplitude}); ${targetId} unchanged.`,
        affected: [],
      };
    }

    if (frequency <= 0) {
      return {
        document: doc,
        summary: `animate_oscillate: frequency must be > 0 (got ${frequency}); ${targetId} unchanged.`,
        affected: [],
      };
    }

    const resolvedAxis = toAxis(axis);
    const resolvedChannel: AnimationChannel = channel === 'position' ? 'position' : 'rotation';
    const resolvedTrigger: AnimationTrigger = trigger === 'click' ? 'click' : 'auto';

    const id = nextId('anim');

    const anim: Animation = {
      id,
      targetId,
      targetKind,
      channel: resolvedChannel,
      axis: resolvedAxis,
      mode: 'oscillate',
      speed: 0,
      amplitude,
      frequency,
      trigger: resolvedTrigger,
      ...(pivot && pivot.length >= 3
        ? { pivot: [pivot[0] ?? 0, pivot[1] ?? 0, pivot[2] ?? 0] as Vec3 }
        : {}),
    };

    return {
      document: withAnimation(doc, anim),
      summary: `Oscillate ${id}: ${targetKind} ${targetId} ${resolvedChannel === 'rotation' ? 'rocks' : 'slides'} about [${resolvedAxis.join(',')}] ±${amplitude.toFixed(3)} ${resolvedChannel === 'rotation' ? 'rad' : 'units'} at ${frequency.toFixed(3)} Hz (${resolvedTrigger}).`,
      affected: [],
    };
  },
};

// ---------------------------------------------------------------------------
// stop_animation
// ---------------------------------------------------------------------------

interface StopAnimationParams {
  animationId?: string;
  targetId?: string;
}

/**
 * @command stop_animation
 * @pure
 * @layer core/commands
 * @affects removes animations from the document; affected:[] always (animations are not entities)
 * @invariant if animationId given, removes that one; if targetId given, removes all matching that target; if neither, clears ALL
 * @failure animationId given but not found -> no-op with explanatory summary
 */
export const stopAnimation: CommandDefinition<StopAnimationParams> = {
  name: 'stop_animation',
  description:
    'Remove one or more animations from the document. ' +
    'If animationId is provided, only that animation is removed (no-op if not found). ' +
    'If targetId is provided (and animationId is not), all animations whose targetId matches are removed. ' +
    'If neither is provided, ALL animations in the document are cleared. ' +
    'affected is always [] because animations are not entities.',
  paramsSchema: {
    type: 'object',
    properties: {
      animationId: {
        type: 'string',
        description:
          'Id of a specific animation to remove (e.g. "anim-abc123-4"). ' +
          'Takes precedence over targetId when both are given.',
      },
      targetId: {
        type: 'string',
        description:
          'Entity or group id whose animations should all be removed. ' +
          'All animations with this targetId are deleted in one call. ' +
          'Ignored when animationId is also provided.',
      },
    },
    required: [],
  },
  run: (doc, { animationId, targetId }): CommandResult => {
    const existing = doc.animations;

    // --- by animationId ---
    if (animationId !== undefined) {
      if (existing[animationId] === undefined) {
        return {
          document: doc,
          summary: `stop_animation: animation ${animationId} not found; nothing removed.`,
          affected: [],
        };
      }
      const next = { ...existing };
      delete next[animationId];
      return {
        document: { ...doc, animations: next },
        summary: `stop_animation: removed animation ${animationId}.`,
        affected: [],
      };
    }

    // --- by targetId ---
    if (targetId !== undefined) {
      const toRemove = Object.values(existing).filter((a) => a.targetId === targetId);
      if (toRemove.length === 0) {
        return {
          document: doc,
          summary: `stop_animation: no animations found for target ${targetId}; nothing removed.`,
          affected: [],
        };
      }
      const next = { ...existing };
      for (const a of toRemove) {
        delete next[a.id];
      }
      return {
        document: { ...doc, animations: next },
        summary: `stop_animation: removed ${toRemove.length} animation(s) for target ${targetId}.`,
        affected: [],
      };
    }

    // --- clear all ---
    const count = Object.keys(existing).length;
    if (count === 0) {
      return {
        document: doc,
        summary: 'stop_animation: no animations to clear.',
        affected: [],
      };
    }
    return {
      document: { ...doc, animations: {} },
      summary: `stop_animation: cleared all ${count} animation(s).`,
      affected: [],
    };
  },
};
