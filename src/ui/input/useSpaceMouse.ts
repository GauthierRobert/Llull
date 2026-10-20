// Connects a granted SpaceMouse and turns its held deflection into camera motion: reports update the latest axes, a requestAnimationFrame
// loop (running only while the cap is off-centre) applies the motion through the camera bridge. Presentation only - no commands.

import { useCallback, useEffect, useRef } from 'react';
import { getCameraSnapshot, placeCamera } from '@ui/viewport/3d/cameraBridge';
import { useSpaceMouseStore } from '@ui/store/spaceMouseStore';
import { grantedSpaceMice, hidApi, listenToSpaceMouse, requestSpaceMice, type HidDeviceLike } from './spaceMouseDevice';
import { moveCamera } from './spaceMouseCamera';
import { cameraMotion, isIdle } from './spaceMouseMapping';
import { REST_AXES, type SpaceMouseAxes, mergeReport } from './spaceMouseReports';

const MAX_FRAME_SECONDS = 0.1;

export interface SpaceMouseApi {
  /** WebHID exists (Electron renderer). */
  supported: boolean;
  /** Needs a user gesture: opens the device picker. */
  connect(): Promise<void>;
}

export function useSpaceMouse(): SpaceMouseApi {
  const axesRef = useRef<SpaceMouseAxes>(REST_AXES);
  const frameRef = useRef<number | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const api = hidApi();

  const stopLoop = useCallback((): void => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const startLoop = useCallback((): void => {
    if (frameRef.current !== null) return;
    let last = performance.now();
    const tick = (): void => {
      // One clock for start and ticks (rAF's own timestamp can sit on another time base).
      const now = performance.now();
      const seconds = Math.min(Math.max((now - last) / 1000, 0), MAX_FRAME_SECONDS);
      last = now;
      const settings = useSpaceMouseStore.getState().settings;
      const motion = cameraMotion(axesRef.current, settings, seconds);
      // Idle is a property of the held axes, not of this frame's (possibly zero-length) time slice.
      if (isIdle(cameraMotion(axesRef.current, settings, 1))) {
        frameRef.current = null;
        return;
      }
      const pose = getCameraSnapshot();
      if (pose !== null) {
        const next = moveCamera(pose, motion);
        placeCamera(next.position, next.target);
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, []);

  const attach = useCallback(
    async (device: HidDeviceLike): Promise<void> => {
      stopRef.current?.();
      try {
        stopRef.current = await listenToSpaceMouse(device, (report) => {
          axesRef.current = mergeReport(axesRef.current, report);
          startLoop();
        });
        useSpaceMouseStore.getState().setConnection('connected', device.productName);
      } catch (error) {
        useSpaceMouseStore.getState().setConnection('error', null, error instanceof Error ? error.message : String(error));
      }
    },
    [startLoop],
  );

  const connect = useCallback(async (): Promise<void> => {
    if (api === null) return;
    try {
      const [device] = await requestSpaceMice(api);
      if (device !== undefined) await attach(device);
    } catch (error) {
      useSpaceMouseStore.getState().setConnection('error', null, error instanceof Error ? error.message : String(error));
    }
  }, [api, attach]);

  // Reconnect a device granted in an earlier session; tear everything down on unmount.
  useEffect(() => {
    if (api === null) return undefined;
    let cancelled = false;
    void grantedSpaceMice(api)
      .then((devices) => {
        const [device] = devices;
        if (!cancelled && device !== undefined) return attach(device);
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stopLoop();
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [api, attach, stopLoop]);

  return { supported: api !== null, connect };
}
