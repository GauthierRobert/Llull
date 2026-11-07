// Energy ledger of a run with datasheet motors (simulate_motion data.ledger), read-only: one row per element in joules, then the books.

import React from 'react';
import { formatQuantity } from '@dynamics/index';
import type { LedgerView } from '@ui/panels/motorSummary';

const joules = (value: number): string => `${formatQuantity(value)} J`;

export function PhysicsLedger({ ledger }: { ledger: LedgerView }): React.ReactElement {
  return (
    <table className="physics-results physics-ledger" data-testid="physics-ledger" aria-label="Energy ledger">
      <tbody>
        {ledger.entries.map((entry) => (
          <tr key={`${entry.kind}:${entry.element}`}>
            <th scope="row">{entry.element}</th>
            <td>{entry.kind.replaceAll('_', ' ')}</td>
            <td className="physics-results__meta">{joules(entry.joules)}</td>
          </tr>
        ))}
        <tr>
          <th scope="row">input</th>
          <td>dissipated {joules(ledger.dissipatedJ)}</td>
          <td className="physics-results__meta">{joules(ledger.inputJ)}</td>
        </tr>
        <tr data-testid="physics-ledger-closure" data-closure={ledger.closure}>
          <th scope="row">closure</th>
          <td>
            {ledger.closure} · stored change {joules(ledger.storedChangeJ)}
          </td>
          <td className="physics-results__meta">
            {joules(ledger.closureErrorJ)} ({formatQuantity(ledger.closureRelative * 100)} %)
          </td>
        </tr>
      </tbody>
    </table>
  );
}
