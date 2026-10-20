import { isRecord } from '../../lib/isRecord';
import { isVec3 } from '../../lib/vec3';

/** Value checks for contact sets and exploded views (SC-F4): renderers and motion scans read them without further guards. */
export function mechanismProblems(v: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const contactSets = v['contactSets'];
  if (contactSets !== undefined && !isRecord(contactSets)) errors.push('contactSets must be an object');
  if (isRecord(contactSets))
    for (const [id, set] of Object.entries(contactSets)) {
      if (!isRecord(set) || set['id'] !== id || typeof set['name'] !== 'string') {
        errors.push(`contactSet '${id}': needs id (matching its key) and name`);
        continue;
      }
      const pairs = set['pairs'];
      const wellFormed =
        Array.isArray(pairs) &&
        pairs.every(
          (pair) => Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === 'string' && part.length > 0),
        );
      if (!wellFormed) errors.push(`contactSet '${id}': pairs must be an array of [id, id] string pairs`);
    }
  const views = v['explodedViews'];
  if (views !== undefined && !isRecord(views)) errors.push('explodedViews must be an object');
  if (isRecord(views))
    for (const [id, view] of Object.entries(views)) {
      if (!isRecord(view) || view['id'] !== id || typeof view['name'] !== 'string' || !Array.isArray(view['offsets'])) {
        errors.push(`explodedView '${id}': needs id (matching its key), name and an offsets array`);
        continue;
      }
      const offsets: unknown[] = view['offsets'];
      const bad = offsets.findIndex(
        (offset) =>
          !isRecord(offset) ||
          typeof offset['target'] !== 'string' ||
          !isVec3(offset['vector']) ||
          !Number.isInteger(offset['step']) ||
          (offset['step'] as number) < 1,
      );
      if (bad >= 0) errors.push(`explodedView '${id}': offsets[${bad}] needs a target id, a finite [x,y,z] vector and a step ≥ 1`);
    }
  const active = v['activeExplodedView'];
  if (active !== undefined) {
    if (!isRecord(active) || typeof active['id'] !== 'string') errors.push('activeExplodedView must be { id, step? }');
    else if (!isRecord(views) || !Object.hasOwn(views, active['id']))
      errors.push(`activeExplodedView: '${active['id']}' does not reference a known exploded view`);
    else if (active['step'] !== undefined && (!Number.isInteger(active['step']) || (active['step'] as number) < 0))
      errors.push('activeExplodedView: step must be a non-negative integer');
  }
  return errors;
}
