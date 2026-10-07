/**
 * @layer ui/panels/building
 * Properties inspector for a selected building element (derived geometry is read-only, so the
 * element — not its mesh — is what an engineer edits). Editors dispatch update_* commands.
 */

import React from 'react';
import { useStore } from '@ui/store';
import { deleteSelection } from '@ui/actions/selectionActions';
import type { BuildingElement, BuildingModel, SteelMemberElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { toMetres, toMm } from '@aec/model';
import { findProfile } from '@aec/steel/profiles';
import { Icon } from '@ui/components/Icon';
import { PanelSection } from '@ui/panels/PanelParts';
import { PropRow } from '@ui/panels/propertyFields';
import { orderedValues } from '@ui/panels/orderedValues';
import { CATEGORY_LABEL, describe } from './describeElement';
import { EquipmentEditor } from './EquipmentEditor';
import { SteelMemberEditor } from './SteelMemberEditor';
import { WallEditor } from './WallEditor';

const formatPoint = (point: ReadonlyArray<number>): string =>
  point.map((value) => Number(value.toFixed(1))).join(', ');

function levelNameOf(building: BuildingModel, element: BuildingElement): string | null {
  return 'levelId' in element ? (building.levels[element.levelId]?.name ?? element.levelId) : null;
}

function memberFacts(
  member: SteelMemberElement,
  document: Pick<CadDocument, 'units'>,
): ReadonlyArray<readonly [string, string]> {
  const lengthUnits = Math.hypot(
    member.end[0] - member.start[0],
    member.end[1] - member.start[1],
    member.end[2] - member.start[2],
  );
  const massPerMetre = findProfile(member.profile)?.massPerMetre;
  const mass =
    massPerMetre === undefined
      ? '—'
      : `${Math.round(toMetres(document, lengthUnits) * massPerMetre)} kg`;
  return [
    ['Role', member.role],
    ['Profile', member.profile],
    ['Grade', member.material],
    ['Start', formatPoint(member.start)],
    ['End', formatPoint(member.end)],
    ['Length', `${Math.round(toMm(document, lengthUnits))} mm`],
    ['Mass', mass],
  ];
}

function ElementEditor({
  element,
  building,
}: {
  element: BuildingElement;
  building: BuildingModel;
}): React.ReactElement | null {
  const levels = orderedValues(building.levelOrder, building.levels);
  switch (element.category) {
    case 'member':
      return <SteelMemberEditor key={JSON.stringify(element)} member={element} />;
    case 'equipment':
      return <EquipmentEditor key={JSON.stringify(element)} element={element} levels={levels} />;
    case 'wall':
      return <WallEditor key={JSON.stringify(element)} wall={element} />;
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
  if (building === undefined || element === undefined) {
    return <p className="panel__empty-hint">Building element {elementId} not found.</p>;
  }
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
      <ElementEditor element={element} building={building} />
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
