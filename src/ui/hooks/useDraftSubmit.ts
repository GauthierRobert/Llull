/**
 * @layer ui/hooks
 * Form `onSubmit` handler that dispatches `command` with the validated `draft` (null = not ready,
 * nothing is sent) and calls `onChanged` only when the document changed.
 */

import type { FormEvent } from 'react';
import { useDispatchThen } from '@ui/hooks/useDispatchThen';

export function useDraftSubmit(
  command: string,
  draft: unknown,
  onChanged: () => void,
): (event: FormEvent) => void {
  const dispatchThen = useDispatchThen();
  return (event) => {
    event.preventDefault();
    if (draft === null) return;
    dispatchThen(command, draft, onChanged);
  };
}
