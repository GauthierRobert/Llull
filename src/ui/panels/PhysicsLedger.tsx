// Energy ledger of a run with datasheet motors (simulate_motion data.ledger), read-only: one row per element in joules, then the books
// (every row is element / kind / joules).

import React from 'react';
import { formatQuantity } from '@dynamics/index';
import type { LedgerView } from '@ui/panels/motorSummary';

const joules = (value: number): string => `${formatQuantity(value)} J`;

function Row({ element, kind, value }: { element: string; kind: string; value: string }): React.ReactElement {
  return (
    <tr>
      <th scope="row">{element}</th>
      <td>{kind}</td>
      <td className="physics-results__meta">{value}</td>
    </tr>
  );
}

export function PhysicsLedger({ ledger }: { ledger: LedgerView }): React.ReactElement {
  return (
    <table className="physics-results physics-ledger" data-testid="physics-ledger" aria-label="Energy ledger">
      <thead>
        <tr>
          <th scope="col">element</th>
          <th scope="col">kind</th>
          <th scope="col" className="physics-results__meta">
            J
          </th>
        </tr>
      </thead>
      <tbody>
        {ledger.entries.map((entry, index) => (
          <Row key={index} element={entry.element} kind={entry.kind.replaceAll('_', ' ')} value={joules(entry.joules)} />
        ))}
      </tbody>
      <tfoot>
        <Row element="books" kind="input" value={joules(ledger.inputJ)} />
        <Row element="books" kind="dissipated" value={joules(ledger.dissipatedJ)} />
        <Row element="books" kind="stored change" value={joules(ledger.storedChangeJ)} />
        <tr data-testid="physics-ledger-closure" data-closure={ledger.closure}>
          <th scope="row">books</th>
          <td>closure {ledger.closure}</td>
          <td className="physics-results__meta">
            {joules(ledger.closureErrorJ)} ({formatQuantity(ledger.closureRelative * 100)} %)
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
