// The Aerodynamics panel's read-only queries (frontal_area, standard_atmosphere, aero_drag, analyze_airfoil) on the live document,
// recomputed when the geometry, the selection of solids or an input changes. Nothing here writes to the document.

import { useMemo } from 'react';
import { execute } from '@core/commands/registry';
import { boundsExtent, entityBoundsInDoc, mergeBounds, type Bounds } from '@core/geometry/bounds';
import { is3D, type CadDocument, type Vec3 } from '@core/model/types';
import { useStore } from '@ui/store';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import {
  flowVector,
  parseAirfoil,
  parseAtmosphere,
  parseDrag,
  parseFrontal,
  type AirfoilView,
  type AtmosphereView,
  type DragView,
  type FlowPresetId,
  type FrontalView,
} from './aeroData';

export interface AeroInputs {
  readonly allSolids: boolean;
  readonly preset: FlowPresetId;
  readonly custom: readonly [string, string, string];
  readonly speed: string;
  readonly speedUnit: string;
  readonly altitude: string;
  readonly dragMode: 'cd' | 'cda';
  readonly cd: string;
  readonly cdA: string;
}

export interface BodyAnalysis {
  readonly bodyIds: readonly string[];
  readonly flow: Vec3 | null;
  readonly bounds: Bounds | null;
  readonly frontal: FrontalView | null;
  readonly atmosphere: AtmosphereView | null;
  readonly drag: DragView | null;
  /** First failure summary, shown instead of numbers. */
  readonly problem: string;
}

const solidIds = (document: CadDocument): string[] =>
  document.order.filter((id) => document.entities[id] !== undefined && isSolidBody(document, id));

function isSolidBody(document: CadDocument, id: string): boolean {
  const entity = document.entities[id];
  return entity !== undefined && is3D(entity) && entity.kind !== 'image';
}

function boundsOf(document: CadDocument, ids: readonly string[]): Bounds | null {
  let merged: Bounds | null = null;
  for (const id of ids) {
    const entity = document.entities[id];
    if (entity === undefined) continue;
    const next = entityBoundsInDoc(document, entity);
    merged = merged === null ? next : mergeBounds(merged, next);
  }
  return merged !== null && boundsExtent(merged) > 0 ? merged : null;
}

/** Ids of the 3D solids the analysis uses: the selected ones, or every solid. */
function useBodyIds(allSolids: boolean): readonly string[] {
  const document = useDocumentWithoutSelection();
  const selection = useStore((s) => s.document.selection);
  const key = selection.join('|');
  return useMemo(
    () => (allSolids ? solidIds(document) : selection.filter((id) => isSolidBody(document, id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the selection contents
    [document, allSolids, key],
  );
}

const positive = (text: string): number | null => (Number(text) > 0 ? Number(text) : null);

export function useBodyAnalysis(inputs: AeroInputs): BodyAnalysis {
  const document = useDocumentWithoutSelection();
  const bodyIds = useBodyIds(inputs.allSolids);
  return useMemo((): BodyAnalysis => {
    const flow = flowVector(inputs.preset, inputs.custom);
    const empty = { bodyIds, flow, bounds: null, frontal: null, atmosphere: null, drag: null };
    if (flow === null) return { ...empty, problem: 'Enter a non-zero custom flow direction.' };
    const speed = Number(inputs.speed);
    if (inputs.speed.trim() === '' || !(speed >= 0)) return { ...empty, problem: 'Enter an air speed of 0 or more.' };
    const altitude = Number(inputs.altitude);
    const atmosphereResult = execute(document, 'standard_atmosphere', { altitude: Number.isFinite(altitude) ? altitude : 0 });
    const atmosphere = parseAtmosphere(atmosphereResult.data);
    if (atmosphere === null) return { ...empty, problem: atmosphereResult.summary };
    const coefficient = inputs.dragMode === 'cd' ? positive(inputs.cd) : positive(inputs.cdA);
    const measured = bodyIds.length === 0 ? null : execute(document, 'frontal_area', { entityIds: [...bodyIds], flowDirection: flow });
    const frontal = measured === null ? null : parseFrontal(measured.data);
    const bounds = frontal === null ? null : boundsOf(document, bodyIds);
    const base = { ...empty, atmosphere, frontal, bounds };
    if (measured !== null && frontal === null) return { ...base, problem: measured.summary };
    if (coefficient === null) return { ...base, problem: 'Enter a drag coefficient above 0.' };
    const areaSource =
      inputs.dragMode === 'cda' ? { cdA: coefficient } : frontal === null ? null : { cd: coefficient, referenceAreaM2: frontal.areaM2 };
    if (areaSource === null) return { ...base, problem: 'Select a solid (or tick All solids) to measure its frontal area.' };
    const dragResult = execute(document, 'aero_drag', {
      speed,
      speedUnit: inputs.speedUnit,
      altitudeM: Number.isFinite(altitude) ? altitude : 0,
      ...(frontal === null ? {} : { lengthM: frontal.lengthM }),
      ...areaSource,
    });
    const drag = parseDrag(dragResult.data);
    return { ...base, drag, problem: drag === null ? dragResult.summary : '' };
  }, [document, bodyIds, inputs]);
}

export interface AirfoilSource {
  /** Closed 2D polyline selected in the model, if any. */
  readonly entityId: string | null;
  readonly naca: string;
}

export const AIRFOIL_ALPHAS: readonly number[] = [-4, -2, 0, 2, 4, 6, 8, 10];

export interface AirfoilAnalysis {
  readonly view: AirfoilView | null;
  readonly problem: string;
}

/** The closed polyline airfoil in the selection (exactly one selected entity), or null. */
export function useSelectedAirfoilId(): string | null {
  const document = useDocumentWithoutSelection();
  const selection = useStore((s) => s.document.selection);
  const id = selection.length === 1 ? (selection[0] ?? null) : null;
  const entity = id === null ? undefined : document.entities[id];
  return entity?.kind === 'polyline' && entity.closed && entity.points.length >= 8 ? id : null;
}

export function useAirfoilAnalysis({ entityId, naca }: AirfoilSource): AirfoilAnalysis {
  const document = useDocumentWithoutSelection();
  return useMemo((): AirfoilAnalysis => {
    const code = naca.trim();
    if (entityId === null && code === '') return { view: null, problem: '' };
    const result = execute(document, 'analyze_airfoil', {
      ...(entityId === null ? { naca: code } : { entityId }),
      alphasDeg: [...AIRFOIL_ALPHAS],
      includeSurface: true,
    });
    const view = parseAirfoil(result.data);
    return { view, problem: view === null ? result.summary : '' };
  }, [document, entityId, naca]);
}
