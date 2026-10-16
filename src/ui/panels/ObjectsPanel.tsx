// Model tree: groups (expandable, with their members) then ungrouped entities. Click selects (Ctrl/Shift toggles), the
// eye is a LOCAL viewport filter (hiddenEntityIds), double-click renames → set_entity_name.

import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { classNames } from '@ui/classNames';
import { useStore, useViewportStore } from '@ui/store';
import { useSelectionSet } from '@ui/store/selectionHooks';
import { type Entity, type EntityGroup, type EntityKind, is2D } from '@core/model/types';
import { type IconName, Icon } from '@ui/components/Icon';
import { IconButton, PanelEmpty, PanelHeader, PanelSection } from '@ui/panels/PanelParts';
import { CommitInput } from '@ui/panels/propertyFields';
import { capitalize } from '@ui/panels/capitalize';
import { orderedValues } from '@ui/panels/orderedValues';

const KIND_ICONS: Readonly<Partial<Record<EntityKind, IconName>>> = {
  box: 'cube',
  cylinder: 'solidCylinder',
  sphere: 'solidSphere',
  cone: 'solidCone',
  torus: 'solidTorus',
  wedge: 'solidWedge',
  pyramid: 'solidPyramid',
  instance: 'assembly',
  line: 'drawLine',
  polyline: 'drawPolyline',
  arc: 'drawCircle',
  circle: 'drawCircle',
  rectangle: 'drawRectangle',
  ellipse: 'drawEllipse',
  spline: 'drawSpline',
  point: 'drawPoint',
  image: 'image',
};

function entityIcon(entity: Entity): IconName {
  return KIND_ICONS[entity.kind] ?? (is2D(entity) ? 'drawPolyline' : 'cube');
}

function entityLabel(entity: Entity): string {
  return entity.name !== undefined && entity.name !== '' ? entity.name : `${capitalize(entity.kind)} ${entity.id}`;
}

function matchesFilter(entity: Entity, filter: string): boolean {
  if (filter === '') return true;
  return [entity.name ?? '', entity.kind, entity.id, ...(entity.tags ?? [])].some((text) => text.toLowerCase().includes(filter));
}

/** Plain click replaces the selection; Ctrl/Cmd/Shift adds or removes. */
function useRowSelect(): (event: React.MouseEvent, ids: readonly string[]) => void {
  const select = useStore((s) => s.select);
  const toggleSelection = useStore((s) => s.toggleSelection);
  return (event, ids) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) ids.forEach(toggleSelection);
    else select([...ids]);
  };
}

const EntityRow = memo(function EntityRow({ entity, selected, nested }: { entity: Entity; selected: boolean; nested: boolean }) {
  const dispatch = useStore((s) => s.dispatch);
  const onSelect = useRowSelect();
  const hidden = useViewportStore((s) => s.hiddenEntityIds.has(entity.id));
  const toggleEntityVisibility = useViewportStore((s) => s.toggleEntityVisibility);
  const [renaming, setRenaming] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const label = entityLabel(entity);

  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  return (
    <li
      ref={rowRef}
      className={classNames(
        'panel__row object-row',
        nested && 'object-row--nested',
        selected && 'panel__row--selected',
        hidden && 'object-row--hidden',
      )}
      data-testid={`object-row-${entity.id}`}
    >
      <span className="object-swatch" style={{ background: entity.color }} aria-hidden="true" />
      {renaming ? (
        <CommitInput
          className="object-name-input"
          label={`Rename ${label}`}
          value={entity.name ?? ''}
          autoFocus
          onCommit={(name) => dispatch('set_entity_name', { id: entity.id, name: name.trim() })}
          onFinish={() => setRenaming(false)}
        />
      ) : (
        <button
          type="button"
          className="object-row__main"
          aria-pressed={selected}
          aria-label={`Select ${label}`}
          title={`${label} — ${entity.kind} (${entity.id}). Double-click to rename.`}
          onClick={(event) => onSelect(event, [entity.id])}
          onDoubleClick={() => setRenaming(true)}
        >
          <Icon name={entityIcon(entity)} size={14} />
          <span className="object-row__name">{label}</span>
          <span className="panel__row-meta">{entity.kind}</span>
        </button>
      )}
      <IconButton
        icon={hidden ? 'eyeOff' : 'eye'}
        size={13}
        className={classNames('object-visibility-btn', hidden && 'object-visibility-btn--hidden')}
        pressed={!hidden}
        label={hidden ? `Show ${label} in viewport` : `Hide ${label} in viewport`}
        title={hidden ? 'Show in viewport (local)' : 'Hide in viewport (local)'}
        onClick={() => toggleEntityVisibility(entity.id)}
      />
    </li>
  );
});

function GroupNode({
  group,
  members,
  selection,
}: {
  group: EntityGroup;
  members: Entity[];
  selection: ReadonlySet<string>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const onSelect = useRowSelect();
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);
  const toggleEntityVisibility = useViewportStore((s) => s.toggleEntityVisibility);
  const memberIds = members.map((member) => member.id);
  const allHidden = memberIds.length > 0 && memberIds.every((id) => hiddenEntityIds.has(id));
  const allSelected = memberIds.length > 0 && memberIds.every((id) => selection.has(id));

  return (
    <>
      <li
        className={classNames(
          'panel__row object-row object-group-row',
          allSelected && 'panel__row--selected',
          allHidden && 'object-row--hidden',
        )}
        data-testid={`object-group-${group.id}`}
      >
        <IconButton
          icon={open ? 'chevronDown' : 'chevronRight'}
          size={12}
          pressed={open}
          label={open ? `Collapse group ${group.name}` : `Expand group ${group.name}`}
          onClick={() => setOpen((value) => !value)}
        />
        <button
          type="button"
          className="object-row__main"
          aria-label={`Select group ${group.name}`}
          title={`Group ${group.name} — select its ${memberIds.length} members`}
          onClick={(event) => onSelect(event, memberIds)}
        >
          <Icon name="layers" size={14} />
          <span className="object-row__name">{group.name}</span>
          <span className="panel__row-meta">{memberIds.length}</span>
        </button>
        <IconButton
          icon={allHidden ? 'eyeOff' : 'eye'}
          size={13}
          className={classNames('object-visibility-btn', allHidden && 'object-visibility-btn--hidden')}
          pressed={!allHidden}
          label={allHidden ? `Show group ${group.name}` : `Hide group ${group.name}`}
          onClick={() => memberIds.filter((id) => hiddenEntityIds.has(id) === !allHidden).forEach(toggleEntityVisibility)}
        />
      </li>
      {open && members.map((member) => <EntityRow key={member.id} entity={member} selected={selection.has(member.id)} nested />)}
    </>
  );
}

export function ObjectsPanel({ className }: { className?: string }): React.ReactElement {
  const entities = useStore((s) => s.document.entities);
  const order = useStore((s) => s.document.order);
  const groups = useStore((s) => s.document.groups);
  const hiddenCount = useViewportStore((s) => s.hiddenEntityIds.size);
  const showAllEntities = useViewportStore((s) => s.showAllEntities);
  const selection = useSelectionSet();
  const [filterText, setFilterText] = useState('');
  const filter = filterText.trim().toLowerCase();

  const tree = useMemo(() => {
    const all = orderedValues(order, entities);
    const grouped = new Set<string>();
    const groupNodes = Object.values(groups).map((group) => {
      group.memberIds.forEach((id) => grouped.add(id));
      const members = group.memberIds.flatMap((id) => {
        const member = entities[id];
        return member === undefined ? [] : [member];
      });
      const groupMatches = filter === '' || group.name.toLowerCase().includes(filter);
      return { group, members: groupMatches ? members : members.filter((member) => matchesFilter(member, filter)) };
    });
    return {
      total: all.length,
      groupNodes: groupNodes.filter((node) => node.members.length > 0),
      ungrouped: all.filter((entity) => !grouped.has(entity.id) && matchesFilter(entity, filter)),
    };
  }, [order, entities, groups, filter]);

  return (
    <aside className={classNames('panel objects-panel', className)} aria-label="Objects">
      <PanelHeader title="Objects" count={tree.total} countLabel={`${tree.total} objects`}>
        {hiddenCount > 0 && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={showAllEntities} title="Show every hidden object">
            <Icon name="eye" size={12} />
            Show all ({hiddenCount})
          </button>
        )}
      </PanelHeader>

      {tree.total === 0 ? (
        <PanelEmpty icon="cube" message="No objects yet." hint="Draw or add a solid — every object in the model is listed here." />
      ) : (
        <>
          <div className="objects-filter">
            <Icon name="search" size={13} />
            <input
              type="search"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder="Filter by name, kind, tag…"
              aria-label="Filter objects"
              autoComplete="off"
            />
          </div>
          {tree.groupNodes.length > 0 && (
            <PanelSection title="Groups" count={tree.groupNodes.length} countLabel={`${tree.groupNodes.length} groups`}>
              <ul className="panel__list" aria-label="Group list">
                {tree.groupNodes.map(({ group, members }) => (
                  <GroupNode key={group.id} group={group} members={members} selection={selection} />
                ))}
              </ul>
            </PanelSection>
          )}
          <PanelSection
            title={tree.groupNodes.length > 0 ? 'Ungrouped' : 'All objects'}
            count={tree.ungrouped.length}
            countLabel={`${tree.ungrouped.length} objects`}
          >
            {tree.ungrouped.length === 0 ? (
              <PanelEmpty compact icon="search" message="No matching objects." />
            ) : (
              <ul className="panel__list" aria-label="Object list">
                {tree.ungrouped.map((entity) => (
                  <EntityRow key={entity.id} entity={entity} selected={selection.has(entity.id)} nested={false} />
                ))}
              </ul>
            )}
          </PanelSection>
        </>
      )}
    </aside>
  );
}
