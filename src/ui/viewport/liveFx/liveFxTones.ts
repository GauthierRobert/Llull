// Accent colour per change origin: an MCP agent glows warm (the --agent token), the CLI cyan, the REST API amber, this client's own edits blue.

import * as THREE from 'three';
import type { LiveFxTone } from './planLiveFx';

const TONE_HEX: Record<LiveFxTone, string> = { mcp: '#f0904a', cli: '#22d3ee', rest: '#f59e0b', snapshot: '#38bdf8', local: '#3b82f6' };

const TONE_COLOR = new Map<LiveFxTone, THREE.Color>();

export function toneHex(tone: LiveFxTone): string {
  return TONE_HEX[tone];
}

/** Shared, never mutated by callers. */
export function toneColor(tone: LiveFxTone): THREE.Color {
  let color = TONE_COLOR.get(tone);
  if (color === undefined) {
    color = new THREE.Color(TONE_HEX[tone]);
    TONE_COLOR.set(tone, color);
  }
  return color;
}

/** Local edits glow softer: the user already sees what they did. */
export function toneStrength(tone: LiveFxTone): number {
  return tone === 'local' ? 0.45 : 1;
}
