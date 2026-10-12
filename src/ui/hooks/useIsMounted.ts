/** @layer ui/hooks Guard for async callbacks that would set state after the component unmounted. */

import { useCallback, useEffect, useRef } from 'react';

/** Stable `isMounted()` getter: false once the component has unmounted. */
export function useIsMounted(): () => boolean {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => mounted.current, []);
}
