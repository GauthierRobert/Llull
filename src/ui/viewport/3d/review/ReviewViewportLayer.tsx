// In-Canvas layer of the model review: the active colour profile's tints and the active section box's gizmo.

import { ProfileTintSync } from './ProfileTintSync';
import { SectionBoxGizmo } from './SectionBoxGizmo';

export function ReviewViewportLayer(): React.ReactElement {
  return (
    <>
      <ProfileTintSync />
      <SectionBoxGizmo />
    </>
  );
}
