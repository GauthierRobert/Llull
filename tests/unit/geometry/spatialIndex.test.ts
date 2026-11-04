import { afterEach, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { type InstanceBvh, buildInstanceBvh, packBoxes } from '@core/geometry/instanceBvh';
import { planSceneOf } from '@core/geometry/planSceneCache';
import { frustumPlanes } from '@core/geometry/renderPlanCamera';
import { type SpatialIndexPort, getSpatialIndex, resolveSpatialIndex, setSpatialIndex, tsSpatialIndex } from '@core/geometry/spatialIndex';
import { findClashes } from '@aec/industrial/clash/clash';
import { clashStressDocument } from '../../helpers/clashStress';
import { SYN_RACK_BAYS, synRackDocument } from '../../helpers/synRack';

/** A port that answers with the TypeScript tree and counts its builds and its box queries / frustum queries. */
function countingPort(): SpatialIndexPort & { builds: number; boxQueries: number; frustumQueries: number } {
  const port = {
    builds: 0,
    boxQueries: 0,
    frustumQueries: 0,
    build(boxes: Float64Array): InstanceBvh {
      port.builds++;
      const inner = buildInstanceBvh(boxes);
      return {
        count: inner.count,
        frustumQuery: (planes) => {
          port.frustumQueries++;
          return inner.frustumQuery(planes);
        },
        rayQuery: (origin, direction) => inner.rayQuery(origin, direction),
        boxQuery: (min, max) => {
          port.boxQueries++;
          return inner.boxQuery(min, max);
        },
      };
    },
  };
  return port;
}

afterEach(() => setSpatialIndex(null));

describe('ctx.spatialIndex (VIS-M8e)', () => {
  it('is the TypeScript build by default, and a port installed by the host reaches the default context', () => {
    expect(getSpatialIndex()).toBeNull();
    expect(resolveSpatialIndex(undefined)).toBe(tsSpatialIndex);
    expect(resolveSpatialIndex(null)).toBe(tsSpatialIndex);
    expect(defaultContext().spatialIndex).toBeNull();
    const port = countingPort();
    setSpatialIndex(port);
    expect(defaultContext().spatialIndex).toBe(port);
    expect(resolveSpatialIndex(port)).toBe(port);
    expect(tsSpatialIndex.build(packBoxes([{ min: [0, 0, 0], max: [1, 1, 1] }])).count).toBe(1);
  });

  it('check_clashes builds its broad phase through the port and answers as without it', () => {
    const doc = clashStressDocument(300, 5, 16_000);
    const port = countingPort();
    const plain = execute(doc, 'check_clashes', {}, defaultContext());
    const injected = execute(doc, 'check_clashes', {}, { ...defaultContext(), spatialIndex: port });
    expect(port.builds).toBe(1);
    expect(port.boxQueries).toBeGreaterThan(300);
    expect(injected.summary).toBe(plain.summary);
    expect(injected.data).toEqual(plain.data);
    expect(findClashes(doc, null, 0, 0, port)).toEqual(findClashes(doc, null, 0, Infinity));
  });

  it('check_clashes below the broad-phase threshold never builds an index', () => {
    const port = countingPort();
    execute(clashStressDocument(20, 5, 6_000), 'check_clashes', {}, { ...defaultContext(), spatialIndex: port });
    expect(port.builds).toBe(0);
  });

  it('planSceneOf builds the tree through the port on the second call only and queries it', () => {
    const doc = synRackDocument(SYN_RACK_BAYS[0]);
    const port = countingPort();
    const fresh = { ...doc };
    expect(planSceneOf(fresh, 0, port).query).toBeUndefined();
    expect(port.builds).toBe(0);
    const { query } = planSceneOf(fresh, 0, port);
    expect(port.builds).toBe(1);
    const planes = frustumPlanes({
      projection: 'perspective',
      eye: [0, -9000, 6000],
      direction: [0, 0.8, -0.6],
      up: [0, 0.6, 0.8],
      fovDeg: 50,
      viewHeight: 0,
      widthPx: 800,
      heightPx: 600,
    });
    const reference = { ...doc };
    planSceneOf(reference, 0);
    expect(query?.(planes)).toEqual(planSceneOf(reference, 0).query?.(planes));
    expect(port.frustumQueries).toBe(1);
  });
});
