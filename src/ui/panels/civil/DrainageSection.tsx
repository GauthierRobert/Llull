// Storm network: manhole / pipe forms + lists, `check_drainage_network` (failures + CSV; constant intensity or IDF storm;
// outfall tailwater for the HGL), `size_drainage_pipes`, `drainage_schedule` CSV.

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { QueryDownloadButton } from '@ui/panels/QueryDownloadButton';
import { CivilObjectRow, useCivilObjects, NumberTextField, type CivilStepState } from './CivilParts';
import { ManholeForm, PipeForm } from './DrainageForms';
import { optionalNumber } from '@ui/numberText';
import { IDF_FIELDS, failuresOf, stormParams } from './civilRules';
import { downloadCsvQuery, runQuery } from '@ui/services/localQuery';

function NetworkChecks(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [rainfall, setRainfall] = useState('');
  const [idf, setIdf] = useState({ a: '', b: '', c: '' });
  const [outfall, setOutfall] = useState('');
  const [status, setStatus] = useState('');
  const [failures, setFailures] = useState<string[]>([]);
  const rainfallParams = stormParams(rainfall, idf);
  const checkParams = { ...rainfallParams, ...optionalNumber('outfallLevel', outfall) };

  const check = (): void => {
    const result = runQuery('check_drainage_network', checkParams);
    setStatus(result.summary);
    setFailures(failuresOf(result.data));
  };

  const checkCsv = (): void => {
    setStatus(downloadCsvQuery('check_drainage_network', checkParams, 'drainage-check.csv').summary);
  };

  return (
    <>
      <div className="building-actions">
        <NumberTextField value={rainfall} set={setRainfall} hint="Rainfall mm/h (50)" label="Rainfall intensity" />
        {IDF_FIELDS.map((key) => (
          <input
            key={key}
            type="number"
            value={idf[key]}
            placeholder={`IDF ${key}`}
            title="IDF curve i = a / (t + b)^c mm/h (replaces the constant intensity)"
            aria-label={`IDF ${key}`}
            onChange={(event) => setIdf((prev) => ({ ...prev, [key]: event.target.value }))}
          />
        ))}
        <input
          type="number"
          value={outfall}
          placeholder="Outfall level"
          title="Tailwater level at the outfall for the hydraulic grade line"
          aria-label="Outfall level"
          onChange={(event) => setOutfall(event.target.value)}
        />
        <button type="button" className="btn btn--primary btn--sm" onClick={check}>
          Check network
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={checkCsv}>
          Check CSV
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          title="Pick the smallest standard diameter that carries the design flow"
          onClick={() => dispatch('size_drainage_pipes', rainfallParams)}
        >
          Size pipes
        </button>
        <QueryDownloadButton
          label="Schedule CSV"
          command="drainage_schedule"
          field="csv"
          fallbackName="drainage-schedule.csv"
          mimeType="text/csv"
          onStatus={setStatus}
        />
      </div>
      <StatusLine text={status} testId="civil-drainage-status" />
      {failures.length > 0 && (
        <ul className="civil-failures" aria-label="Drainage failures">
          {failures.map((failure, index) => (
            // Messages may repeat: the position disambiguates the key.
            <li key={`${index}:${failure}`} className="panel__error">
              {failure}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function DrainageSection({ defaultOpen = true, done = false }: Partial<CivilStepState>): React.ReactElement {
  const manholes = useCivilObjects('manhole');
  const pipes = useCivilObjects('pipe');
  const civil = useStore((s) => s.document.civil);
  const nameOf = (id: string): string => civil?.objects[id]?.name ?? id;
  return (
    <PanelSection
      title="Drainage"
      step={5}
      hint="Storm sewer: manholes, gravity pipes, rational-method check and pipe sizing."
      count={manholes.length + pipes.length}
      countLabel={`${manholes.length} manholes, ${pipes.length} pipes`}
      collapsible
      defaultOpen={defaultOpen}
      done={done}
      testId="civil-drainage"
    >
      <ManholeForm />
      {manholes.length > 0 && (
        <ul className="civil-list" aria-label="Manholes">
          {manholes.map((manhole) => (
            <CivilObjectRow key={manhole.id} object={manhole} detail={`invert ${manhole.invertElevation}, rim ${manhole.rimElevation}`} />
          ))}
        </ul>
      )}
      <PipeForm />
      {pipes.length > 0 && (
        <ul className="civil-list" aria-label="Pipes">
          {pipes.map((pipe) => (
            <CivilObjectRow
              key={pipe.id}
              object={pipe}
              detail={`${nameOf(pipe.fromId)} → ${nameOf(pipe.toId)}, Ø ${pipe.diameter} ${pipe.material}`}
            />
          ))}
        </ul>
      )}
      {pipes.length > 0 && <NetworkChecks />}
    </PanelSection>
  );
}
