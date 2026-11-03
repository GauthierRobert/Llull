// Data sheet of a parametric equipment in the properties panel: review badge (reviewRequired), code results, nozzle schedule, and the
// switch for the 3D port glyphs. Read-only: it runs the query `equipment_datasheet`; nothing here edits the document.

import React, { useMemo } from 'react';
import { useStore } from '@ui/store';
import { usePortGlyphStore } from '@ui/store/portGlyphStore';
import { runQuery } from '@ui/services/localQuery';
import { PanelSection } from '@ui/panels/PanelParts';
import { PropRow } from '@ui/panels/propertyFields';
import { classNames } from '@ui/classNames';
import { parseDatasheet } from './datasheetView';

const STATUS_CHIP: Record<string, string> = { pass: 'chip--success', warn: 'chip--warning', fail: 'chip--danger' };

/** Renders nothing for equipment without a template (legacy footprint, block): the query refuses it. */
export function EquipmentDatasheetSection({ equipmentId }: { equipmentId: string }): React.ReactElement | null {
  const entities = useStore((s) => s.document.entities);
  const building = useStore((s) => s.document.building);
  const units = useStore((s) => s.document.units);
  const portsShown = usePortGlyphStore((s) => s.shown);
  const setPortsShown = usePortGlyphStore((s) => s.setShown);
  const view = useMemo(
    () => parseDatasheet(runQuery('equipment_datasheet', { equipment: equipmentId, format: 'json' }).data),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the query reads the store document; these slices stand for it
    [equipmentId, entities, building, units],
  );
  if (view === null) return null;
  return (
    <PanelSection title="Data sheet">
      <div className="datasheet" data-testid="equipment-datasheet">
        <div className="datasheet__badges">
          <span
            className={classNames('chip', view.reviewRequired ? 'chip--warning' : 'chip--success')}
            data-testid="datasheet-review-badge"
            title={view.reasons.join('\n')}
          >
            {view.reviewRequired ? 'reviewRequired' : 'reviewed'}
          </span>
          <span className="chip">{view.status.replace(/_/g, ' ')}</span>
          {view.unverified && <span className="chip chip--warning">unverified inputs</span>}
        </div>
        {view.reasons.map((reason) => (
          <p key={reason} className="datasheet__note">
            {reason}
          </p>
        ))}
        {view.checkStatus !== null && (
          <PropRow label="Check">
            <span className={classNames('chip', STATUS_CHIP[view.checkStatus])} data-testid="datasheet-check-status">
              {view.checkStatus}
            </span>
          </PropRow>
        )}
        {view.mawpMPa !== null && (
          <PropRow label="MAWP">
            <span className="props-number">{view.mawpMPa.toFixed(3)} MPa</span>
          </PropRow>
        )}
        {view.issues.map((issue) => (
          <p key={`${issue.code}:${issue.message}`} className="datasheet__note" data-testid="datasheet-issue">
            <strong>{issue.code}</strong> {issue.message}
          </p>
        ))}
        {view.unavailable.map((message) => (
          <p key={message} className="datasheet__note">
            {message}
          </p>
        ))}
        {view.nozzles.length > 0 && (
          <table className="datasheet__nozzles" aria-label="Nozzle schedule">
            <thead>
              <tr>
                <th>Mark</th>
                <th>Service</th>
                <th>DN</th>
                <th>Rating</th>
              </tr>
            </thead>
            <tbody>
              {view.nozzles.map((nozzle) => (
                <tr key={nozzle.mark}>
                  <td>{nozzle.mark}</td>
                  <td>{nozzle.service ?? ''}</td>
                  <td>{nozzle.dn ?? ''}</td>
                  <td>{nozzle.rating ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <label className="datasheet__toggle">
          <input type="checkbox" checked={portsShown} onChange={(event) => setPortsShown(event.target.checked)} data-testid="ports-shown" />
          Show nozzle port glyphs
        </label>
      </div>
    </PanelSection>
  );
}
