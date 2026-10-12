/**
 * Animation commands — attach declarative motion clips to entities or groups.
 * No physics; the viewport player evaluates these per-frame as a render overlay.
 *
 * @layer core/commands
 */

import type { Animation, CadDocument, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { nextId } from '../../lib/id';
import { noop, report } from '../noop';

/**
 * Resolve `targetId` to its kind: 'group' if found in doc.groups, 'entity' if
 * found in doc.entities, or null when absent (caller must handle null as no-op).
 */
function resolveTargetKind(doc: CadDocument, targetId: string): 'entity' | 'group' | null {
  if (doc.groups[targetId] !== undefined) return 'group';
  if (doc.entities[targetId] !== undefined) return 'entity';
  return null;
}

/** Normalize an optional number[3] axis param; returns the Vec3 or the default [0,1,0]. */
function toAxis(raw: number[] | undefined): Vec3 {
  if (!raw || raw.length < 3) return [0, 1, 0];
  return [raw[0] ?? 0, raw[1] ?? 1, raw[2] ?? 0];
}

const targetIdField = z
  .string()
  .describe('Id of the entity or group to animate. Must exist in the document.');

const pivotField = z
  .array(z.number())
  .optional()
  .describe(
    'World-space pivot point [x, y, z] for the rotation axis. ' +
      'Only meaningful for the rotation channel. ' +
      'When omitted the player uses the target entity/group position as the pivot.',
  );

const triggerField = z
  .string()
  .optional()
  .describe(
    "When to run the animation: 'auto' (default) starts under the global Play button; " +
      "'click' toggles the animation on/off when the user clicks the animated part in the viewport.",
  );

/** Raw (possibly malformed) target/channel/axis/trigger/pivot inputs of an animate call. */
interface AnimationInput {
  readonly targetId: string;
  readonly targetKind: 'entity' | 'group';
  readonly axis: number[] | undefined;
  readonly channel: string | undefined;
  readonly trigger: string | undefined;
  readonly pivot: number[] | undefined;
}

/** A fresh animation (new id) from raw inputs; unknown channel/trigger fall back to rotation/auto. */
function buildAnimation(
  input: AnimationInput,
  motion:
    | { mode: 'spin'; speed: number }
    | { mode: 'oscillate'; amplitude: number; frequency: number },
): Animation {
  const { pivot } = input;
  return {
    id: nextId('anim'),
    targetId: input.targetId,
    targetKind: input.targetKind,
    channel: input.channel === 'position' ? 'position' : 'rotation',
    axis: toAxis(input.axis),
    mode: motion.mode,
    speed: motion.mode === 'spin' ? motion.speed : 0,
    amplitude: motion.mode === 'oscillate' ? motion.amplitude : 0,
    frequency: motion.mode === 'oscillate' ? motion.frequency : 0,
    trigger: input.trigger === 'click' ? 'click' : 'auto',
    ...(pivot && pivot.length >= 3
      ? { pivot: [pivot[0] ?? 0, pivot[1] ?? 0, pivot[2] ?? 0] as Vec3 }
      : {}),
  };
}

/** Append an Animation to the document, returning a new document (pure). */
function withAnimation(doc: CadDocument, anim: Animation): CadDocument {
  return {
    ...doc,
    animations: { ...doc.animations, [anim.id]: anim },
  };
}

/**
 * @command animate
 * @pure
 * @layer core/commands
 * @affects creates 1 animation record (not an entity)
 * @invariant targetId must exist in doc.entities or doc.groups; spin needs a finite speed;
 *   oscillate needs amplitude > 0 and frequency > 0
 * @failure missing targetId or missing / invalid motion values -> no-op, affected:[]
 */
export const animate = defineCommand({
  name: 'animate',
  description:
    'Attach a motion clip to an entity or group. ' +
    "mode 'spin' = constant velocity: speed is angular velocity in rad/s for the rotation channel " +
    '(e.g. 6.283 = 1 revolution/s) or linear velocity in document units/s for the position channel. ' +
    "mode 'oscillate' = sinusoidal motion sin(2π·frequency·t) · amplitude: amplitude is the peak " +
    'displacement (radians for rotation, document units for position) and frequency is in Hz; both must be > 0. ' +
    'axis is the world-space direction vector ([0,1,0] = Y axis); it need not be unit-length — the viewport normalizes it. ' +
    'pivot is the world-space rotation pivot point; when omitted, the player defaults to the target entity/group position. ' +
    "trigger 'auto' runs the animation under the global Play button; 'click' toggles it when the user clicks the part in the viewport.",
  params: z.object({
    targetId: targetIdField,
    mode: z
      .enum(['spin', 'oscillate'])
      .describe(
        "'spin' = constant velocity (give speed); 'oscillate' = back-and-forth sine motion (give amplitude and frequency).",
      ),
    speed: z
      .number()
      .optional()
      .describe(
        'spin: constant velocity, rad/s for the rotation channel (e.g. 6.283 ≈ 1 rev/s) or document units/s for the position channel.',
      ),
    amplitude: z
      .number()
      .optional()
      .describe(
        'oscillate: peak displacement, radians for the rotation channel or document units for the position channel. Must be > 0.',
      ),
    frequency: z
      .number()
      .optional()
      .describe(
        'oscillate: complete cycles per second (Hz), > 0. Example: 0.5 = one full back-and-forth every 2 seconds.',
      ),
    axis: z
      .array(z.number())
      .optional()
      .describe(
        'World-space direction vector [x, y, z] the motion acts along. ' +
          'For rotation this is the axle; for position this is the translation direction. ' +
          'Need not be unit-length. Defaults to [0, 1, 0] (Y axis).',
      ),
    channel: z
      .string()
      .optional()
      .describe(
        "Transform channel to drive: 'rotation' (default) turns / rocks the part; 'position' translates / slides it.",
      ),
    pivot: pivotField,
    trigger: triggerField,
  }),
  run: (
    doc,
    { targetId, mode, speed, amplitude, frequency, axis, channel, pivot, trigger },
  ): CommandResult => {
    const targetKind = resolveTargetKind(doc, targetId);
    if (targetKind === null) return noop(doc, `animate: no entity or group ${targetId}.`);
    const input = { targetId, targetKind, axis, channel, trigger, pivot };

    if (mode === 'spin') {
      if (speed === undefined || !Number.isFinite(speed))
        return noop(doc, `animate: spin needs a finite speed; ${targetId} unchanged.`);
      const anim = buildAnimation(input, { mode, speed });
      const rotates = anim.channel === 'rotation';
      return report(
        withAnimation(doc, anim),
        `Spin ${anim.id}: ${targetKind} ${targetId} ${rotates ? 'rotates' : 'translates'} about [${anim.axis.join(',')}] at ${speed.toFixed(3)} ${rotates ? 'rad/s' : 'units/s'} (${anim.trigger}).`,
      );
    }

    if (amplitude === undefined || !(amplitude > 0))
      return noop(
        doc,
        `animate: oscillate amplitude must be > 0 (got ${amplitude}); ${targetId} unchanged.`,
      );
    if (frequency === undefined || !(frequency > 0))
      return noop(
        doc,
        `animate: oscillate frequency must be > 0 (got ${frequency}); ${targetId} unchanged.`,
      );
    const anim = buildAnimation(input, { mode, amplitude, frequency });
    const rotates = anim.channel === 'rotation';
    return report(
      withAnimation(doc, anim),
      `Oscillate ${anim.id}: ${targetKind} ${targetId} ${rotates ? 'rocks' : 'slides'} about [${anim.axis.join(',')}] ±${amplitude.toFixed(3)} ${rotates ? 'rad' : 'units'} at ${frequency.toFixed(3)} Hz (${anim.trigger}).`,
    );
  },
});

/**
 * @command stop_animation
 * @pure
 * @layer core/commands
 * @affects removes animations from the document; affected:[] always (animations are not entities)
 * @invariant if animationId given, removes that one; if targetId given, removes all matching that target; if neither, clears ALL
 * @failure animationId given but not found -> no-op with explanatory summary
 */
export const stopAnimation = defineCommand({
  name: 'stop_animation',
  annotations: { idempotent: true },
  description:
    'Remove one or more animations from the document. ' +
    'If animationId is provided, only that animation is removed (no-op if not found). ' +
    'If targetId is provided (and animationId is not), all animations whose targetId matches are removed. ' +
    'If neither is provided, ALL animations in the document are cleared. ' +
    'affected is always [] because animations are not entities.',
  params: z.object({
    animationId: z
      .string()
      .optional()
      .describe(
        'Id of a specific animation to remove (e.g. "anim-abc123-4"). ' +
          'Takes precedence over targetId when both are given.',
      ),
    targetId: z
      .string()
      .optional()
      .describe(
        'Entity or group id whose animations should all be removed. ' +
          'All animations with this targetId are deleted in one call. ' +
          'Ignored when animationId is also provided.',
      ),
  }),
  run: (doc, { animationId, targetId }): CommandResult => {
    const existing = doc.animations;

    if (animationId !== undefined) {
      if (existing[animationId] === undefined)
        return noop(doc, `stop_animation: animation ${animationId} not found; nothing removed.`);
      const next = { ...existing };
      delete next[animationId];
      return report(
        { ...doc, animations: next },
        `stop_animation: removed animation ${animationId}.`,
      );
    }

    if (targetId !== undefined) {
      const toRemove = Object.values(existing).filter((a) => a.targetId === targetId);
      if (toRemove.length === 0) {
        return noop(
          doc,
          `stop_animation: no animations found for target ${targetId}; nothing removed.`,
        );
      }
      const next = { ...existing };
      for (const a of toRemove) {
        delete next[a.id];
      }
      return report(
        { ...doc, animations: next },
        `stop_animation: removed ${toRemove.length} animation(s) for target ${targetId}.`,
      );
    }

    const count = Object.keys(existing).length;
    if (count === 0) return noop(doc, 'stop_animation: no animations to clear.');
    return report({ ...doc, animations: {} }, `stop_animation: cleared all ${count} animation(s).`);
  },
});
