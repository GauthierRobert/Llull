/**
 * @layer ui/panels
 * FileField — a file `<input>` (optionally in a `field` label) that hands the chosen file to the
 * caller as text or as a `File`, and clears itself so the same file can be picked again.
 */

import React from 'react';
import { readChosenFile, takeChosenFile } from '@ui/chosenFile';

interface FileFieldBase {
  /** Visible label; omitted = the bare input. */
  label?: string;
  accept: string;
  ariaLabel: string;
}

type FileFieldProps = FileFieldBase &
  ({ onText: (text: string, fileName: string) => void; onFile?: never } | { onFile: (file: File) => void; onText?: never });

export function FileField({ label, accept, ariaLabel, ...handlers }: FileFieldProps): React.ReactElement {
  const onChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    if (handlers.onText !== undefined) {
      readChosenFile(event, handlers.onText);
      return;
    }
    const file = takeChosenFile(event);
    if (file) handlers.onFile(file);
  };
  const input = <input type="file" accept={accept} aria-label={ariaLabel} onChange={onChange} />;
  if (label === undefined) return input;
  return (
    <label className="field">
      <span>{label}</span>
      {input}
    </label>
  );
}
