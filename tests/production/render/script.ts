import type { ToolCall } from '../contract';
import { frameDeliverable, renderParams, viewDeliverable, type RenderIntent } from './intent';

/**
 * The calls a visualisation engineer makes on the issued pipe-rack model: the appearance library as materials, site sun and sky, six
 * views and the turntable frames. Giving the plant elements their appearance is part of the job, but llull refuses both routes on
 * building-plugin geometry today (apply_appearance / assign_material on derived entities: derivation guard), so the script cannot make
 * that call; the `appearance-coverage` criterion records the gap.
 */
export function renderScript(intent: RenderIntent): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const entry of intent.library) {
    calls.push({ tool: 'create_material', args: { name: entry.material, density: 7850, densityUnit: 'kg/m^3' } });
    calls.push({
      tool: 'apply_appearance',
      args: { appearance: entry.appearance, material: entry.material, ...(entry.color !== undefined ? { color: entry.color } : {}) },
    });
  }
  calls.push({ tool: 'set_site_context', args: { ...intent.site } });
  calls.push({ tool: 'set_environment', args: { source: 'sky', turbidity: 3, intensity: 1 } });
  for (const view of intent.views) calls.push({ tool: 'render_realistic', args: renderParams(intent, viewDeliverable(view)) });
  for (let frame = 0; frame < intent.turntable.frames; frame++)
    calls.push({ tool: 'render_realistic', args: renderParams(intent, frameDeliverable(frame)) });
  return calls;
}
