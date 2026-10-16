// File picker as one compact button (label + accepted extensions, then the picked file's name) handing the file over as text or `File`;
// the native input is visually hidden inside the label and clears itself so re-picks fire.

import React, { useState } from 'react';
import { readChosenFile, takeChosenFile } from '@ui/chosenFile';
import { Icon } from '@ui/components/Icon';

interface FileFieldBase {
  /** Button text; omitted = "Choose file". */
  label?: string;
  accept: string;
  ariaLabel: string;
  /** Tooltip, e.g. what the import does with the file. */
  title?: string;
}

type FileFieldProps = FileFieldBase &
  ({ onText: (text: string, fileName: string) => void; onFile?: never } | { onFile: (file: File) => void; onText?: never });

/** "Survey DXF" already says what `.dxf` would. */
function namesFormat(label: string | undefined, accept: string): boolean {
  const text = (label ?? '').toLowerCase();
  return accept.split(',').every((extension) => text.includes(extension.replace('.', '').toLowerCase()));
}

export function FileField({ label, accept, ariaLabel, title, ...handlers }: FileFieldProps): React.ReactElement {
  const [picked, setPicked] = useState('');
  const onChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    setPicked(event.target.files?.[0]?.name ?? '');
    if (handlers.onText !== undefined) {
      readChosenFile(event, handlers.onText);
      return;
    }
    const file = takeChosenFile(event);
    if (file) handlers.onFile(file);
  };
  return (
    <label className="file-btn" title={title ?? `${label ?? 'Choose file'} (${accept})`}>
      <input className="file-btn__input" type="file" accept={accept} aria-label={ariaLabel} onChange={onChange} />
      <Icon name="open" size={13} />
      <span className="file-btn__label">{label ?? 'Choose file'}</span>
      {(picked !== '' || !namesFormat(label, accept)) && (
        <span className="file-btn__meta">{picked !== '' ? picked : accept.split(',').join(' ')}</span>
      )}
    </label>
  );
}
