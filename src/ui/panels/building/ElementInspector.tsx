/**
 * @layer ui/panels/building
 * Properties inspector for a selected building element (derived geometry is read-only, so the
 * element — not its mesh — is what an engineer edits). Editors dispatch update_* commands.
 */

import React from 'react';
import { useStore } from '@ui/store';
import { deleteSelection } from '@ui/actions/selectionActions';
import type { BuildingElement, BuildingModel } from '@core/model/building';
import { Icon } from '@ui/components/Icon';
import { PanelSection } from '@ui/panels/PanelParts';
import { PropRow } from '@ui/panels/propertyFields';
import { CATEGORY_LABEL, describe } from './describeElement';
import { memberFacts } from './memberFacts';
import { EquipmentEditor } from './EquipmentEditor';
import { SteelMemberEditor } from './SteelMemberEditor';
import { WallEditor } from './WallEditor';
import { useBuildingLevels } from './useBuildingLevels';
import { contentKey } from '@ui/contentKey';

function levelNameOf(building: BuildingModel, element: BuildingElement): string | null {
  return 'levelId' in element ? (building.levels[element.levelId]?.name ?? element.levelId) : null;
}

function ElementEditor({ element }: { element: BuildingElement }): React.ReactElement | null {
  const levels = useBuildingLevels();
  switch (element.category) {
    case 'member':
      return <SteelMemberEditor key={contentKey(element)} member={element} />;
    case 'equipment':
      return <EquipmentEditor key={contentKey(element)} element={element} levels={levels} />;
    case 'wall':
      return <WallEditor key={contentKey(element)} wall={element} />;
    default:
      return null;
  }
}

interface ElementInspectorProps {
  elementId: string;
}

export function ElementInspector({ elementId }: ElementInspectorProps): React.ReactElement {
  const building = useStore((s) => s.document.building);
  const units = useStore((s) => s.document.units);
  const element = building?.elements[elementId];
  if (building === undefined || element === undefined)
    return <p className="panel__empty-hint">Building element {elementId} not found.</p>;
  const label = CATEGORY_LABEL[element.category];
  const level = levelNameOf(building, element);
  const facts: ReadonlyArray<readonly [string, string]> =
    element.category === 'member'
      ? memberFacts(element, { units })
      : [['Summary', describe(element, units)]];
  return (
    <section className="props-detail" aria-label="Building element">
      <div className="props-summary">
        <span className="props-summary__icon" aria-hidden="true">
          <Icon name="cube" size={18} />
        </span>
        <div className="props-summary__text">
          <span className="props-summary__name">
            {label} {element.mark}
          </span>
          <div className="props-summary__meta">
            <span className="chip chip--accent">{describe(element, units)}</span>
            <span className="props-id">{element.id}</span>
          </div>
        </div>
      </div>
      <PanelSection title="Element">
        {facts.map(([key, value]) => (
          <PropRow key={key} label={key}>
            <span className="props-number">{value}</span>
          </PropRow>
        ))}
        {level !== null && (
          <PropRow label="Level">
            <span className="props-number">{level}</span>
          </PropRow>
        )}
      </PanelSection>
      <ElementEditor element={element} />
      <div className="props-actions">
        <button
          type="button"
          className="props-action props-action--danger"
          onClick={deleteSelection}
        >
          <Icon name="trash" size={14} />
          Delete
        </button>
      </div>
    </section>
  );
}
