// Headline numbers and result rows of the body analysis. Every tile / row highlights the body on the model with a value beacon.

import React from 'react';
import { boundsCenter } from '@core/geometry/bounds';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { useIsFocused } from '@ui/store/focusStore';
import { ListRow, type Kpi, KpiStrip } from '@ui/panels/PanelParts';
import { AERO_COLORS } from '@ui/viewport/3d/aero/aeroGeometry';
import { formatQuantity } from './aeroData';
import type { BodyAnalysis } from './useAeroAnalysis';

interface ResultItem {
  key: string;
  label: string;
  value: string;
  /** Pill text on the model. */
  pill: string;
  color: string;
  hint: string;
}

function resultItems(analysis: BodyAnalysis): ResultItem[] {
  const { frontal, drag } = analysis;
  const items: ResultItem[] = [];
  if (frontal !== null) {
    const area = `${formatQuantity(frontal.areaM2)} m²`;
    items.push({
      key: 'area',
      label: 'Frontal area',
      value: area,
      pill: `A = ${area}`,
      color: AERO_COLORS.area,
      hint: `± ${formatQuantity(frontal.uncertaintyM2)} m², seen along the flow`,
    });
  }
  if (drag !== null) {
    const force = `${formatQuantity(drag.dragN)} N`;
    items.push({ key: 'drag', label: 'Drag force', value: force, pill: `D = ${force}`, color: AERO_COLORS.drag, hint: 'D = ½ ρ V² CdA' });
    items.push({
      key: 'cda',
      label: 'Drag area CdA',
      value: `${formatQuantity(drag.cdA)} m²`,
      pill: `CdA = ${formatQuantity(drag.cdA)} m²`,
      color: AERO_COLORS.drag,
      hint: 'Cd x frontal area',
    });
    const power = drag.powerW >= 1000 ? `${formatQuantity(drag.powerW / 1000)} kW` : `${formatQuantity(drag.powerW)} W`;
    items.push({
      key: 'power',
      label: 'Drag power',
      value: power,
      pill: `P = ${power}`,
      color: AERO_COLORS.drag,
      hint: 'Power to overcome drag, P = D V',
    });
    const q = `${formatQuantity(drag.dynamicPressurePa)} Pa`;
    items.push({ key: 'q', label: 'Dynamic pressure q', value: q, pill: `q = ${q}`, color: AERO_COLORS.wind, hint: '½ ρ V²' });
    if (drag.reynolds !== null)
      items.push({
        key: 're',
        label: 'Reynolds number',
        value: formatQuantity(drag.reynolds),
        pill: `Re = ${formatQuantity(drag.reynolds)}`,
        color: AERO_COLORS.wind,
        hint: 'Based on the body length along the flow',
      });
  }
  return items;
}

function useBodyFocus(analysis: BodyAnalysis): ((item: ResultItem) => void) | null {
  const focusItem = useFocusItem();
  const { bounds, bodyIds } = analysis;
  if (bounds === null && bodyIds.length === 0) return null;
  return (item) =>
    focusItem({
      key: `aero:${item.key}`,
      label: `${item.label} ${item.value}`,
      color: item.color,
      entityIds: bodyIds,
      markers: bounds === null ? [] : [{ position: boundsCenter(bounds), label: item.pill }],
    });
}

const KPI_KEYS = ['area', 'cda', 'drag', 'power', 'q', 're'];

export function AeroBodyKpis({ analysis }: { analysis: BodyAnalysis }): React.ReactElement | null {
  const focus = useBodyFocus(analysis);
  const kpis: Kpi[] = resultItems(analysis)
    .filter((item) => KPI_KEYS.includes(item.key))
    .map((item) => ({
      key: item.key,
      label: item.label,
      value: item.value,
      ...(item.key === 'drag' ? { tone: 'bad' as const } : {}),
      ...(focus === null ? {} : { onClick: () => focus(item) }),
    }));
  return <KpiStrip items={kpis} label="Aerodynamic headline numbers" />;
}

function ResultRow({ item, focus }: { item: ResultItem; focus: ((item: ResultItem) => void) | null }): React.ReactElement {
  const focused = useIsFocused(`aero:${item.key}`);
  return (
    <ListRow
      testId={`aero-row-${item.key}`}
      selected={focused}
      swatch={item.color}
      label={`Show ${item.label} on the model`}
      onSelect={() => focus?.(item)}
    >
      <span className="panel__row-main">{item.label}</span>
      <span className="panel__row-meta" title={item.hint}>
        {item.value}
      </span>
    </ListRow>
  );
}

export function AeroBodyRows({ analysis }: { analysis: BodyAnalysis }): React.ReactElement | null {
  const focus = useBodyFocus(analysis);
  const items = resultItems(analysis);
  if (items.length === 0) return null;
  return (
    <ul className="panel__list" aria-label="Aerodynamic results">
      {items.map((item) => (
        <ResultRow key={item.key} item={item} focus={focus} />
      ))}
    </ul>
  );
}
