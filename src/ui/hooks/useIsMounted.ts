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
