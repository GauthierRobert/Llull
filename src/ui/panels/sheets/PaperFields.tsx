// The paper size and projection angle selects shared by the new-sheet and edit-sheet forms.

import React from 'react';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { PAPER_OPTIONS, PROJECTION_OPTIONS } from './sheetOptions';

interface PaperFieldsProps {
  /** Prefix of the field test ids (several forms can be on screen). */
  idPrefix: string;
  paper: string;
  projectionAngle: string;
  onChange: (key: 'paper' | 'projectionAngle', value: string) => void;
}

export function PaperFields({ idPrefix, paper, projectionAngle, onChange }: PaperFieldsProps): React.ReactElement {
  return (
    <>
      <LabeledSelect
        label="Paper"
        value={paper}
        options={PAPER_OPTIONS}
        testId={`${idPrefix}-paper`}
        onChange={(value) => onChange('paper', value)}
      />
      <LabeledSelect
        label="Projection"
        value={projectionAngle}
        options={PROJECTION_OPTIONS}
        testId={`${idPrefix}-projection`}
        onChange={(value) => onChange('projectionAngle', value)}
      />
    </>
  );
}
