import { len3 } from '../../lib/vec3';
import type { CommandResult } from '../types';
import type { EmbossFail, EmbossRequest } from './embossRequest';

function checkDepthAndTool(params: EmbossRequest, fail: EmbossFail): CommandResult | null {
  const engrave = params.mode === 'engrave';
  const scribe = params.mode === 'scribe';
  if (!scribe && !(typeof params.depth === 'number' && Number.isFinite(params.depth) && params.depth > 0))
    return fail('WRP_DEPTH_INVALID', `depth must be a finite number > 0 for ${params.mode} (got ${String(params.depth)})`, ['depth']);
  if (engrave && !(typeof params.toolWidth === 'number' && Number.isFinite(params.toolWidth) && params.toolWidth > 0))
    return fail('WRP_PARAM_INVALID', `mode engrave needs toolWidth > 0 (got ${String(params.toolWidth)})`, ['toolWidth']);
  return null;
}

function checkWalls(params: EmbossRequest, fail: EmbossFail): CommandResult | null {
  const engrave = params.mode === 'engrave';
  const scribe = params.mode === 'scribe';
  const pulled = params.walls === 'pull';
  if (!pulled && (params.pullDirection !== undefined || params.draftDeg !== undefined))
    return fail('WRP_PARAM_INVALID', 'pullDirection and draftDeg need walls "pull"', [
      ...(params.pullDirection !== undefined ? ['pullDirection'] : []),
      ...(params.draftDeg !== undefined ? ['draftDeg'] : []),
    ]);
  if (pulled) {
    if (params.pullDirection === undefined || !(len3(params.pullDirection) > 1e-12))
      return fail('WRP_PARAM_INVALID', 'walls "pull" needs a non-zero pullDirection [x, y, z]', ['pullDirection']);
    if (engrave || scribe || params.grid !== undefined || (params.chain?.length ?? 0) > 0)
      return fail('WRP_PARAM_INVALID', 'walls "pull" works with emboss and deboss on one face (not scribe, engrave, a grid or a chain)', [
        'walls',
      ]);
    if (params.draftDeg !== undefined && !(params.draftDeg >= 0 && params.draftDeg < 45))
      return fail('WRP_PARAM_INVALID', `draftDeg must be in [0, 45) degrees (got ${params.draftDeg})`, ['draftDeg']);
  }
  return null;
}

export function checkEmbossRequest(params: EmbossRequest, fail: EmbossFail): CommandResult | null {
  return checkDepthAndTool(params, fail) ?? checkWalls(params, fail);
}

export function checkFreeformMode(freeform: boolean, params: EmbossRequest, fail: EmbossFail): CommandResult | null {
  if (!freeform) return null;
  if (params.mode === 'scribe')
    return fail(
      'WRP_METHOD_UNAVAILABLE',
      'mode scribe is built for plane, cylinder, cone, sphere and torus faces, not for a freeform face',
      ['mode'],
    );
  if (params.walls === 'pull')
    return fail(
      'WRP_PARAM_INVALID',
      'walls "pull" and draftDeg are built for plane, cylinder, cone and sphere faces: the walls of a freeform relief always run along the outward normal at the anchor',
      ['walls'],
    );
  return null;
}
