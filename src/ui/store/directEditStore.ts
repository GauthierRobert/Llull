// Direct freeform editing state (04 DIR): which subdivision entity is in cage edit mode, the picked cage elements, falloff settings and
// the gesture in flight. UI-only: the document changes only when a gesture commits through `dispatch`.

import { create } from 'zustand';
import type { SubdivisionEntity } from '@core/model/types';
import type { Triangle } from '@core/geometry/triangles';
import { type CageElement, type CageElementKind, type CageSelection, EMPTY_CAGE_SELECTION } from '@ui/viewport/3d/cage/cageSelection';
import type { CageTool } from '@ui/viewport/3d/cage/cageKeys';
import { type CageCommand, type CageGesture, DEFAULT_FALLOFF, type FalloffSettings } from '@ui/viewport/3d/cage/gestureCommands';

/** Result of the local dry run of the gesture's command. */
export interface CagePreviewState {
  readonly ok: boolean;
  readonly summary: string;
  /** The edited entity as the commit would store it (null when refused). */
  readonly entity: SubdivisionEntity | null;
  /** Ghost triangles in entity-local coordinates. */
  readonly triangles: readonly Triangle[];
}

interface DirectEditState {
  /** The subdivision entity in cage edit mode; null = mode off. */
  entityId: string | null;
  elementMode: CageElementKind;
  tool: CageTool;
  selection: CageSelection;
  hover: CageElement | null;
  falloff: FalloffSettings;
  /** Loop cuts a Ctrl-R click inserts (1..8). */
  cuts: number;
  gesture: CageGesture | null;
  preview: CagePreviewState | null;
  /** The last committed gesture's command, for "Copy as CLI". */
  lastCommit: CageCommand | null;
  enter(entityId: string): void;
  exit(): void;
  setElementMode(mode: CageElementKind): void;
  setTool(tool: CageTool): void;
  setSelection(selection: CageSelection): void;
  setHover(hover: CageElement | null): void;
  setFalloff(patch: Partial<FalloffSettings>): void;
  setCuts(cuts: number): void;
  setGesture(gesture: CageGesture | null): void;
  setPreview(preview: CagePreviewState | null): void;
  setLastCommit(command: CageCommand): void;
}

const IDLE = { gesture: null, preview: null, hover: null } as const;

export const useDirectEditStore = create<DirectEditState>()((set) => ({
  entityId: null,
  elementMode: 'vertex',
  tool: 'select',
  selection: EMPTY_CAGE_SELECTION,
  hover: null,
  falloff: DEFAULT_FALLOFF,
  cuts: 1,
  gesture: null,
  preview: null,
  lastCommit: null,
  enter: (entityId) =>
    set((state) =>
      state.entityId === entityId ? state : { entityId, tool: 'select', selection: EMPTY_CAGE_SELECTION, lastCommit: null, ...IDLE },
    ),
  exit: () => set({ entityId: null, tool: 'select', selection: EMPTY_CAGE_SELECTION, ...IDLE }),
  setElementMode: (elementMode) => set({ elementMode, selection: EMPTY_CAGE_SELECTION, hover: null }),
  setTool: (tool) => set({ tool, ...IDLE }),
  setSelection: (selection) => set({ selection }),
  setHover: (hover) => set((state) => (state.hover?.kind === hover?.kind && state.hover?.id === hover?.id ? state : { hover })),
  setFalloff: (patch) => set((state) => ({ falloff: { ...state.falloff, ...patch } })),
  setCuts: (cuts) => set({ cuts: Math.min(8, Math.max(1, Math.round(cuts))) }),
  setGesture: (gesture) => set(gesture === null ? { gesture, preview: null } : { gesture }),
  setPreview: (preview) => set({ preview }),
  setLastCommit: (lastCommit) => set({ lastCommit }),
}));
