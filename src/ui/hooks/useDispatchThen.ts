/**
 * @layer ui/hooks
 * Dispatch a command and react to its outcome, but only while the component is still mounted:
 * `onChanged` when the document changed (e.g. reset the form), `onRefused(summary)` otherwise (e.g.
 * keep the typed values and show why).
 */

import { useCallback } from 'react';
import { useStore } from '@ui/store';
import { useIsMounted } from '@ui/hooks/useIsMounted';

export function useDispatchThen(): (
  command: string,
  params: unknown,
  onChanged: () => void,
  onRefused?: (summary: string) => void,
) => void {
  const dispatch = useStore((s) => s.dispatch);
  const isMounted = useIsMounted();
  return useCallback(
    (command, params, onChanged, onRefused) =>
      dispatch(command, params, {
        onResult: ({ summary, changed }) => {
          if (!isMounted()) return;
          if (changed) onChanged();
          else onRefused?.(summary);
        },
      }),
    [dispatch, isMounted],
  );
}
