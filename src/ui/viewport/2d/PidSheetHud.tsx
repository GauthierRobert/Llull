// HTML HUD of the P&ID 2D view (outside the Canvas, top-right): the sheet picker (two sheets or more) and the read-only inspector of
// the picked item. UI-only state (`pidViewStore`); nothing here edits the document.

import React from 'react';
import { Icon } from '@ui/components/Icon';
import { useStore } from '@ui/store';
import { usePidViewStore } from '@ui/store/pidViewStore';
import { pidItemRows } from './pidItemRows';
import { activePidSheet } from './pidSheetItems';

export function PidSheetHud(): React.ReactElement | null {
  const pid = useStore((s) => s.document.plant?.pid);
  const activeSheetId = usePidViewStore((s) => s.activeSheetId);
  const picked = usePidViewStore((s) => s.picked);
  const setActiveSheet = usePidViewStore((s) => s.setActiveSheet);
  const setPicked = usePidViewStore((s) => s.setPicked);
  const sheet = activePidSheet(pid, activeSheetId);
  if (pid === undefined || sheet === undefined) return null;
  const item = picked === null ? undefined : pid.items[picked.id];
  return (
    <div className="pid-hud">
      {pid.sheetOrder.length > 1 && (
        <label className="pid-hud__picker">
          <span className="pid-hud__caption">Sheet</span>
          <select aria-label="P&ID sheet" value={sheet.id} onChange={(e) => setActiveSheet(e.target.value)}>
            {pid.sheetOrder.map((id) => (
              <option key={id} value={id}>
                {pid.sheets[id]?.number ?? id}
                {pid.sheets[id]?.title ? ` - ${pid.sheets[id]?.title}` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {item !== undefined && (
        <section className="pid-hud__inspector" aria-label="P&ID item">
          <header>
            <span className="pid-hud__kind">{item.kind}</span>
            <strong className="pid-hud__tag">{item.tag ?? item.id}</strong>
            <button type="button" aria-label="Clear P&ID selection" onClick={() => setPicked(null)}>
              <Icon name="close" size={12} />
            </button>
          </header>
          <dl>
            {pidItemRows(item).map((row) => (
              <React.Fragment key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </React.Fragment>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
