/**
 * @layer ui/components
 *
 * ModalDialog — the shell shared by every modal (confirm, shortcuts, command palette, MCP
 * connect): a backdrop that closes on a direct hit, a `role="dialog"` box where Escape closes and
 * Tab stays trapped, initial focus on open and focus handed back to the opener on close.
 * Presentation only.
 */

import React, { useEffect, useRef } from 'react';
import { focusableElements, trapTab } from '@ui/focusTrap';

interface ModalDialogProps {
  backdropClassName: string;
  className: string;
  onClose: () => void;
  /** Backdrop event that closes the dialog. Default 'click'. */
  closeOn?: 'click' | 'mousedown';
  /** Id of the visible title, or `label` when there is none. */
  labelledBy?: string;
  label?: string;
  tabIndex?: number;
  /** Focused on open: an element, or the first focusable control. Default none. */
  initialFocus?: React.RefObject<HTMLElement | null> | 'first';
  /** Give focus back to the element focused before opening. Default true. */
  restoreFocus?: boolean;
  /** Also trap focus on `a[href]` links. */
  links?: boolean;
  /** Replaces the default Tab trap (cycle through the focusable controls). */
  onTab?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
}

export function ModalDialog({
  backdropClassName,
  className,
  onClose,
  closeOn = 'click',
  labelledBy,
  label,
  tabIndex,
  initialFocus,
  restoreFocus = true,
  links = false,
  onTab,
  children,
}: ModalDialogProps): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Mount = open (callers render the dialog only while open); unmount = close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (initialFocus === 'first') {
      const dialog = dialogRef.current;
      if (dialog) focusableElements(dialog, { links })[0]?.focus();
    } else {
      initialFocus?.current?.focus();
    }
    return () => {
      if (restoreFocus && opener?.isConnected === true) opener.focus();
    };
    // Open / close only: the options are fixed for the dialog's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeOnHit = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div
      className={backdropClassName}
      {...(closeOn === 'click' ? { onClick: closeOnHit } : { onMouseDown: closeOnHit })}
    >
      <div
        ref={dialogRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={label}
        tabIndex={tabIndex}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          } else if (event.key === 'Tab') {
            if (onTab) onTab(event);
            else if (dialogRef.current) trapTab(event, dialogRef.current, { links });
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
