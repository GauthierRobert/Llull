// Model tree: groups (expandable, with their members) then ungrouped entities. Click selects (Ctrl/Shift toggles), the
// eye is a LOCAL viewport filter (hiddenEntityIds), double-click renames → set_entity_name.

import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { classNames } from '@ui/classNames';
import { useStore, useViewportStore } from '@ui/store';
import { useSelectionSet } from '@ui/store/selectionHooks';
import { type Entity, type EntityGroup, type EntityKind, type Layer, is2D } from '@core/model/types';
import { type IconName, Icon } from '@ui/components/Icon';
import { IconButton, PanelEmpty, PanelHeader, PanelSection } from '@ui/panels/PanelParts';
import { CommitInput } from '@ui/panels/propertyFields';
import { useFocusStore } from '@ui/store/focusStore';
import { useDropFocusOnSelectionChange } from '@ui/hooks/useDropFocusOnSelectionChange';
import { entitiesFocus } from '@ui/panels/entityFocus';
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
  text: 'text',
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

/** Plain click replaces the selection and highlights it on the model (banner + beacon with the size); Ctrl/Cmd/Shift adds or removes. */
function useRowSelect(): (event: React.MouseEvent, ids: readonly string[], label: string) => void {
  const select = useStore((s) => s.select);
  const toggleSelection = useStore((s) => s.toggleSelection);
  return (event, ids, label) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      ids.forEach(toggleSelection);
      return;
    }
    select([...ids]);
    useFocusStore.getState().setFocus(entitiesFocus(useStore.getState().document, { key: 'objects:selection', label, ids }));
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
          onClick={(event) => onSelect(event, [entity.id], label)}
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

interface MemberRowLabels {
  expand: string;
  collapse: string;
  selectAria: string;
  selectTitle: (count: number) => string;
  banner: (count: number) => string;
  show: string;
  hide: string;
}

/** Expandable header row (group or layer collection): select all members, toggle their viewport visibility, list members when open. */
function CollapsibleMemberRow({
  testId,
  name,
  lead,
  members,
  selection,
  open,
  onToggle,
  labels,
}: {
  testId: string;
  name: string;
  lead: React.ReactNode;
  members: readonly Entity[];
  selection: ReadonlySet<string>;
  open: boolean;
  onToggle: () => void;
  labels: MemberRowLabels;
}): React.ReactElement {
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
        data-testid={testId}
      >
        <IconButton
          icon={open ? 'chevronDown' : 'chevronRight'}
          size={12}
          pressed={open}
          label={open ? labels.collapse : labels.expand}
          onClick={onToggle}
        />
        <button
          type="button"
          className="object-row__main"
          aria-label={labels.selectAria}
          title={labels.selectTitle(memberIds.length)}
          onClick={(event) => onSelect(event, memberIds, labels.banner(memberIds.length))}
        >
          {lead}
          <span className="object-row__name">{name}</span>
          <span className="panel__row-meta">{memberIds.length}</span>
        </button>
        <IconButton
          icon={allHidden ? 'eyeOff' : 'eye'}
          size={13}
          className={classNames('object-visibility-btn', allHidden && 'object-visibility-btn--hidden')}
          pressed={!allHidden}
          label={allHidden ? labels.show : labels.hide}
          onClick={() => memberIds.filter((id) => hiddenEntityIds.has(id) === allHidden).forEach(toggleEntityVisibility)}
        />
      </li>
      {open && members.map((member) => <EntityRow key={member.id} entity={member} selected={selection.has(member.id)} nested />)}
    </>
  );
}

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
  const { name } = group;
  return (
    <CollapsibleMemberRow
      testId={`object-group-${group.id}`}
      name={name}
      lead={<Icon name="layers" size={14} />}
      members={members}
      selection={selection}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      labels={{
        expand: `Expand group ${name}`,
        collapse: `Collapse group ${name}`,
        selectAria: `Select group ${name}`,
        selectTitle: (count) => `Group ${name} — select its ${count} members`,
        banner: (count) => `Group ${name} — ${count} members`,
        show: `Show group ${name}`,
        hide: `Hide group ${name}`,
      }}
    />
  );
}

const AUTO_EXPAND_LIMIT = 40;

interface Collection {
  id: string;
  name: string;
  color: string | undefined;
  members: Entity[];
}

interface CollectionOverride {
  open: boolean;
  /** Selection when toggled: a later selection change re-reveals the selected rows. */
  selectionKey: string;
}

/** Layer-based outliner collection; a single layer collapses to "All objects". */
function buildCollections(ungrouped: readonly Entity[], layers: Record<string, Layer>, layerOrder: readonly string[]): Collection[] {
  const byLayer = new Map<string, Entity[]>();
  ungrouped.forEach((entity) => byLayer.set(entity.layerId, [...(byLayer.get(entity.layerId) ?? []), entity]));
  if (byLayer.size <= 1 && Object.keys(layers).length <= 1) {
    return ungrouped.length === 0 ? [] : [{ id: 'all', name: 'All objects', color: undefined, members: [...ungrouped] }];
  }
  const ids = [...layerOrder.filter((id) => byLayer.has(id)), ...[...byLayer.keys()].filter((id) => !layerOrder.includes(id))];
  return ids.map((id) => ({ id, name: layers[id]?.name ?? id, color: layers[id]?.color, members: byLayer.get(id) ?? [] }));
}

function CollectionNode({
  collection,
  open,
  selection,
  onToggle,
}: {
  collection: Collection;
  open: boolean;
  selection: ReadonlySet<string>;
  onToggle: () => void;
}): React.ReactElement {
  const { name } = collection;
  return (
    <CollapsibleMemberRow
      testId={`object-collection-${collection.id}`}
      name={name}
      lead={
        collection.color !== undefined && <span className="object-swatch" style={{ background: collection.color }} aria-hidden="true" />
      }
      members={collection.members}
      selection={selection}
      open={open}
      onToggle={onToggle}
      labels={{
        expand: `Expand ${name}`,
        collapse: `Collapse ${name}`,
        selectAria: `Select all in ${name}`,
        selectTitle: (count) => `${name} — select its ${count} objects`,
        banner: (count) => `${name} — ${count} objects`,
        show: `Show ${name}`,
        hide: `Hide ${name}`,
      }}
    />
  );
}

export function ObjectsPanel({ className }: { className?: string }): React.ReactElement {
  const entities = useStore((s) => s.document.entities);
  const order = useStore((s) => s.document.order);
  const groups = useStore((s) => s.document.groups);
  const layers = useStore((s) => s.document.layers);
  const layerOrder = useStore((s) => s.document.layerOrder);
  const hiddenCount = useViewportStore((s) => s.hiddenEntityIds.size);
  const showAllEntities = useViewportStore((s) => s.showAllEntities);
  const selection = useSelectionSet();
  useDropFocusOnSelectionChange('objects:');
  const [filterText, setFilterText] = useState('');
  const filter = filterText.trim().toLowerCase();
  const [overrides, setOverrides] = useState<Record<string, CollectionOverride>>({});

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
  const collections = useMemo(() => buildCollections(tree.ungrouped, layers, layerOrder), [tree.ungrouped, layers, layerOrder]);
  const selectionKey = [...selection].join(',');

  const isOpen = (collection: Collection): boolean => {
    if (filter !== '') return true;
    const hasSelected = collection.members.some((member) => selection.has(member.id));
    const override = overrides[collection.id];
    if (override !== undefined && (!hasSelected || override.selectionKey === selectionKey)) return override.open;
    return hasSelected || tree.total <= AUTO_EXPAND_LIMIT;
  };

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
        <PanelEmpty
          icon="cube"
          message="No objects yet."
          hint="Draw or add a solid — every object in the model is listed here."
          action={{ label: 'Add a box', command: 'add_box' }}
        />
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
            title={tree.groupNodes.length > 0 ? 'Ungrouped' : 'Collections'}
            count={tree.ungrouped.length}
            countLabel={`${tree.ungrouped.length} objects`}
          >
            {tree.ungrouped.length === 0 ? (
              <PanelEmpty compact icon="search" message="No matching objects." />
            ) : (
              <ul className="panel__list" aria-label="Object list">
                {collections.map((collection) => {
                  const open = isOpen(collection);
                  return (
                    <CollectionNode
                      key={collection.id}
                      collection={collection}
                      open={open}
                      selection={selection}
                      onToggle={() => setOverrides((current) => ({ ...current, [collection.id]: { open: !open, selectionKey } }))}
                    />
                  );
                })}
              </ul>
            )}
          </PanelSection>
        </>
      )}
    </aside>
  );
}
