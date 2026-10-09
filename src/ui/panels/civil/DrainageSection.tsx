/**
 * @layer ui/panels/civil
 *
 * DrainageSection — storm network: manhole / pipe forms and lists, network check
 * (`check_drainage_network`: failures + CSV), automatic sizing (`size_drainage_pipes`) and the
 * structure / pipe schedule CSV (`drainage_schedule`).
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { downloadText } from '@ui/download';
import { isCsvData } from '@ui/resultData';
import { PanelSection } from '@ui/panels/PanelParts';
import { CivilObjectRow, CivilStatus, useCivilObjects } from './CivilParts';
import { ManholeForm, PipeForm } from './DrainageForms';
import { optionalNumber } from './civilInput';
import { downloadQuery, runQuery } from './civilQuery';

function failuresOf(data: unknown): string[] {
  if (typeof data !== 'object' || data === null || !('failures' in data)) return [];
  const failures: unknown = data.failures;
  return Array.isArray(failures)
    ? failures.filter((item): item is string => typeof item === 'string')
    : [];
}

function NetworkChecks(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [rainfall, setRainfall] = useState('');
  const [status, setStatus] = useState('');
  const [failures, setFailures] = useState<string[]>([]);
  const rainfallParams = optionalNumber('rainfallIntensityMmH', rainfall);

  const check = (): void => {
    const result = runQuery('check_drainage_network', rainfallParams);
    setStatus(result.summary);
    setFailures(failuresOf(result.data));
  };

  const checkCsv = (): void => {
    const result = runQuery('check_drainage_network', rainfallParams);
    if (isCsvData(result.data)) downloadText(result.data.csv, 'drainage-check.csv', 'text/csv');
    setStatus(result.summary);
  };

  return (
    <>
      <div className="building-actions">
        <input
          type="number"
          value={rainfall}
          placeholder="Rainfall mm/h (50)"
          aria-label="Rainfall intensity"
          onChange={(event) => setRainfall(event.target.value)}
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
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() =>
            setStatus(
              downloadQuery('drainage_schedule', {}, 'csv', 'drainage-schedule.csv', 'text/csv'),
            )
          }
        >
          Schedule CSV
        </button>
      </div>
      <CivilStatus text={status} testId="civil-drainage-status" />
      {failures.length > 0 && (
        <ul className="civil-failures" aria-label="Drainage failures">
          {failures.map((failure) => (
            <li key={failure} className="panel__error">
              {failure}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function DrainageSection(): React.ReactElement {
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
      testId="civil-drainage"
    >
      <ManholeForm />
      {manholes.length > 0 && (
        <ul className="civil-list" aria-label="Manholes">
          {manholes.map((manhole) => (
            <CivilObjectRow
              key={manhole.id}
              object={manhole}
              detail={`invert ${manhole.invertElevation}, rim ${manhole.rimElevation}`}
            />
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
