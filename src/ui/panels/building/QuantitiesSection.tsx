// Live bill of quantities + cost estimate (local read-only quantity_takeoff / estimate_cost), CSV downloads, and the
// unit-rate form (set_cost_rates).

import React, { useMemo, useState } from 'react';
import { useStore } from '@ui/store';
import { downloadCsvQuery, runQuery } from '@ui/services/localQuery';
import type { CostLine } from '@aec/index';
import { PanelSection } from '@ui/panels/PanelParts';
import { OptionSelect, PairSelect } from '@ui/panels/OptionSelect';
import { capitalize } from '@ui/panels/capitalize';
import { isEstimateData } from '@ui/resultData';
import { isRecord } from '@lib/isRecord';
import { parseNumber } from '@ui/numberText';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { entitiesFocus } from '@ui/panels/entityFocus';

const UNIT_LABEL: Readonly<Record<string, string>> = { m: 'm', m2: 'm²', m3: 'm³', ea: 'ea', kg: 'kg' };
const SCHEDULES = [
  'wall',
  'door',
  'window',
  'room',
  'slab',
  'column',
  'beam',
  'stair',
  'member',
  'footing',
  'panel',
  'equipment',
  'pipe',
  'tray',
  'plate',
  'connection',
  'support',
] as const;

const TAKEOFF_COLOR = '#26a69a';

/** A takeoff line's item: a button highlighting the elements of its category on the model (plain text when none is modelled). */
function TakeoffItem({ lineKey, category, description }: { lineKey: string; category: string; description: string }): React.ReactElement {
  const focusItem = useFocusItem();
  const ids = useStore((s) =>
    Object.values(s.document.building?.elements ?? {})
      .filter((element) => element.category === category)
      .flatMap((element) => element.entityIds)
      .join('|'),
  );
  if (ids === '') return <>{description}</>;
  return (
    <button
      type="button"
      className="takeoff-item"
      title="Show these elements on the model"
      data-testid={`takeoff-show-${lineKey}`}
      onClick={() =>
        focusItem(
          entitiesFocus(useStore.getState().document, {
            key: `building:takeoff:${lineKey}`,
            label: description,
            color: TAKEOFF_COLOR,
            ids: ids.split('|'),
          }),
        )
      }
    >
      {description}
    </button>
  );
}

function RateForm({ lines }: { lines: ReadonlyArray<CostLine> }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [key, setKey] = useState('');
  const [rate, setRate] = useState('');
  const selectedKey = key !== '' ? key : (lines[0]?.key ?? '');

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const value = parseNumber(rate);
    if (selectedKey === '' || value === undefined || value < 0) return;
    dispatch('set_cost_rates', { rates: { [selectedKey]: value } });
    setRate('');
  };

  return (
    <form className="building-inline-form" onSubmit={handleSubmit} aria-label="Set unit rate">
      <PairSelect
        value={selectedKey}
        options={lines.map((line) => [line.key, line.description] as const)}
        label="Rate item"
        testId="rate-key"
        onChange={setKey}
      />
      <input
        type="number"
        placeholder="Rate"
        value={rate}
        onChange={(event) => setRate(event.target.value)}
        aria-label="Unit rate"
        data-testid="rate-value"
      />
      <button type="submit" className="btn btn--ghost btn--sm">
        Set rate
      </button>
    </form>
  );
}

/** Mounted only while open: no estimate computed when collapsed. */
function EstimateTable(): React.ReactElement {
  const building = useStore((s) => s.document.building);
  const units = useStore((s) => s.document.units);
  const estimateResult = useMemo(
    () => runQuery('estimate_cost'),
    // The takeoff reads only building + units.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [building, units],
  );
  const estimate = isEstimateData(estimateResult.data) ? estimateResult.data : null;
  const grossResult = useMemo(
    () => runQuery('quantity_takeoff'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [building, units],
  );
  const gross = isRecord(grossResult.data) && isRecord(grossResult.data['gross']) ? grossResult.data['gross'] : {};
  const priced = estimate?.lines.filter((line) => line.amount !== null) ?? [];

  return (
    <>
      {estimate === null ? (
        <p className="panel__empty-hint" role="status">
          {estimateResult.summary}
        </p>
      ) : estimate.lines.length === 0 ? (
        <p className="panel__empty-hint">Add walls, slabs or columns to get quantities.</p>
      ) : (
        <>
          <table className="building-table" aria-label="Quantity takeoff">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Qty</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {estimate.lines.map((line) => (
                <tr key={line.key} data-testid={`takeoff-${line.key}`}>
                  <td title={line.key}>
                    <TakeoffItem lineKey={line.key} category={line.category} description={line.description} />
                  </td>
                  <td className="building-table__number">
                    {line.quantity} {UNIT_LABEL[line.unit] ?? line.unit}
                    {typeof gross[line.key] === 'number' && (
                      <span
                        className="panel__row-meta"
                        data-testid={`takeoff-gross-${line.key}`}
                        title="Raw modelled quantity before overlaps are removed"
                      >
                        {' '}
                        (net; gross {String(gross[line.key])})
                      </span>
                    )}
                  </td>
                  <td className="building-table__number">{line.amount === null ? '—' : line.amount.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={2}>
                  Total ({priced.length} priced)
                </th>
                <td className="building-table__number" data-testid="estimate-total">
                  {estimate.total.toFixed(2)} {estimate.currency}
                </td>
              </tr>
            </tfoot>
          </table>
          <RateForm lines={estimate.lines} />
        </>
      )}
    </>
  );
}

export function QuantitiesSection(): React.ReactElement {
  const [schedule, setSchedule] = useState<(typeof SCHEDULES)[number]>('wall');
  const [status, setStatus] = useState('');

  const downloadCsv = (command: string, params: Record<string, unknown>, fileName: string): void => {
    const { summary, downloaded } = downloadCsvQuery(command, params, fileName);
    if (!downloaded) setStatus(summary);
  };
  const downloadTakeoff = (): void => downloadCsv('quantity_takeoff', {}, 'quantity-takeoff.csv');
  const downloadEstimate = (): void => downloadCsv('estimate_cost', {}, 'cost-estimate.csv');
  const downloadSchedule = (): void => downloadCsv('building_schedule', { kind: schedule }, `${schedule}-schedule.csv`);

  return (
    <PanelSection
      title="Quantities & cost"
      step={4}
      hint="Material take-off (steel tonnage, concrete, areas) and schedules, as CSV for Excel."
      collapsible
      testId="building-quantities"
    >
      <EstimateTable />
      <div className="building-actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={downloadTakeoff}>
          Takeoff CSV
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={downloadEstimate}>
          Estimate CSV
        </button>
      </div>
      <div className="building-inline-form">
        <OptionSelect
          value={schedule}
          options={SCHEDULES}
          label="Schedule"
          optionLabel={(kind) => `${capitalize(kind)} schedule`}
          onChange={setSchedule}
        />
        <button type="button" className="btn btn--ghost btn--sm" onClick={downloadSchedule}>
          Schedule CSV
        </button>
      </div>
      {status !== '' && (
        <p className="panel__empty-hint" role="status">
          {status}
        </p>
      )}
    </PanelSection>
  );
}
