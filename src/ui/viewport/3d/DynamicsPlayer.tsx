// Replays the last simulate_motion run in the 3D view (in-Canvas, renders null, ref-only work like AnimationPlayer): every frame each
// simulated body's member entities are moved rigidly to the body's pose at the playback time. When the result is cleared, the moved
// objects are put back at their document pose.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '@ui/store';
import type { CadDocument } from '@core/model/types';
import { getPlaybackTime, useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';
import { bodyFrameAt, carryEntity, createBodyFrame } from './dynamicsPose';
import { markSceneMoved } from './frameActivity';
import { SceneObjectCache } from './sceneObjectCache';

type DynamicsBody = NonNullable<CadDocument['dynamics']>['bodies'][string];

export function DynamicsPlayer(): null {
  const objectCache = useMemo(() => new SceneObjectCache(), []);
  const frame = useMemo(createBodyFrame, []);
  const scratch = useMemo(() => ({ position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), euler: new THREE.Euler() }), []);
  // Entities moved by the previous frame: restored to their document pose once playback ends.
  // Two pooled sets swapped each frame: no per-frame allocation.
  const sets = useRef({ moved: new Set<string>(), carried: new Set<string>() });
  const bodyList = useRef<{ source: unknown; bodies: DynamicsBody[] }>({ source: null, bodies: [] });
  // Demand frameloop: a new result, play, seek or clear must wake the canvas (useFrame keeps it awake while playing).
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => useDynamicsPlaybackStore.subscribe(() => invalidate()), [invalidate]);

  useFrame(({ scene, invalidate }, delta) => {
    const playback = useDynamicsPlaybackStore.getState();
    const { entities, dynamics } = useStore.getState().document;
    // an edit after the run (body deleted, part moved, gear changed) makes the replay stale: drop it, back to the design pose
    const source = playback.source;
    if (playback.result !== null && source !== null && (source.dynamics !== dynamics || source.entities !== entities))
      playback.setResult(null);
    const poses = useDynamicsPlaybackStore.getState().result?.poses;
    const pool = sets.current;
    const { moved, carried } = pool;
    carried.clear();
    if (poses !== undefined && dynamics !== undefined) {
      if (playback.playing) {
        playback.advance(delta);
        invalidate();
      }
      const time = getPlaybackTime();
      if (bodyList.current.source !== dynamics.bodies)
        bodyList.current = { source: dynamics.bodies, bodies: Object.values(dynamics.bodies) };
      for (const body of bodyList.current.bodies) {
        if (!bodyFrameAt(poses, body.id, time, frame)) continue;
        for (const id of body.entityIds) {
          const entity = entities[id];
          const object = objectCache.get(scene, id);
          if (entity === undefined || object === undefined) continue;
          carryEntity(frame, entity.position, entity.rotation, scratch.position, scratch.quaternion);
          object.position.copy(scratch.position);
          object.quaternion.copy(scratch.quaternion);
          carried.add(id);
          markSceneMoved();
        }
      }
    }
    // anything moved before but not carried now goes back to its document pose
    for (const id of moved) {
      const entity = entities[id];
      const object = objectCache.get(scene, id);
      if (carried.has(id) || entity === undefined || object === undefined) continue;
      object.position.set(entity.position[0], entity.position[1], entity.position[2]);
      object.quaternion.setFromEuler(scratch.euler.set(entity.rotation[0], entity.rotation[1], entity.rotation[2], 'XYZ'));
      markSceneMoved();
      invalidate();
    }
    pool.moved = carried;
    pool.carried = moved;
  });

  return null;
}
