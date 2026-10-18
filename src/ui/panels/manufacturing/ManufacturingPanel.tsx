// Manufacturing tab (aerospace 07 §7.3): flat pattern, findings, feature (hole) table and the hole form for one sheet-metal or machined part.
// Everything shown is a read-only query result or a dispatched command; the panel computes nothing.

import React, { useState } from 'react';
import { is3D } from '@core/model/types';
import { classNames } from '@ui/classNames';
import { PanelEmpty, PanelHeader } from '@ui/panels/PanelParts';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { useStore } from '@ui/store';
import { FeatureTableSection } from './FeatureTableSection';
import { FlatPatternSection } from './FlatPatternSection';
import { FtrFindingsSection } from './FtrFindingsSection';
import { HoleForm } from './HoleForm';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { partFocus } from './mfgFocus';

export function ManufacturingPanel({ className }: { className?: string }): React.ReactElement {
  const sheetParts = useStore((s) => s.document.sheetMetal?.parts);
  const entities = useStore((s) => s.document.entities);
  const order = useStore((s) => s.document.order);
  const document = useStore((s) => s.document);
  const focusItem = useFocusItem();
  const [chosen, setChosen] = useState('');
  const sheetIds = Object.keys(sheetParts ?? {});
  const machinedIds = order.filter((id) => {
    const entity = entities[id];
    return entity !== undefined && is3D(entity) && !sheetIds.includes(id);
  });
  const options = [...sheetIds, ...machinedIds].map((id): readonly [string, string] => [
    id,
    sheetIds.includes(id) ? `${id} (sheet metal)` : id,
  ]);
  const partId = options.some(([id]) => id === chosen) ? chosen : (options[0]?.[0] ?? '');
  const isSheet = sheetIds.includes(partId);

  return (
    <aside className={classNames('panel mfg-panel', className)} aria-label="Manufacturing">
      <PanelHeader title="Manufacturing" count={options.length} countLabel={`${options.length} parts`} />
      {partId === '' ? (
        <PanelEmpty icon="cube" message="No part to check." hint="Add a solid or a sheet-metal base, then check it here." compact />
      ) : (
        <>
          <div className="mfg__part">
            <LabeledSelect label="Part" value={partId} options={options} onChange={setChosen} testId="mfg-part" />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              title="Highlight this part on the model"
              data-testid="mfg-part-show"
              onClick={() => focusItem(partFocus(document, partId, `part:${partId}`, partId))}
            >
              Show
            </button>
          </div>
          {isSheet && <FlatPatternSection key={`flat-${partId}`} partId={partId} />}
          <FtrFindingsSection key={`check-${partId}`} partId={partId} command={isSheet ? 'check_sheet_metal' : 'check_machining'} />
          <FeatureTableSection key={`features-${partId}`} partId={partId} />
          {!isSheet && <HoleForm key={`hole-${partId}`} partId={partId} />}
        </>
      )}
    </aside>
  );
}
