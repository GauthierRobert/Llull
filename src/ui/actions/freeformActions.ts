// Palette / shortcut entry points of the direct-editing modes. They only switch UI modes (stores) for the selected entity; every edit made
// inside a mode is a registered command committed by its own drag.

import type { Entity } from '@core/model/types';
import { useStore } from '@ui/store';
import { useDirectEditStore } from '@ui/store/directEditStore';
import { useFaceEditStore } from '@ui/store/faceEditStore';
import { useNurbsNetStore } from '@ui/store/nurbsNetStore';
import { canEditFaces } from '@ui/viewport/3d/faceEdit/faceEditModel';
import { isNurbsNetEntity } from '@ui/viewport/3d/nurbsNet/controlNet';

function soleSelected(): Entity | undefined {
  const { document } = useStore.getState();
  const [only, extra] = document.selection;
  return only === undefined || extra !== undefined ? undefined : document.entities[only];
}

const say = (message: string): void => useStore.getState().setStatusMessage(message);

/** Start B-rep face handle editing on the selected solid. */
export function startFaceEditing(): void {
  if (canEditFaces(soleSelected())) useFaceEditStore.getState().start();
  else say('Select one exact solid (box, cylinder, extrusion, B-rep mesh...) to edit its faces.');
}

/** Start cage editing on the selected subdivision solid. */
export function startCageEditing(): void {
  const entity = soleSelected();
  if (entity?.kind === 'subdivision') useDirectEditStore.getState().enter(entity.id);
  else say('Select one subdivision solid to edit its cage.');
}

/** Show or hide the poles of the selected NURBS curve or surface. */
export function toggleControlNet(): void {
  if (isNurbsNetEntity(soleSelected()) || useNurbsNetStore.getState().visible) useNurbsNetStore.getState().toggle();
  else say('Select one NURBS curve or surface to show its poles.');
}
