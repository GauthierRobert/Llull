// Viewport input onKeyDown: Enter commits (preventDefault, never submits an ancestor form), Escape cancels.

import type { KeyboardEvent } from 'react';

export function enterEscapeKeys(handlers: { onEnter?: () => void; onEscape?: () => void }): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key === 'Enter' && handlers.onEnter) {
      event.preventDefault();
      handlers.onEnter();
    } else if (event.key === 'Escape') handlers.onEscape?.();
  };
}
