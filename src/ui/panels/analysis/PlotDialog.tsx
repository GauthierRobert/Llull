// Full-size view of an analysis plot (contour or probe chart) in a modal.

import React from 'react';
import { ModalDialog } from '@ui/components/ModalDialog';

interface PlotDialogProps {
  src: string;
  alt: string;
  label: string;
  onClose: () => void;
}

export function PlotDialog({ src, alt, label, onClose }: PlotDialogProps): React.ReactElement {
  return (
    <ModalDialog
      backdropClassName="shortcuts-backdrop"
      className="shortcuts-dialog analysis__dialog"
      onClose={onClose}
      label={label}
      initialFocus="first"
    >
      <img className="analysis__plot analysis__plot--full" alt={alt} src={src} />
      <button type="button" className="btn btn--ghost" onClick={onClose}>
        Close
      </button>
    </ModalDialog>
  );
}
