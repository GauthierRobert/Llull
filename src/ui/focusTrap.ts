/** @layer ui Tab-key focus containment for modal dialogs (palette, MCP connect). */

import type React from 'react';

const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Every focusable element inside `container`, in DOM order. */
export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('hidden'),
  );
}

/** Keep Tab / Shift+Tab cycling inside `container`. */
export function trapTab(event: React.KeyboardEvent<HTMLElement>, container: HTMLElement): void {
  const focusable = focusableElements(container);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === container)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
