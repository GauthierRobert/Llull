// Metres (`set_units`), survey file (.csv / .txt or pasted) with column format + unit → `import_survey_points`; groups.

import React, { useState } from 'react';
import { DOCUMENT_UNITS, type DocumentUnit } from '@core/model/types';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';
import { OptionSelect } from '@ui/panels/OptionSelect';
import { CivilObjectRow, useCivilObjects, TextField, type CivilStepState } from './CivilParts';
import { DxfImports } from './DxfImports';
import { fileStem } from '@ui/chosenFile';
import { FileField } from '@ui/panels/FileField';
import { optionalText } from '@ui/numberText';

const FORMATS = ['PENZD', 'PNEZD', 'PENZ', 'PNEZ', 'ENZ', 'NEZ'] as const;

const FORMAT_HINT: Readonly<Record<(typeof FORMATS)[number], string>> = {
  PENZD: 'Point, Easting, Northing, Z, Description',
  PNEZD: 'Point, Northing, Easting, Z, Description',
  PENZ: 'Point, Easting, Northing, Z',
  PNEZ: 'Point, Northing, Easting, Z',
  ENZ: 'Easting, Northing, Z',
  NEZ: 'Northing, Easting, Z',
};

/** "Import 120 lines": non-empty lines of the pasted / loaded text (a header line counts: a preview, not the parse). */
function importLabel(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '').length;
  return lines === 0 ? 'Import points' : `Import ${lines} line${lines === 1 ? '' : 's'}`;
}

export function SurveySection({ defaultOpen = true, done = false }: Partial<CivilStepState>): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const groups = useCivilObjects('pointGroup');
  const documentUnit = useStore((s) => s.document.units);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [format, setFormat] = useState<(typeof FORMATS)[number]>('PENZD');
  const [unit, setUnit] = useState<DocumentUnit>('m');

  const loadFile = (content: string, fileName: string): void => {
    setText(content);
    setName((previous) => (previous.trim() === '' ? fileStem(fileName) : previous));
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (text.trim() === '') return;
    dispatch('import_survey_points', { text, format, sourceUnit: unit, ...optionalText('name', name) });
    setText('');
    setName('');
  };

  return (
    <PanelSection
      title="Survey"
      step={1}
      hint="Import the topographic survey (total station / GNSS export) as a point group."
      count={groups.length}
      countLabel={`${groups.length} point groups`}
      collapsible
      defaultOpen={defaultOpen}
      done={done}
      testId="civil-survey"
    >
      {documentUnit !== 'm' && (
        <div className="building-actions">
          <span className="panel__empty-hint">The document is in {documentUnit}; site work reads best in metres.</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => dispatch('set_units', { units: 'm' })}>
            Work in metres
          </button>
        </div>
      )}
      {groups.length > 0 && (
        <ul className="civil-list" aria-label="Point groups">
          {groups.map((group) => (
            <CivilObjectRow key={group.id} object={group} detail={`${group.points.length} points`} />
          ))}
        </ul>
      )}
      <form className="civil-form" onSubmit={handleSubmit} aria-label="Import survey points">
        <FileField label="Points file" accept=".csv,.txt,.xyz" ariaLabel="Survey file" onText={loadFile} />
        <textarea
          className="civil-points-text"
          value={text}
          rows={3}
          placeholder={'…or paste points, one per line:\n1001,1000.0,2000.0,52.31,TOPO'}
          aria-label="Survey points text"
          onChange={(event) => setText(event.target.value)}
        />
        <div className="building-inline-form">
          <label className="civil-field">
            <span className="civil-field__label">Columns</span>
            <OptionSelect value={format} options={FORMATS} label="Survey format" title={FORMAT_HINT[format]} onChange={setFormat} />
          </label>
          <label className="civil-field">
            <span className="civil-field__label">Unit</span>
            <OptionSelect value={unit} options={DOCUMENT_UNITS} label="Survey unit" onChange={setUnit} />
          </label>
          <p className="civil-field__hint">{FORMAT_HINT[format]}</p>
          <TextField value={name} set={setName} hint="from the file name" label="Point group name" />
          <button type="submit" className="btn btn--primary btn--sm" disabled={text.trim() === ''}>
            {importLabel(text)}
          </button>
        </div>
      </form>
      <DxfImports unit={unit} />
    </PanelSection>
  );
}
