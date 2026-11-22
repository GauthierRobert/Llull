import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '@ui/store';
import { capturePose } from '@ui/viewport/3d/capture/capturePose';
import type { ViewportCaptureRequest } from '@core/model/viewportCapture';
import { resetStore } from '../helpers/componentEntities';
import { localDispatch } from '../helpers/storeTestHelpers';

const request = (over: Partial<ViewportCaptureRequest> = {}): ViewportCaptureRequest => ({
  view: 'iso',
  zoom: 1,
  width: 1600,
  height: 1000,
  hideLayers: [],
  ...over,
});

describe('capturePose (temporary camera of capture_viewport)', () => {
  beforeEach(() => {
    resetStore();
  });

  it('frames the shown entities from the named direction without touching the document camera', () => {
    localDispatch('add_box', { size: [10, 10, 10], position: [100, 0, 0] });
    const doc = useStore.getState().document;
    const cameraBefore = doc.camera;
    const top = capturePose(request({ view: 'top' }), doc);
    expect(top.target[0]).toBeCloseTo(100);
    expect(top.position[0]).toBeCloseTo(100);
    expect(top.position[2]).toBeGreaterThan(top.target[2]);
    expect(top.up).toEqual([0, 1, 0]);
    const front = capturePose(request({ view: 'front' }), doc);
    expect(front.position[1]).toBeLessThan(front.target[1]);
    expect(useStore.getState().document.camera).toBe(cameraBefore);
  });

  it('zoom shortens the eye distance, target and direction override the framing', () => {
    localDispatch('add_box', { size: [10, 10, 10] });
    const doc = useStore.getState().document;
    const fit = capturePose(request(), doc);
    expect(capturePose(request({ zoom: 2 }), doc).distance).toBeCloseTo(fit.distance / 2);
    const custom = capturePose(request({ target: [5, 5, 5], direction: [0, 0, 3] }), doc);
    expect(custom.target).toEqual([5, 5, 5]);
    expect(custom.position[2]).toBeGreaterThan(5);
  });

  it('leaves hidden layers out of the framing and frames an empty scene around the origin', () => {
    localDispatch('add_box', { size: [10, 10, 10], position: [0, 0, 0] });
    const doc = useStore.getState().document;
    const layerId = doc.entities[doc.order[0]!]!.layerId;
    const empty = capturePose(request({ hideLayers: [layerId] }), doc);
    expect(empty.target).toEqual([0, 0, 0]);
    expect(empty.distance).toBeGreaterThan(0);
  });

  it("ignores what the user's own viewport filter hides", () => {
    const a = localDispatch('add_box', { size: [10, 10, 10], position: [0, 0, 0] }).affected[0]!;
    localDispatch('add_box', { size: [10, 10, 10], position: [1000, 0, 0] });
    const doc = useStore.getState().document;
    const all = capturePose(request(), doc);
    const onlyFirst = capturePose(request(), doc, new Set(), new Set([doc.order.find((id) => id !== a)!]));
    expect(onlyFirst.distance).toBeLessThan(all.distance);
    expect(onlyFirst.target[0]).toBeCloseTo(0);
  });
});
