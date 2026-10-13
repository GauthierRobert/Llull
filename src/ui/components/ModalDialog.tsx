// Shared modal shell: backdrop closes on a direct hit, role="dialog" with Escape-to-close and a Tab trap, initial
// focus on open, focus returned to the opener on close.

import React, { useEffect, useRef } from 'react';
import { focusableElements, trapTab } from '@ui/focusTrap';

interface ModalDialogProps {
  backdropClassName: string;
  className: string;
  onClose: () => void;
  /** Default 'click'. */
  closeOn?: 'click' | 'mousedown';
  /** Visible title id, else `label`. */
  labelledBy?: string;
  label?: string;
  tabIndex?: number;
  /** An element, or the first focusable control. */
  initialFocus?: React.RefObject<HTMLElement | null> | 'first';
  /** Default true. */
  restoreFocus?: boolean;
  /** Also trap focus on `a[href]` links. */
  links?: boolean;
  /** Replaces the default Tab cycle. */
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
    <div className={backdropClassName} {...(closeOn === 'click' ? { onClick: closeOnHit } : { onMouseDown: closeOnHit })}>
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
