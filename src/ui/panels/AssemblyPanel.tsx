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

import React, { useCallback } from 'react';
import { useStore } from '@ui/store';
import type { Component, InstanceEntity } from '@core/model/types';

// ---------------------------------------------------------------------------
// Section A: Component row
// ---------------------------------------------------------------------------

interface ComponentRowProps {
  component: Component;
}

function ComponentRow({ component }: ComponentRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  const handleInsert = useCallback(() => {
    dispatch('insert_instance', { componentId: component.id });
  }, [dispatch, component.id]);

  const entityCount = component.order.length;

  return (
    <li
      className="assembly-component-row"
      data-testid={`assembly-component-${component.id}`}
      aria-label={`Component: ${component.name}`}
    >
      <span className="assembly-component-icon" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M4 6h4M6 4v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="assembly-component-name" title={component.name}>
        {component.name}
      </span>
      <span
        className="assembly-component-count"
        title={`${entityCount} ${entityCount === 1 ? 'entity' : 'entities'}`}
        aria-label={`${entityCount} entities`}
      >
        {entityCount}
      </span>
      <button
        type="button"
        className="assembly-insert-btn"
        onClick={handleInsert}
        aria-label={`Insert instance of ${component.name}`}
        title="Insert instance at origin"
      >
        Insert
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Section B: Instance row
// ---------------------------------------------------------------------------

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

  const handleClick = useCallback(() => {
    select([instance.id]);
  }, [select, instance.id]);

  const handleExplode = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      dispatch('explode_instance', { id: instance.id });
    },
    [dispatch, instance.id],
  );

  return (
    <li
      className={`assembly-instance-row${selected ? ' assembly-instance-row--selected' : ''}`}
      data-testid={`assembly-instance-${instance.id}`}
      aria-label={`Instance of ${componentName}`}
      aria-selected={selected}
      onClick={handleClick}
      role="option"
    >
      <span className="assembly-instance-icon" aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="5.5" cy="5.5" r="1.5" fill="currentColor" />
        </svg>
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
        className="assembly-explode-btn"
        onClick={handleExplode}
        aria-label={`Explode instance ${instance.id}`}
        title="Explode instance into individual entities"
      >
        Explode
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// AssemblyPanel — the exported panel
// ---------------------------------------------------------------------------

export interface AssemblyPanelProps {
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
      className={['assembly-panel', className].filter(Boolean).join(' ')}
      aria-label="Assembly"
    >
      {/* ---- Section A: Component Library ---- */}
      <div className="assembly-panel-section">
        <div className="assembly-panel-header">
          <h2 className="assembly-panel-title">Components</h2>
          <span
            className="assembly-panel-count"
            aria-label={`${componentList.length} components`}
          >
            {componentList.length}
          </span>
        </div>

        {componentList.length === 0 ? (
          <p className="assembly-empty-hint">No components defined.</p>
        ) : (
          <ul
            className="assembly-component-list"
            aria-label="Component list"
            role="list"
          >
            {componentList.map((comp) => (
              <ComponentRow key={comp.id} component={comp} />
            ))}
          </ul>
        )}
      </div>

      {/* ---- Section B: Instances ---- */}
      <div className="assembly-panel-section">
        <div className="assembly-panel-header">
          <h2 className="assembly-panel-title">Instances</h2>
          <span
            className="assembly-panel-count"
            aria-label={`${instanceList.length} instances`}
          >
            {instanceList.length}
          </span>
        </div>

        {instanceList.length === 0 ? (
          <p className="assembly-empty-hint">No instances in the scene.</p>
        ) : (
          <ul
            className="assembly-instance-list"
            aria-label="Instance list"
            role="listbox"
          >
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
      </div>
    </aside>
  );
}
