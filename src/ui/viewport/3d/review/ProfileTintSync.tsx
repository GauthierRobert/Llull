// In-Canvas sync adapter: the active colour profile (document.display) as tints for the entity renderers (tintStore profile layer).

import { useEffect, useMemo } from 'react';
import { entityPropertyProviders } from '@core/plugins/host';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { useTintStore } from '@ui/store/tintStore';
import { profileTints } from './profileTints';

export function ProfileTintSync(): null {
  const document = useDocumentWithoutSelection();
  const tints = useMemo(() => profileTints(document, entityPropertyProviders()), [document]);
  useEffect(() => {
    useTintStore.getState().setProfileTints(tints);
    return () => useTintStore.getState().setProfileTints(new Map());
  }, [tints]);
  return null;
}
