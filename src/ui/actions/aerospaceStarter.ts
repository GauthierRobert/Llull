// "Aerospace starter": ONE `build_project` plan (aerospacePlan) over the sample fastener catalogue (public/samples): a UAV propulsion pod
// with materials, sheet metal, machined features, bolts, a MuJoCo propulsion drive, static + thermal FE cases and a drawing sheet.

import { useStore } from '@ui/store';
import { aerospaceStarterActions } from '@ui/actions/aerospacePlan';

const FASTENER_CATALOG_URL = `${import.meta.env.BASE_URL}samples/aero-fastener-catalog.json`;

/** @returns the status line (dispatch summary, or why the catalogue did not load) */
export async function startAerospaceProject(): Promise<string> {
  const { dispatch, setStatusMessage } = useStore.getState();
  let catalog: unknown;
  try {
    const response = await fetch(FASTENER_CATALOG_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    catalog = await response.json();
  } catch (error) {
    const message = `Aerospace starter: could not load the sample fastener catalogue (${(error as Error).message}).`;
    setStatusMessage(message);
    return message;
  }
  return new Promise((resolve) => {
    dispatch('build_project', { actions: aerospaceStarterActions(catalog) }, { onResult: (result) => resolve(result.summary) });
  });
}
