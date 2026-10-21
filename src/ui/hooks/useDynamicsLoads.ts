// The document's rigid-body loads (`dynamicsLoads`) as design values and, while a run is loaded, at the playback time.

import { useMemo } from 'react';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';
import { bodyCentres, dynamicsLoads, type LoadItem } from '@dynamics/index';

interface DynamicsLoads {
  /** Design values (no run). */
  readonly design: readonly LoadItem[];
  /** At the playback time while a run is loaded, else the design values. */
  readonly current: readonly LoadItem[];
}

export function useDynamicsLoads(): DynamicsLoads {
  const document = useDocumentWithoutSelection();
  const result = useDynamicsPlaybackStore((s) => s.result);
  const time = useDynamicsPlaybackStore((s) => s.time);
  const hasDynamics = document.dynamics !== undefined;
  const centres = useMemo(() => (hasDynamics ? bodyCentres(document) : {}), [document, hasDynamics]);
  const design = useMemo(() => dynamicsLoads(document, null, centres), [document, centres]);
  const current = useMemo(
    () => (result === null ? design : dynamicsLoads(document, { result, time }, centres)),
    [document, centres, design, result, time],
  );
  return { design, current };
}
