// Component library (Insert → insert_instance at the origin) + instance tree (click selects, Explode → explode_instance).

import React from 'react';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import { useSelectionSet } from '@ui/store/selectionHooks';
import type { Component, InstanceEntity } from '@core/model/types';
import { Icon } from '@ui/components/Icon';
import { PanelEmpty, PanelHeader, PanelSection } from '@ui/panels/PanelParts';
import { orderedValues } from '@ui/panels/orderedValues';

function ComponentRow({ component }: { component: Component }): React.ReactElement {
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

function InstanceRow({
  instance,
  componentName,
  selected,
}: {
  instance: InstanceEntity;
  componentName: string;
  selected: boolean;
}): React.ReactElement {
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
      onClick={() => select([instance.id])}
    >
      <span className="panel__row-icon" aria-hidden="true">
        <Icon name="assembly" size={14} />
      </span>
      <button type="button" className="assembly-instance-info" aria-pressed={selected} aria-label={`Select instance of ${componentName}`}>
        <span className="assembly-instance-name" title={componentName}>
          {componentName}
        </span>
        <span className="assembly-instance-pos" title={`Position: ${posLabel}`}>
          {posLabel}
        </span>
      </button>
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

export function AssemblyPanel({ className }: { className?: string }): React.ReactElement {
  const components = useStore((s) => s.document.components);
  const entities = useStore((s) => s.document.entities);
  const order = useStore((s) => s.document.order);

  const componentList = Object.values(components);

  const instanceList = orderedValues(order, entities).filter((entity): entity is InstanceEntity => entity.kind === 'instance');

  const selectionSet = useSelectionSet();

  return (
    <aside className={classNames('panel assembly-panel', className)} aria-label="Assembly">
      <PanelHeader title="Assembly" />
      <PanelSection title="Components" count={componentList.length} countLabel={`${componentList.length} components`}>
        {componentList.length === 0 ? (
          <PanelEmpty
            compact
            icon="assembly"
            message="No components defined."
            action={{ label: 'New component', command: 'create_component' }}
          />
        ) : (
          <ul className="panel__list" aria-label="Component list" role="list">
            {componentList.map((comp) => (
              <ComponentRow key={comp.id} component={comp} />
            ))}
          </ul>
        )}
      </PanelSection>

      <PanelSection title="Instances" count={instanceList.length} countLabel={`${instanceList.length} instances`}>
        {instanceList.length === 0 ? (
          <PanelEmpty compact icon="assembly" message="No instances in the scene." />
        ) : (
          <ul className="panel__list" aria-label="Instance list">
            {instanceList.map((inst) => {
              const comp = components[inst.componentId];
              const compName = comp ? comp.name : inst.componentId;
              return <InstanceRow key={inst.id} instance={inst} componentName={compName} selected={selectionSet.has(inst.id)} />;
            })}
          </ul>
        )}
      </PanelSection>
    </aside>
  );
}
