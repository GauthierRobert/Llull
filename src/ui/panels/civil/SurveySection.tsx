/**
 * @layer ui/panels/civil
 *
 * SurveySection — load a survey file (.csv / .txt, or paste it), choose its column format and
 * unit, dispatch `import_survey_points`; lists the point groups.
 */

import React, { useState } from 'react';
import { DOCUMENT_UNITS, type DocumentUnit } from '@core/model/types';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';
import { OptionSelect } from '@ui/panels/OptionSelect';
import { CivilObjectRow, useCivilObjects } from './CivilParts';
import { DxfImports, readChosenFile } from './DxfImports';

const FORMATS = ['PENZD', 'PNEZD', 'PENZ', 'PNEZ', 'ENZ', 'NEZ'] as const;

const FORMAT_HINT: Readonly<Record<(typeof FORMATS)[number], string>> = {
  PENZD: 'Point, Easting, Northing, Z, Description',
  PNEZD: 'Point, Northing, Easting, Z, Description',
  PENZ: 'Point, Easting, Northing, Z',
  PNEZ: 'Point, Northing, Easting, Z',
  ENZ: 'Easting, Northing, Z',
  NEZ: 'Northing, Easting, Z',
};

export function SurveySection(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const groups = useCivilObjects('pointGroup');
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [format, setFormat] = useState<(typeof FORMATS)[number]>('PENZD');
  const [unit, setUnit] = useState<DocumentUnit>('m');

  const loadFile = (event: React.ChangeEvent<HTMLInputElement>): void =>
    readChosenFile(event, (content, fileName) => {
      setText(content);
      setName((previous) => (previous.trim() === '' ? fileName.replace(/\.[^.]+$/, '') : previous));
    });

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (text.trim() === '') return;
    dispatch('import_survey_points', {
      text,
      format,
      sourceUnit: unit,
      ...(name.trim() !== '' ? { name: name.trim() } : {}),
    });
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
      testId="civil-survey"
    >
      <form className="civil-form" onSubmit={handleSubmit} aria-label="Import survey points">
        <input type="file" accept=".csv,.txt,.xyz" aria-label="Survey file" onChange={loadFile} />
        <textarea
          value={text}
          rows={3}
          placeholder="1001,1000.0,2000.0,52.31,TOPO"
          aria-label="Survey points text"
          onChange={(event) => setText(event.target.value)}
        />
        <div className="building-inline-form">
          <OptionSelect
            value={format}
            options={FORMATS}
            label="Survey format"
            optionLabel={(option) => `${option} — ${FORMAT_HINT[option]}`}
            onChange={setFormat}
          />
          <OptionSelect
            value={unit}
            options={DOCUMENT_UNITS}
            label="Survey unit"
            onChange={setUnit}
          />
          <input
            value={name}
            placeholder="Group name"
            aria-label="Point group name"
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="btn btn--primary btn--sm" disabled={text.trim() === ''}>
            Import points
          </button>
        </div>
      </form>
      <DxfImports unit={unit} />
      {groups.length > 0 && (
        <ul className="civil-list" aria-label="Point groups">
          {groups.map((group) => (
            <CivilObjectRow
              key={group.id}
              object={group}
              detail={`${group.points.length} points`}
            />
          ))}
        </ul>
      )}
    </PanelSection>
  );
}
