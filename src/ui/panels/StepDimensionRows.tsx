// Properties "Geometry": the dimensions of the step that created the entity, editable (edit_step_params, the parametric path the
// viewport lens uses). A dimension driven by a parameter shows its expression read-only. Entities without a dimensioned creating step
// (imports, booleans) fall back to the read-only readouts.

import React, { useCallback, useState } from 'react';
import type { Entity } from '@core/model/types';
import { fixedNumber } from '@lib/compactNumber';
import { parseNumber } from '@ui/numberText';
import { useStore } from '@ui/store';
import { useStepDimensionEdit } from '@ui/hooks/useStepDimensionEdit';
import { type LensDimension, type LensTarget, lensTarget } from '@ui/viewport/3d/lensDimensions';
import { AxisFields, CommitInput, PropRow } from './propertyFields';
import { dimensionRows } from './entityDimensions';
import { humanizeName } from '@ui/components/commandPalette/paramForm';
import { PanelSection } from './PanelParts';

/** One row per param: the components of a vector param (`size`) share a row. */
function groupByKey(dimensions: readonly LensDimension[]): LensDimension[][] {
  const groups = new Map<string, LensDimension[]>();
  for (const dimension of dimensions) groups.set(dimension.key, [...(groups.get(dimension.key) ?? []), dimension]);
  return [...groups.values()];
}

function ExpressionValue({ expression }: { expression: string }): React.ReactElement {
  return (
    <span className="props-number props-expression" title="Driven by a parameter: edit it in Params">
      {expression}
    </span>
  );
}

interface DimensionRowProps {
  group: readonly LensDimension[];
  onCommit: (dimension: LensDimension, value: number) => void;
}

function DimensionRow({ group, onCommit }: DimensionRowProps): React.ReactElement | null {
  const [first] = group;
  if (first === undefined) return null;
  const label = humanizeName(first.key);
  const expression = group.find((dimension) => dimension.expression !== null)?.expression ?? null;
  if (expression !== null) {
    return (
      <PropRow label={label}>
        <ExpressionValue expression={expression} />
      </PropRow>
    );
  }
  if (first.index !== undefined) {
    return (
      <PropRow label={label}>
        <AxisFields
          values={group.map((dimension) => dimension.value ?? 0)}
          label={label}
          onAxisCommit={(axisIndex, value) => {
            const dimension = group.find((candidate) => candidate.index === axisIndex);
            if (dimension !== undefined) onCommit(dimension, value);
          }}
        />
      </PropRow>
    );
  }
  const text = fixedNumber(first.value ?? 0, 3);
  return (
    <PropRow label={label}>
      <label key={text} className="axis-field axis-field--editable">
        <CommitInput
          className="axis-field__input"
          label={label}
          value={text}
          inputMode="decimal"
          onCommit={(raw) => {
            const parsed = parseNumber(raw);
            if (parsed !== undefined) onCommit(first, parsed);
          }}
        />
      </label>
    </PropRow>
  );
}

function EditableDimensions({ entity, target }: { entity: Entity; target: LensTarget }): React.ReactElement {
  const [refusal, setRefusal] = useState<string | null>(null);
  const onRefused = useCallback((summary: string) => setRefusal(summary), []);
  const editDimension = useStepDimensionEdit(entity.id, onRefused);
  const commit = (dimension: LensDimension, value: number): void => {
    setRefusal(null);
    editDimension(target, dimension, value);
  };
  return (
    <>
      {groupByKey(target.dimensions).map((group) => (
        <DimensionRow key={group[0]?.key} group={group} onCommit={commit} />
      ))}
      {refusal !== null && (
        <p className="props-refusal" role="alert">
          {refusal}
        </p>
      )}
    </>
  );
}

/** The Geometry section: editable creating-step dimensions, else the read-only readouts, else nothing. */
export function GeometrySection({ entity }: { entity: Entity }): React.ReactElement | null {
  const history = useStore((s) => s.document.featureHistory);
  const target = lensTarget(history, entity.id);
  const rows = target !== null ? <EditableDimensions key={entity.id} entity={entity} target={target} /> : dimensionRows(entity);
  return rows === null ? null : <PanelSection title="Geometry">{rows}</PanelSection>;
}
