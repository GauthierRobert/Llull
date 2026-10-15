// The five title block text inputs shared by the new-sheet and edit-sheet forms.

import React from 'react';
import { LabeledInput } from '@ui/panels/LabeledInput';
import type { TitleBlockDraft } from './sheetOptions';

interface TitleBlockFieldsProps {
  /** Prefix of the field test ids (several forms can be on screen). */
  idPrefix: string;
  values: TitleBlockDraft;
  onChange: (key: keyof TitleBlockDraft, value: string) => void;
}

const FIELDS: ReadonlyArray<readonly [keyof TitleBlockDraft, string]> = [
  ['title', 'Title'],
  ['drawnBy', 'Drawn by'],
  ['partNumber', 'Part no.'],
  ['revision', 'Revision'],
  ['date', 'Date'],
];

export function TitleBlockFields({ idPrefix, values, onChange }: TitleBlockFieldsProps): React.ReactElement {
  return (
    <>
      {FIELDS.map(([key, label]) => (
        <LabeledInput
          key={key}
          label={label}
          type="text"
          value={values[key]}
          testId={`${idPrefix}-${key}`}
          onChange={(value) => onChange(key, value)}
        />
      ))}
    </>
  );
}
