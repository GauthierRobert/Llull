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
import type { CostLine } from '@core/commands/building/quantities';
import { PanelSection } from '@ui/panels/PanelParts';
import { downloadText } from '@ui/download';

const UNIT_LABEL: Readonly<Record<string, string>> = { m: 'm', m2: 'm²', m3: 'm³', ea: 'ea' };
const SCHEDULES = ['wall', 'door', 'window', 'room', 'slab', 'column', 'beam', 'stair'] as const;

interface EstimateData {
  readonly currency: string;
  readonly lines: CostLine[];
  readonly total: number;
  readonly csv: string;
}

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
  const document = useStore((s) => s.document);
  const [schedule, setSchedule] = useState<(typeof SCHEDULES)[number]>('wall');
  const estimate = useMemo(
    () => execute(document, 'estimate_cost', {}).data as EstimateData,
    [document],
  );
  const priced = estimate.lines.filter((line) => line.amount !== null);

  const downloadTakeoff = (): void => {
    const data = execute(document, 'quantity_takeoff', {}).data as { csv: string };
    downloadText(data.csv, 'quantity-takeoff.csv', 'text/csv');
  };
  const downloadEstimate = (): void => downloadText(estimate.csv, 'cost-estimate.csv', 'text/csv');
  const downloadSchedule = (): void => {
    const data = execute(document, 'building_schedule', { kind: schedule }).data as { csv: string };
    downloadText(data.csv, `${schedule}-schedule.csv`, 'text/csv');
  };

  return (
    <PanelSection title="Quantities & cost" collapsible testId="building-quantities">
      {estimate.lines.length === 0 ? (
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
        <select
          value={schedule}
          onChange={(event) => setSchedule(event.target.value as (typeof SCHEDULES)[number])}
          aria-label="Schedule"
        >
          {SCHEDULES.map((kind) => (
            <option key={kind} value={kind}>
              {kind[0]?.toUpperCase()}
              {kind.slice(1)} schedule
            </option>
          ))}
        </select>
        <button type="button" className="btn btn--ghost btn--sm" onClick={downloadSchedule}>
          Schedule CSV
        </button>
      </div>
    </PanelSection>
  );
}
