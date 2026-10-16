// Playback of the last simulate_motion run (UI-only, never serialized): the result, the playback clock and its speed. The physics itself
// is a read-only command; this store only replays its recorded poses.

import { create } from 'zustand';
import type { SimulationData } from '@core/dynamics/simulationReport';

/** Playback speed factors offered: real time down to 1/100 (a 4000 rpm crank is a blur at 1×). */
export const PLAYBACK_SPEEDS = [1, 0.25, 0.1, 0.02, 0.01] as const;

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
  /** Advance the clock by `delta` real seconds (wraps or stops at the end). */
  advance(delta: number): void;
}

export const useDynamicsPlaybackStore = create<DynamicsPlaybackState>()((set, get) => ({
  result: null,
  source: null,
  time: 0,
  playing: false,
  speed: 0.1,
  loop: true,
  setResult: (result, source) => set({ result, source: result === null ? null : (source ?? null), time: 0, playing: result !== null }),
  setTime: (time) => set({ time: Math.max(0, Math.min(time, get().result?.duration ?? 0)) }),
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  setLoop: (loop) => set({ loop }),
  advance: (delta) => {
    const { result, time, speed, loop, playing } = get();
    if (result === null || !playing) return;
    const next = time + delta * speed;
    if (next < result.duration) set({ time: next });
    else if (loop) set({ time: next % Math.max(result.duration, 1e-9) });
    else set({ time: result.duration, playing: false });
  },
}));
