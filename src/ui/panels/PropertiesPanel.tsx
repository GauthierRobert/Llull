/**
 * @layer ui/panels
 *
 * PropertiesPanel — a left-docked read-only entity inspector.
 *
 * Shows the properties of the currently selected entity (kind, id, position,
 * color, and kind-specific dimensions). For 0 or multiple selections, shows a
 * summary count. Selecting is local view state — click in the viewport.
 *
 * llull is now a LIVE READ-ONLY VIEWER: the Run Command section has been
 * removed. Document mutations come exclusively from MCP agents via the
 * server-side command layer.
 *
 * PRIME DIRECTIVE: this panel NEVER builds an Entity or mutates the document.
 * (architecture L1, react R1)
 */

import React from 'react';
import { useStore } from '@ui/store';
import { useViewportStore } from '@ui/store';
import type { Entity } from '@core/model/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatVec(v: readonly number[]): string {
  return v.map((n) => n.toFixed(3)).join(', ');
}

// ---------------------------------------------------------------------------
// Entity-visibility toggle (purely local render override — no dispatch)
// ---------------------------------------------------------------------------

function EntityVisibilityToggle({ entityId }: { entityId: string }): React.ReactElement {
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);
  const toggleVisibility = useViewportStore((s) => s.toggleEntityVisibility);
  const isHidden = hiddenEntityIds.has(entityId);

  return (
    <button
      type="button"
      className={`props-visibility-btn${isHidden ? ' props-visibility-btn--hidden' : ''}`}
      aria-pressed={isHidden}
      title={isHidden ? 'Show entity in viewport' : 'Hide entity in viewport'}
      onClick={() => toggleVisibility(entityId)}
    >
      {isHidden ? 'Show' : 'Hide'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Kind-specific dimension rows
// ---------------------------------------------------------------------------

function EntityDimensions({ entity }: { entity: Entity }): React.ReactElement | null {
  switch (entity.kind) {
    case 'box':
      return (
        <div className="props-row">
          <dt className="props-key">Size</dt>
          <dd className="props-value">{formatVec(entity.size)}</dd>
        </div>
      );
    case 'cylinder':
      return (
        <>
          <div className="props-row">
            <dt className="props-key">Radius</dt>
            <dd className="props-value">{entity.radius.toFixed(3)}</dd>
          </div>
          <div className="props-row">
            <dt className="props-key">Height</dt>
            <dd className="props-value">{entity.height.toFixed(3)}</dd>
          </div>
        </>
      );
    case 'sphere':
      return (
        <div className="props-row">
          <dt className="props-key">Radius</dt>
          <dd className="props-value">{entity.radius.toFixed(3)}</dd>
        </div>
      );
    case 'extrusion':
      return (
        <div className="props-row">
          <dt className="props-key">Depth</dt>
          <dd className="props-value">{entity.depth.toFixed(3)}</dd>
        </div>
      );
    case 'circle':
      return (
        <div className="props-row">
          <dt className="props-key">Radius</dt>
          <dd className="props-value">{entity.radius.toFixed(3)}</dd>
        </div>
      );
    case 'arc':
      return (
        <>
          <div className="props-row">
            <dt className="props-key">Radius</dt>
            <dd className="props-value">{entity.radius.toFixed(3)}</dd>
          </div>
          <div className="props-row">
            <dt className="props-key">Start Angle</dt>
            <dd className="props-value">{entity.startAngle.toFixed(3)} rad</dd>
          </div>
          <div className="props-row">
            <dt className="props-key">End Angle</dt>
            <dd className="props-value">{entity.endAngle.toFixed(3)} rad</dd>
          </div>
        </>
      );
    case 'rectangle':
      return (
        <>
          <div className="props-row">
            <dt className="props-key">Width</dt>
            <dd className="props-value">{entity.width.toFixed(3)}</dd>
          </div>
          <div className="props-row">
            <dt className="props-key">Height</dt>
            <dd className="props-value">{entity.height.toFixed(3)}</dd>
          </div>
        </>
      );
    case 'line':
      return (
        <>
          <div className="props-row">
            <dt className="props-key">Start</dt>
            <dd className="props-value">{formatVec(entity.start)}</dd>
          </div>
          <div className="props-row">
            <dt className="props-key">End</dt>
            <dd className="props-value">{formatVec(entity.end)}</dd>
          </div>
        </>
      );
    case 'polyline':
      return (
        <div className="props-row">
          <dt className="props-key">Points</dt>
          <dd className="props-value">{entity.points.length} pts</dd>
        </div>
      );
    case 'point':
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// SelectionSection
// ---------------------------------------------------------------------------

interface SelectionSectionProps {
  selection: readonly string[];
  entities: Record<string, Entity>;
}

function SelectionSection({ selection, entities }: SelectionSectionProps): React.ReactElement {
  if (selection.length === 0) {
    return (
      <section className="props-section" aria-label="Selection">
        <h2 className="props-section-title">Selection</h2>
        <p className="props-empty">No entity selected.</p>
      </section>
    );
  }

  if (selection.length > 1) {
    return (
      <section className="props-section" aria-label="Selection">
        <h2 className="props-section-title">Selection</h2>
        <p className="props-empty">{selection.length} entities selected.</p>
      </section>
    );
  }

  const id = selection[0];
  if (!id) {
    return (
      <section className="props-section" aria-label="Selection">
        <h2 className="props-section-title">Selection</h2>
        <p className="props-empty">No entity selected.</p>
      </section>
    );
  }

  const entity = entities[id];
  if (!entity) {
    return (
      <section className="props-section" aria-label="Selection">
        <h2 className="props-section-title">Selection</h2>
        <p className="props-empty">Entity not found.</p>
      </section>
    );
  }

  return (
    <section className="props-section" aria-label="Selection">
      <div className="props-section-header">
        <h2 className="props-section-title">Selection</h2>
        <EntityVisibilityToggle entityId={entity.id} />
      </div>
      <dl className="props-list">
        <div className="props-row">
          <dt className="props-key">Kind</dt>
          <dd className="props-value">{entity.kind}</dd>
        </div>
        <div className="props-row">
          <dt className="props-key">ID</dt>
          <dd className="props-value props-id">{entity.id}</dd>
        </div>
        <div className="props-row">
          <dt className="props-key">Position</dt>
          <dd className="props-value">{formatVec(entity.position)}</dd>
        </div>
        <div className="props-row">
          <dt className="props-key">Color</dt>
          <dd className="props-value">
            <span
              className="props-color-swatch"
              style={{ background: entity.color }}
              aria-label={entity.color}
            />
            {entity.color}
          </dd>
        </div>
        <EntityDimensions entity={entity} />
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// PropertiesPanel
// ---------------------------------------------------------------------------

export interface PropertiesPanelProps {
  className?: string;
}

export function PropertiesPanel({ className }: PropertiesPanelProps): React.ReactElement {
  const selection = useStore((s) => s.document.selection);
  const entities = useStore((s) => s.document.entities);

  return (
    <aside
      className={['app-properties', className].filter(Boolean).join(' ')}
      aria-label="Properties"
    >
      <SelectionSection selection={selection} entities={entities} />
    </aside>
  );
}
