// check_analysis outcome: pass / warn / fail status and its items. A finding has no point of its own: clicking it highlights the analysed parts.

import React from 'react';
import { ListRow, PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { useIsFocused } from '@ui/store/focusStore';
import type { CheckView } from './analysisData';
import { COLORS } from './analysisItems';

const STATUS_TEXT: Readonly<Record<CheckView['status'], string>> = { pass: 'Ready', warn: 'Warnings', fail: 'Problems found' };

interface CheckRowProps {
  item: CheckView['items'][number];
  rowKey: string;
  partIds: readonly string[];
}

function CheckRow({ item, rowKey, partIds }: CheckRowProps): React.ReactElement {
  const focusItem = useFocusItem();
  const focused = useIsFocused(rowKey);
  const color = item.severity === 'error' ? COLORS.error : COLORS.warning;
  return (
    <ListRow
      swatch={color}
      selected={focused}
      pressed={focused}
      label={`Show the analysed parts for ${item.code}`}
      onSelect={() => focusItem({ key: rowKey, label: `${item.code}: ${item.message}`, color, entityIds: partIds, markers: [] })}
    >
      <span className="panel__row-main">{item.code}</span>
      <span className="analysis__item-detail">
        {item.message}
        {item.remediation !== '' ? ` — ${item.remediation}` : ''}
      </span>
    </ListRow>
  );
}

export function AnalysisChecks({
  check,
  summary,
  partIds,
}: {
  check: CheckView | null;
  summary: string;
  partIds: readonly string[];
}): React.ReactElement {
  return (
    <PanelSection title="Checks" hint="check_analysis: readiness and consistency. Not a certification; a qualified person must review.">
      {check === null ? (
        <StatusLine text={summary} testId="analysis-check-summary" />
      ) : (
        <>
          <p className={`analysis__badge analysis__badge--${check.status}`} data-testid="analysis-check-status">
            {check.status} · {STATUS_TEXT[check.status]}
          </p>
          <ul className="panel__list" aria-label="Check items">
            {check.items.map((item, index) => (
              <CheckRow key={`${item.code}-${index}`} item={item} rowKey={`analysis:check:${item.code}-${index}`} partIds={partIds} />
            ))}
          </ul>
        </>
      )}
    </PanelSection>
  );
}
