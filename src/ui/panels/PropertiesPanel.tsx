/**
 * @layer ui/panels
 *
 * PropertiesPanel — the right-docked read-only entity inspector.
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
import { is2D } from '@core/model/types';
import type { Entity } from '@core/model/types';
import { Icon } from '@ui/components/Icon';
import { PanelEmpty, PanelHeader, PanelSection } from '@ui/panels/PanelParts';

// ---------------------------------------------------------------------------
// Field primitives
// ---------------------------------------------------------------------------

const AXES = ['x', 'y', 'z'] as const;

function formatNumber(n: number): string {
  return n.toFixed(3);
}

function PropRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="props-row">
      <span className="props-key">{label}</span>
      <div className="props-value">{children}</div>
    </div>
  );
}

function AxisFields({ values }: { values: readonly number[] }): React.ReactElement {
  return (
    <div className="axis-fields">
      {values.slice(0, 3).map((n, i) => {
        const axis = AXES[i] ?? 'z';
        return (
          <span key={axis} className="axis-field">
            <span className={`axis-field__letter axis-field__letter--${axis}`} aria-hidden="true">
              {axis.toUpperCase()}
            </span>
            <span className="axis-field__value">{formatNumber(n)}</span>
          </span>
        );
      })}
    </div>
  );
}

function ScalarRow({
  label,
  value,
  unit,
}: {
  label: string;
  value: number;
  unit?: string;
}): React.ReactElement {
  return (
    <PropRow label={label}>
      <span className="props-number">
        {formatNumber(value)}
        {unit !== undefined && <span className="props-unit">{unit}</span>}
      </span>
    </PropRow>
  );
}

// ---------------------------------------------------------------------------
// Entity-visibility toggle (purely local render override — no dispatch)
// ---------------------------------------------------------------------------

function EntityVisibilityToggle({ entityId }: { entityId: string }): React.ReactElement {
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);
  const toggleVisibility = useViewportStore((s) => s.toggleEntityVisibility);
  const isHidden = hiddenEntityIds.has(entityId);
  const label = isHidden ? 'Show entity in viewport' : 'Hide entity in viewport';

  return (
    <button
      type="button"
      className={`icon-btn props-visibility-btn${isHidden ? ' props-visibility-btn--hidden' : ''}`}
      aria-pressed={isHidden}
      aria-label={label}
      title={label}
      onClick={() => toggleVisibility(entityId)}
    >
      <Icon name={isHidden ? 'eyeOff' : 'eye'} size={15} />
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
        <PropRow label="Size">
          <AxisFields values={entity.size} />
        </PropRow>
      );
    case 'cylinder':
      return (
        <>
          <ScalarRow label="Radius" value={entity.radius} />
          <ScalarRow label="Height" value={entity.height} />
        </>
      );
    case 'sphere':
    case 'circle':
      return <ScalarRow label="Radius" value={entity.radius} />;
    case 'extrusion':
      return <ScalarRow label="Depth" value={entity.depth} />;
    case 'arc':
      return (
        <>
          <ScalarRow label="Radius" value={entity.radius} />
          <ScalarRow label="Start Angle" value={entity.startAngle} unit="rad" />
          <ScalarRow label="End Angle" value={entity.endAngle} unit="rad" />
        </>
      );
    case 'rectangle':
      return (
        <>
          <ScalarRow label="Width" value={entity.width} />
          <ScalarRow label="Height" value={entity.height} />
        </>
      );
    case 'line':
      return (
        <>
          <PropRow label="Start">
            <AxisFields values={entity.start} />
          </PropRow>
          <PropRow label="End">
            <AxisFields values={entity.end} />
          </PropRow>
        </>
      );
    case 'polyline':
      return (
        <PropRow label="Points">
          <span className="props-number">
            {entity.points.length}
            <span className="props-unit">pts</span>
          </span>
        </PropRow>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Selected-entity detail
// ---------------------------------------------------------------------------

function EntityDetail({ entity }: { entity: Entity }): React.ReactElement {
  const hasDimensions = EntityDimensions({ entity }) !== null;
  return (
    <section className="props-detail" aria-label="Selection">
      <div className="props-summary">
        <span className="props-summary__icon" aria-hidden="true">
          <Icon name={is2D(entity) ? 'square' : 'cube'} size={18} />
        </span>
        <div className="props-summary__text">
          <span className="props-summary__name" title={entity.name ?? entity.id}>
            {entity.name ?? entity.id}
          </span>
          <div className="props-summary__meta">
            <span className="chip chip--accent">{entity.kind}</span>
            {entity.name !== undefined && <span className="props-id">{entity.id}</span>}
          </div>
        </div>
        <EntityVisibilityToggle entityId={entity.id} />
      </div>

      <PanelSection title="Transform">
        <PropRow label="Position">
          <AxisFields values={entity.position} />
        </PropRow>
      </PanelSection>

      {hasDimensions && (
        <PanelSection title="Geometry">
          <EntityDimensions entity={entity} />
        </PanelSection>
      )}

      <PanelSection title="Appearance">
        <PropRow label="Color">
          <span className="props-color">
            <span
              className="props-color-swatch"
              style={{ background: entity.color }}
              aria-label={entity.color}
            />
            <span className="props-number">{entity.color}</span>
          </span>
        </PropRow>
      </PanelSection>
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

  const [selectedId] = selection;
  const entity =
    selection.length === 1 && selectedId !== undefined ? entities[selectedId] : undefined;

  let body: React.ReactElement;
  if (selection.length === 0) {
    body = (
      <PanelEmpty
        icon="cursor"
        message="No entity selected"
        hint="Select an entity to inspect it."
      />
    );
  } else if (selection.length > 1) {
    body = (
      <PanelEmpty
        icon="layers"
        message={`${selection.length} entities selected`}
        hint="Select a single entity to see its properties."
      />
    );
  } else if (entity === undefined) {
    body = <PanelEmpty icon="info" message="Entity not found." />;
  } else {
    body = <EntityDetail entity={entity} />;
  }

  return (
    <aside
      className={['panel properties-panel', className].filter(Boolean).join(' ')}
      aria-label="Properties"
    >
      <PanelHeader title="Properties" />
      {body}
    </aside>
  );
}
