/**
 * @layer ui/viewport
 * `onKeyDown` handler for viewport text/number inputs: Enter commits (default prevented so it never
 * submits an ancestor form), Escape cancels. Either callback may be omitted.
 */

import type { KeyboardEvent } from 'react';

export function enterEscapeKeys(handlers: {
  onEnter?: () => void;
  onEscape?: () => void;
}): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key === 'Enter' && handlers.onEnter) {
      event.preventDefault();
      handlers.onEnter();
    } else if (event.key === 'Escape') handlers.onEscape?.();
  };
}
