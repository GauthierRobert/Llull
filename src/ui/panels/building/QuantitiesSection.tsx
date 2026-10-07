/**
 * @layer ui/panels/building
 *
 * QuantitiesSection — live bill of quantities + cost estimate (read-only `quantity_takeoff` /
 * `estimate_cost`, run locally), CSV downloads of the takeoff and schedules, and a unit-rate form
 * that dispatches `set_cost_rates`.
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '@ui/store';
import { execute } from '@core/commands/registry';
import type { CostLine } from '@aec/index';
import { PanelSection } from '@ui/panels/PanelParts';
import { OptionSelect } from '@ui/panels/OptionSelect';
import { capitalize } from '@ui/panels/capitalize';
import { downloadText } from '@ui/download';
import { isCsvData, isEstimateData } from '@ui/resultData';

const UNIT_LABEL: Readonly<Record<string, string>> = {
  m: 'm',
  m2: 'm²',
  m3: 'm³',
  ea: 'ea',
  kg: 'kg',
};
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

function RateForm({ lines }: { lines: ReadonlyArray<CostLine> }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [key, setKey] = useState('');
  const [rate, setRate] = useState('');
  const selectedKey = key !== '' ? key : (lines[0]?.key ?? '');

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const value = Number(rate);
    if (selectedKey === '' || rate.trim() === '' || !Number.isFinite(value) || value < 0) return;
    dispatch('set_cost_rates', { rates: { [selectedKey]: value } });
    setRate('');
  };

  return (
    <form className="building-inline-form" onSubmit={handleSubmit} aria-label="Set unit rate">
      <select
        value={selectedKey}
        onChange={(event) => setKey(event.target.value)}
        aria-label="Rate item"
        data-testid="rate-key"
      >
        {lines.map((line) => (
          <option key={line.key} value={line.key}>
            {line.key}
          </option>
        ))}
      </select>
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

export function QuantitiesSection(): React.ReactElement {
  // The takeoff reads only the building model and the document units: re-run on those alone.
  const building = useStore((s) => s.document.building);
  const units = useStore((s) => s.document.units);
  const [schedule, setSchedule] = useState<(typeof SCHEDULES)[number]>('wall');
  const [status, setStatus] = useState('');
  const estimateResult = useMemo(
    () => execute(useStore.getState().document, 'estimate_cost', {}),
    // building + units are the only document slices the takeoff reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [building, units],
  );
  const estimate = isEstimateData(estimateResult.data) ? estimateResult.data : null;
  const priced = estimate?.lines.filter((line) => line.amount !== null) ?? [];

  const downloadCsv = (command: string, params: object, fileName: string): void => {
    const result = execute(useStore.getState().document, command, params);
    if (isCsvData(result.data)) downloadText(result.data.csv, fileName, 'text/csv');
    else setStatus(result.summary);
  };
  const downloadTakeoff = (): void => downloadCsv('quantity_takeoff', {}, 'quantity-takeoff.csv');
  const downloadEstimate = (): void => {
    if (estimate !== null) downloadText(estimate.csv, 'cost-estimate.csv', 'text/csv');
  };
  const downloadSchedule = (): void =>
    downloadCsv('building_schedule', { kind: schedule }, `${schedule}-schedule.csv`);

  return (
    <PanelSection title="Quantities & cost" collapsible testId="building-quantities">
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
                  <td title={line.key}>{line.description}</td>
                  <td className="building-table__number">
                    {line.quantity} {UNIT_LABEL[line.unit] ?? line.unit}
                  </td>
                  <td className="building-table__number">
                    {line.amount === null ? '—' : line.amount.toFixed(2)}
                  </td>
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
