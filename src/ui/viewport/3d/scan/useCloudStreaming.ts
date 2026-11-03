// Streams one cloud: the cloud's box is cut into tiles, each tile is a budgeted `query_cloud_points`; the LOD rule (lodSelect) picks a level
// per visible tile, coarse first, within the point budget. The plan re-runs 200 ms after the camera settles (09 VIS: refine after idle).
// Returns the drawn tiles as buffers; the resident ones also feed the scan-point snap. Reads cloud references only, never writes the document.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from '@core/model/vectors';
import { useStore } from '@ui/store';
import { useScanViewStore } from '@ui/store/scanViewStore';
import { availableModes, type ColourMode, type TileAttributes } from './colourModes';
import { fetchCloudInfo, fetchTile, type CloudInfo } from './cloudClient';
import type { CropLike } from './cropFilter';
import { LEVEL_BUDGETS, selectLevels, type LodCamera, type ResidentTile } from './lodSelect';
import { clearSnapTiles, setSnapTiles } from './snapRegistry';
import { buildTileBuffers, type TileBuffers } from './tileBuffers';
import { buildTileGrid, type CloudTile } from './tileGrid';

/** Tiles per cloud: ~32 boxes keep a query cheap and the visible set small. */
const MAX_TILES = 32;
const IDLE_MS = 200;
const CONCURRENT_FETCHES = 3;
const FOV_FALLBACK = 1;

interface Resident {
  readonly level: number;
  readonly positions: Float64Array;
  readonly attributes: TileAttributes | undefined;
  readonly complete: boolean;
}

interface CachedBuffers {
  readonly resident: Resident;
  readonly mode: ColourMode;
  readonly crops: readonly CropLike[];
  readonly buffers: TileBuffers;
}

export interface CloudStreamInput {
  readonly id: string;
  readonly mode: ColourMode;
  /** Crops applied to the drawn points (already filtered to this cloud; empty when the toggle is off). */
  readonly crops: readonly CropLike[];
}

export interface DrawnTile {
  readonly key: string;
  readonly buffers: TileBuffers;
  readonly centre: Vec3;
  readonly radius: number;
}

function attributeUnion(residents: Iterable<Resident>): TileAttributes | undefined {
  let merged: TileAttributes | undefined;
  for (const { attributes } of residents) if (attributes !== undefined) merged = { ...merged, ...attributes };
  return merged;
}

/** Fetch order: tiles with nothing resident first (coarse before fine), then refinements; ties by key. */
function fetchOrder(a: readonly [string, number], b: readonly [string, number], resident: ReadonlyMap<string, Resident>): number {
  const aHas = resident.has(a[0]);
  const bHas = resident.has(b[0]);
  if (aHas !== bHas) return aHas ? 1 : -1;
  return a[1] - b[1] || a[0].localeCompare(b[0]);
}

export function useCloudStreaming({ id, mode, crops }: CloudStreamInput): readonly DrawnTile[] {
  const get = useThree((state) => state.get);
  const invalidate = useThree((state) => state.invalidate);
  const online = useStore((state) => state.liveStatus === 'connected');
  const budget = useScanViewStore((state) => state.pointBudget);
  const reportStream = useScanViewStore((state) => state.reportStream);

  const [info, setInfo] = useState<CloudInfo | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [levels, setLevels] = useState<ReadonlyMap<string, number>>(new Map());
  const [version, setVersion] = useState(0);
  const residents = useRef(new Map<string, Resident>());
  const inflight = useRef(new Set<string>());
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const signature = useRef<readonly number[]>([]);
  const cache = useRef(new Map<string, CachedBuffers>());

  const tiles = useMemo<readonly CloudTile[]>(() => (info === null ? [] : buildTileGrid(info.bounds, MAX_TILES)), [info]);

  // The caller keys this hook's component by cloud, placement and backend state, so a change remounts it with empty state.
  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    if (!online) return;
    void fetchCloudInfo(id).then((result) => {
      if (generation.current !== mine) return;
      if (result.ok) setInfo(result.value);
      else setFailure(result.message);
    });
    return () => {
      generation.current += 1;
    };
  }, [id, online]);

  const plan = useCallback((): void => {
    if (tiles.length === 0) return;
    const { camera, size } = get();
    const origin = useStore.getState().renderOrigin;
    camera.updateMatrixWorld();
    const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(viewProjection);
    const sphere = new THREE.Sphere();
    const lod: LodCamera = {
      position: [camera.position.x + origin[0], camera.position.y + origin[1], camera.position.z + origin[2]],
      fov: camera instanceof THREE.PerspectiveCamera ? (camera.fov * Math.PI) / 180 : FOV_FALLBACK,
      viewportHeight: size.height,
      sees: (centre, radius) =>
        frustum.intersectsSphere(
          sphere.set(new THREE.Vector3(centre[0] - origin[0], centre[1] - origin[1], centre[2] - origin[2]), radius),
        ),
    };
    const known = new Map<string, ResidentTile>();
    for (const [key, resident] of residents.current) known.set(key, { level: resident.level, complete: resident.complete });
    const next = selectLevels(tiles, lod, budget, known);
    setLevels(next);
    const mine = generation.current;
    const wanted = [...next]
      .filter(([key, level]) => residents.current.get(key)?.level !== level && !inflight.current.has(`${key}@${level}`))
      .sort((a, b) => fetchOrder(a, b, residents.current));
    let cursor = 0;
    const pump = async (): Promise<void> => {
      for (;;) {
        const entry = wanted[cursor++];
        if (entry === undefined || generation.current !== mine) return;
        const [key, level] = entry;
        const tile = tiles.find((candidate) => candidate.key === key);
        if (tile === undefined) continue;
        const slot = `${key}@${level}`;
        inflight.current.add(slot);
        const result = await fetchTile(id, tile, LEVEL_BUDGETS[level] ?? LEVEL_BUDGETS[0] ?? 0);
        inflight.current.delete(slot);
        if (generation.current !== mine) return;
        if (!result.ok) {
          setFailure(result.message);
          return;
        }
        const previous = residents.current.get(key);
        residents.current.set(key, {
          level,
          positions: result.value.positions,
          attributes: result.value.attributes,
          complete: previous !== undefined && level > previous.level && result.value.positions.length <= previous.positions.length,
        });
        setVersion((v) => v + 1);
        invalidate();
      }
    };
    for (let i = 0; i < CONCURRENT_FETCHES; i++) void pump();
  }, [tiles, budget, get, id, invalidate]);

  // After the first paint, and whenever the tiles or the budget change.
  useEffect(() => {
    const handle = setTimeout(plan, 0);
    return () => clearTimeout(handle);
  }, [plan]);

  useFrame(({ camera, size }) => {
    const q = camera.quaternion;
    const next = [camera.position.x, camera.position.y, camera.position.z, q.x, q.y, q.z, q.w, size.width, size.height];
    const last = signature.current;
    if (last.length === next.length && next.every((value, index) => value === last[index])) return;
    signature.current = next;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(plan, IDLE_MS);
  });
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const range = useMemo(() => ({ zLow: info?.bounds.min[2] ?? 0, zHigh: info?.bounds.max[2] ?? 1 }), [info]);

  // `version` is the change signal of the resident map (a ref).
  const drawn = useMemo<readonly DrawnTile[]>(() => {
    void version;
    const out: DrawnTile[] = [];
    const live = new Set<string>();
    for (const tile of tiles) {
      const resident = residents.current.get(tile.key);
      if (resident === undefined || !levels.has(tile.key)) continue;
      live.add(tile.key);
      const hit = cache.current.get(tile.key);
      const buffers =
        hit !== undefined && hit.resident === resident && hit.mode === mode && hit.crops === crops
          ? hit.buffers
          : buildTileBuffers(
              { positions: resident.positions, attributes: resident.attributes, complete: resident.complete },
              tile.min,
              mode,
              range,
              crops,
            );
      cache.current.set(tile.key, { resident, mode, crops, buffers });
      out.push({ key: tile.key, buffers, centre: tile.centre, radius: tile.radius });
    }
    for (const key of [...cache.current.keys()]) if (!live.has(key)) cache.current.delete(key);
    return out;
  }, [tiles, levels, version, mode, crops, range]);

  useEffect(() => {
    setSnapTiles(
      id,
      drawn.map((tile) => ({ origin: tile.buffers.origin, positions: tile.buffers.positions, centre: tile.centre, radius: tile.radius })),
    );
    return () => clearSnapTiles(id);
  }, [id, drawn]);

  useEffect(() => {
    const drawnPoints = drawn.reduce((sum, tile) => sum + tile.buffers.count, 0);
    const modes = availableModes(attributeUnion(residents.current.values()));
    const base = {
      pointCount: info?.pointCount ?? null,
      drawn: drawnPoints,
      tilesResident: residents.current.size,
      tilesVisible: levels.size,
      modes,
    };
    if (!online)
      reportStream(id, { ...base, status: 'offline', message: 'Point data is served by the llull backend (desktop app).', drawn: 0 });
    else if (failure !== null) reportStream(id, { ...base, status: 'error', message: failure });
    else reportStream(id, { ...base, status: info === null || drawn.length === 0 ? 'loading' : 'ready', message: '' });
  }, [id, online, failure, info, drawn, levels, reportStream]);
  useEffect(() => () => useScanViewStore.getState().dropStream(id), [id]);

  return drawn;
}
