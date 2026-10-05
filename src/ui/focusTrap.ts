/** @layer ui Tab-key focus containment for modal dialogs (palette, MCP connect). */

import type React from 'react';

const CONTROL_SELECTOR = 'button,input,select,textarea,[tabindex]:not([tabindex="-1"])';

interface FocusTrapOptions {
  /** Also treat `a[href]` links as focusable (MCP connect dialog); the palette has none. */
  readonly links?: boolean;
}

/** Focusable elements inside `container`, in DOM order; disabled and hidden ones are skipped. */
export function focusableElements(
  container: HTMLElement,
  { links = false }: FocusTrapOptions = {},
): HTMLElement[] {
  const selector = links ? `a[href],${CONTROL_SELECTOR}` : CONTROL_SELECTOR;
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => !element.hasAttribute('disabled') && !element.hasAttribute('hidden'),
  );
}

/** Keep Tab / Shift+Tab cycling inside `container`. */
export function trapTab(
  event: React.KeyboardEvent<HTMLElement>,
  container: HTMLElement,
  options: FocusTrapOptions = {},
): void {
  const focusable = focusableElements(container, options);
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
