// Point-cloud presentation state (UI only, never in the document, never a command): colour mode, point budget, crop / snap toggles, and the
// per-cloud streaming report the Scan panel reads. Cloud references, crops and registrations stay in `CadDocument.scan`.

import { create } from 'zustand';
import type { ColourMode } from '@ui/viewport/3d/scan/colourModes';
import { EDL_DEFAULT_STRENGTH } from '@ui/viewport/3d/scan/edlShading';

/** Points the viewport may hold in memory at once (spec §8: 30 fps at 3 M on the desktop). */
export const POINT_BUDGETS: readonly number[] = [500_000, 1_000_000, 2_000_000, 3_000_000];
const DEFAULT_BUDGET = 1_000_000;

/** `document`: each cloud's own `display.colorBy`. */
export type ColourChoice = ColourMode | 'document';

type StreamStatus = 'idle' | 'offline' | 'loading' | 'ready' | 'error';

export interface CloudStream {
  readonly status: StreamStatus;
  readonly message: string;
  /** Points in the whole cloud (null until described). */
  readonly pointCount: number | null;
  /** Points currently drawn. */
  readonly drawn: number;
  readonly tilesResident: number;
  readonly tilesVisible: number;
  /** Modes the loaded data can show (elevation and flat always). */
  readonly modes: readonly ColourMode[];
}

interface ScanViewState {
  colourChoice: ColourChoice;
  pointBudget: number;
  applyCrops: boolean;
  snapToScan: boolean;
  /** Eye-dome lighting on the cloud layer (screen-space depth shading). */
  edl: boolean;
  edlStrength: number;
  streams: Readonly<Record<string, CloudStream>>;
  setColourChoice(choice: ColourChoice): void;
  setPointBudget(budget: number): void;
  toggleApplyCrops(): void;
  toggleSnapToScan(): void;
  toggleEdl(): void;
  reportStream(cloudId: string, stream: CloudStream): void;
  dropStream(cloudId: string): void;
}

export const useScanViewStore = create<ScanViewState>()((set) => ({
  colourChoice: 'document',
  pointBudget: DEFAULT_BUDGET,
  applyCrops: true,
  snapToScan: true,
  edl: true,
  edlStrength: EDL_DEFAULT_STRENGTH,
  streams: {},
  setColourChoice: (colourChoice) => set({ colourChoice }),
  setPointBudget: (pointBudget) => set({ pointBudget }),
  toggleApplyCrops: () => set((state) => ({ applyCrops: !state.applyCrops })),
  toggleSnapToScan: () => set((state) => ({ snapToScan: !state.snapToScan })),
  toggleEdl: () => set((state) => ({ edl: !state.edl })),
  reportStream: (cloudId, stream) => set((state) => ({ streams: { ...state.streams, [cloudId]: stream } })),
  dropStream: (cloudId) =>
    set((state) => ({ streams: Object.fromEntries(Object.entries(state.streams).filter(([id]) => id !== cloudId)) })),
}));
