// Redline drawing state (UI-only, never the document): the tool in hand, its colour and the viewpoint the markups are drawn on / shown for.

import { create } from 'zustand';

export type RedlineTool = 'line' | 'arrow' | 'cloud' | 'text';

export const REDLINE_TOOLS: readonly RedlineTool[] = ['line', 'arrow', 'cloud', 'text'];

interface RedlineState {
  /** Null: not drawing. */
  tool: RedlineTool | null;
  colour: string;
  /** Viewpoint whose markups are drawn over the viewport (and that new ones attach to). */
  viewpointId: string | null;
  setTool(tool: RedlineTool | null): void;
  setColour(colour: string): void;
  setViewpointId(viewpointId: string | null): void;
}

export const useRedlineStore = create<RedlineState>()((set) => ({
  tool: null,
  colour: '#e03030',
  viewpointId: null,
  setTool: (tool) => set({ tool }),
  setColour: (colour) => set({ colour }),
  setViewpointId: (viewpointId) => set({ viewpointId }),
}));
