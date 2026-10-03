/**
 * @layer ui/panels
 *
 * AssemblyPanel — component library + instance tree.
 *
 * Section A — Components: lists all entries in `doc.components` with their
 *   name, entity count, and an "Insert" button that dispatches `insert_instance`
 *   at the world origin with a fresh id.
 *
 * Section B — Instances: lists all entities with `kind === 'instance'`, showing
 *   the component name, position, and selection state. Clicking a row selects
 *   the instance. Each row has an "Explode" button that dispatches `explode_instance`.
 *
 * Pure presentation — never mutates the document directly (PRIME DIRECTIVE).
 * All document changes are routed through `store.dispatch(name, params)`.
 *
 * @see create_component, insert_instance, explode_instance
 */

import React from 'react';
import { useStore } from '@ui/store';
import type { Component, InstanceEntity } from '@core/model/types';
import { Icon } from '@ui/components/Icon';
import { PanelEmpty, PanelHeader, PanelSection } from '@ui/panels/PanelParts';

interface ComponentRowProps {
  component: Component;
}

function ComponentRow({ component }: ComponentRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  const entityCount = component.order.length;

  return (
    <li
      className="panel__row assembly-component-row"
      data-testid={`assembly-component-${component.id}`}
      aria-label={`Component: ${component.name}`}
    >
      <span className="panel__row-icon" aria-hidden="true">
        <Icon name="cube" size={14} />
      </span>
      <span className="panel__row-main" title={component.name}>
        {component.name}
      </span>
      <span
        className="panel__row-meta"
        title={`${entityCount} ${entityCount === 1 ? 'entity' : 'entities'}`}
        aria-label={`${entityCount} entities`}
      >
        {entityCount}
      </span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => dispatch('insert_instance', { componentId: component.id })}
        aria-label={`Insert instance of ${component.name}`}
        title="Insert instance at origin"
      >
        <Icon name="plus" size={12} />
        Insert
      </button>
    </li>
  );
}

interface InstanceRowProps {
  instance: InstanceEntity;
  componentName: string;
  selected: boolean;
}

function InstanceRow({ instance, componentName, selected }: InstanceRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const select = useStore((s) => s.select);

  const [px, py, pz] = instance.position;
  const posLabel = `[${px.toFixed(1)}, ${py.toFixed(1)}, ${pz.toFixed(1)}]`;

  const handleExplode = (e: React.MouseEvent): void => {
    e.stopPropagation();
    dispatch('explode_instance', { id: instance.id });
  };

  return (
    <li
      className={`panel__row assembly-instance-row${selected ? ' panel__row--selected assembly-instance-row--selected' : ''}`}
      data-testid={`assembly-instance-${instance.id}`}
      aria-label={`Instance of ${componentName}`}
      aria-selected={selected}
      onClick={() => select([instance.id])}
      role="option"
    >
      <span className="panel__row-icon" aria-hidden="true">
        <Icon name="assembly" size={14} />
      </span>
      <span className="assembly-instance-info">
        <span className="assembly-instance-name" title={componentName}>
          {componentName}
        </span>
        <span className="assembly-instance-pos" title={`Position: ${posLabel}`}>
          {posLabel}
        </span>
      </span>
      <button
        type="button"
        className="btn btn--ghost btn--sm btn--danger"
        onClick={handleExplode}
        aria-label={`Explode instance ${instance.id}`}
        title="Explode instance into individual entities"
      >
        <Icon name="explode" size={12} />
        Explode
      </button>
    </li>
  );
}

interface AssemblyPanelProps {
  className?: string;
}

export function AssemblyPanel({ className }: AssemblyPanelProps): React.ReactElement {
  const components = useStore((s) => s.document.components);
  const entities = useStore((s) => s.document.entities);
  const order = useStore((s) => s.document.order);
  const selection = useStore((s) => s.document.selection);

  const componentList = Object.values(components).filter(Boolean) as Component[];

  const instanceList = order
    .map((id) => entities[id])
    .filter((e): e is InstanceEntity => e !== undefined && e.kind === 'instance');

  const selectionSet = new Set(selection);

  return (
    <aside
      className={['panel assembly-panel', className].filter(Boolean).join(' ')}
      aria-label="Assembly"
    >
      <PanelHeader title="Assembly" />
      <PanelSection
        title="Components"
        count={componentList.length}
        countLabel={`${componentList.length} components`}
      >
        {componentList.length === 0 ? (
          <PanelEmpty compact icon="assembly" message="No components defined." />
        ) : (
          <ul className="panel__list" aria-label="Component list" role="list">
            {componentList.map((comp) => (
              <ComponentRow key={comp.id} component={comp} />
            ))}
          </ul>
        )}
      </PanelSection>

      <PanelSection
        title="Instances"
        count={instanceList.length}
        countLabel={`${instanceList.length} instances`}
      >
        {instanceList.length === 0 ? (
          <PanelEmpty compact icon="assembly" message="No instances in the scene." />
        ) : (
          <ul className="panel__list" aria-label="Instance list" role="listbox">
            {instanceList.map((inst) => {
              const comp = components[inst.componentId];
              const compName = comp ? comp.name : inst.componentId;
              return (
                <InstanceRow
                  key={inst.id}
                  instance={inst}
                  componentName={compName}
                  selected={selectionSet.has(inst.id)}
                />
              );
            })}
          </ul>
        )}
      </PanelSection>
    </aside>
  );
}
