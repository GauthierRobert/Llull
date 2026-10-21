// Playback of the last simulate_motion run (UI-only, never serialized): the result, the playback clock and its speed. The physics itself
// is a read-only command; this store only replays its recorded poses.

import { create } from 'zustand';
import type { SimulationData } from '@dynamics/sim/simulationReport';

/** Playback speed factors offered: real time down to 1/100 (a 4000 rpm crank is a blur at 1×). */
export const PLAYBACK_SPEEDS = [1, 0.25, 0.1, 0.02, 0.01] as const;

/** Chart x axis: simulated time, or crank angle (only usable when the run has a crank-angle series). */
export type TimelineAxis = 'time' | 'crank';

interface PlaybackSource {
  readonly dynamics: unknown;
  readonly entities: unknown;
}

interface DynamicsPlaybackState {
  /** Last run with poses; null = nothing to play (entities sit at their document pose). */
  result: SimulationData | null;
  /** The document state the result was computed from (dynamics + entities); any later edit makes the replay stale. */
  source: PlaybackSource | null;
  /** Simulated seconds shown in the viewport. */
  time: number;
  /** The one shared timeline cursor (s) read by the charts and the dock: always equal to `time`, written only here. */
  cursorTime: number;
  axis: TimelineAxis;
  playing: boolean;
  /** Simulated seconds per real second. */
  speed: number;
  /** Repeat from 0 at the end. */
  loop: boolean;
  setResult(result: SimulationData | null, source?: PlaybackSource): void;
  setTime(time: number): void;
  setPlaying(playing: boolean): void;
  setSpeed(speed: number): void;
  setLoop(loop: boolean): void;
  setAxis(axis: TimelineAxis): void;
  /** Advance the clock by `delta` real seconds (wraps or stops at the end). */
  advance(delta: number): void;
}

export const useDynamicsPlaybackStore = create<DynamicsPlaybackState>()((set, get) => ({
  result: null,
  source: null,
  time: 0,
  cursorTime: 0,
  axis: 'time',
  playing: false,
  speed: 0.1,
  loop: true,
  setResult: (result, source) =>
    set({ result, source: result === null ? null : (source ?? null), time: 0, cursorTime: 0, playing: result !== null }),
  setTime: (time) => {
    const clamped = Math.max(0, Math.min(time, get().result?.duration ?? 0));
    set({ time: clamped, cursorTime: clamped });
  },
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  setLoop: (loop) => set({ loop }),
  setAxis: (axis) => set({ axis }),
  advance: (delta) => {
    const { result, time, speed, loop, playing } = get();
    if (result === null || !playing) return;
    const next = time + delta * speed;
    if (next < result.duration) set({ time: next, cursorTime: next });
    else if (loop) {
      const wrapped = next % Math.max(result.duration, 1e-9);
      set({ time: wrapped, cursorTime: wrapped });
    } else set({ time: result.duration, cursorTime: result.duration, playing: false });
  },
}));
