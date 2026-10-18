// Fasteners tab (aerospace 08 §7): the catalogue families, the placed stacks (delete, layout check) and the bill of materials.
// Insertion goes through the dialog (live select_fastener preview, confirm = insert_fastener_stack).

import React, { useState } from 'react';
import { classNames } from '@ui/classNames';
import { KpiStrip, ListRow, PanelEmpty, PanelHeader, PanelSection, StatusChip } from '@ui/panels/PanelParts';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { useFocusStore } from '@ui/store/focusStore';
import { ProvenancePopover } from '@ui/panels/ProvenancePopover';
import { useReadOnlyQuery } from '@ui/panels/useReadOnlyQuery';
import { licenceText } from '@ui/panels/materials/materialRecordView';
import { useStore } from '@ui/store';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { BomSections } from './BomSections';
import { parseLayout } from './fastenerView';
import { InsertFastenerDialog } from './InsertFastenerDialog';
import { FASTENER_COLOR, layoutFindingFocus, stackFocus } from './fastenerFocus';

export function FastenersPanel({ className }: { className?: string }): React.ReactElement {
  const catalogs = useStore((s) => s.document.fasteners?.catalogs);
  const stacks = useStore((s) => s.document.fasteners?.stacks);
  const dispatch = useStore((s) => s.dispatch);
  const document = useDocumentWithoutSelection();
  const focusItem = useFocusItem();
  const focusKey = useFocusStore((s) => s.focus?.key);
  const [inserting, setInserting] = useState(false);
  const layout = useReadOnlyQuery('check_fastener_layout', parseLayout);
  const families = Object.values(catalogs ?? {});
  const stackList = Object.values(stacks ?? {});

  return (
    <aside className={classNames('panel fasteners-panel', className)} aria-label="Fasteners">
      <PanelHeader title="Fasteners" count={stackList.length} countLabel={`${stackList.length} stacks`}>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() => setInserting(true)}
          disabled={families.length === 0}
          data-testid="fastener-insert-open"
        >
          Insert…
        </button>
      </PanelHeader>
      <KpiStrip
        label="Fastener summary"
        items={[
          { key: 'stacks', label: 'Stacks', value: String(stackList.length) },
          ...(layout.view === null
            ? []
            : [
                {
                  key: 'layout',
                  label: 'Layout',
                  value: layout.view.status,
                  tone:
                    layout.view.status === 'fail' ? ('bad' as const) : layout.view.status === 'warn' ? ('warn' as const) : ('ok' as const),
                },
              ]),
        ]}
      />
      {families.length === 0 ? (
        <PanelEmpty
          icon="cube"
          message="No fastener catalogue."
          hint="Import a catalogue (import_fastener_catalog) to select and insert fasteners."
          compact
        />
      ) : (
        <PanelSection title="Catalogue" count={families.length} testId="fastener-families">
          <ul className="panel__list" aria-label="Fastener families">
            {families.map((family) => (
              <li key={family.id} className="panel__row fastener-family" data-testid={`family-${family.id}`}>
                <strong>{family.id}</strong>
                <span className="panel__row-meta">
                  {family.kind.replace('_', ' ')} · {family.standard.body} {family.standard.id} · {family.sizes.length} sizes
                </span>
                <span className="badge">{licenceText(family.licence)}</span>
                <ProvenancePopover
                  entries={[family.provenance.citation, family.provenance.locator, family.provenance.note]
                    .filter((value): value is string => value !== undefined)
                    .map((value) => ({ label: 'Source', value }))}
                />
              </li>
            ))}
          </ul>
        </PanelSection>
      )}
      <PanelSection title="Placed stacks" count={stackList.length} testId="fastener-stacks">
        {stackList.length === 0 ? (
          <p className="panel__row-meta">No fastener stacks yet.</p>
        ) : (
          <>
            <ul className="panel__list" aria-label="Fastener stacks">
              {stackList.map((stack) => (
                <ListRow
                  key={stack.id}
                  testId={`stack-${stack.id}`}
                  buttonTestId={`stack-focus-${stack.id}`}
                  swatch={FASTENER_COLOR}
                  selected={focusKey === stackFocus(stack).key}
                  onSelect={() => focusItem(stackFocus(stack))}
                  actions={
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => dispatch('delete_fastener_stack', { stackIds: [stack.id] })}
                      aria-label={`Delete stack ${stack.id}`}
                    >
                      Delete
                    </button>
                  }
                >
                  <strong>{stack.fastener.partNumber}</strong>
                  <span className="panel__row-meta">
                    -{stack.fastener.diameterDash} · {stack.id} · {stack.layers.length} layer(s)
                  </span>
                </ListRow>
              ))}
            </ul>
            <button type="button" className="btn btn--sm" onClick={() => layout.run({})} data-testid="layout-run">
              Check layout
            </button>
            {layout.view !== null && (
              <p className="mfg__figures" data-testid="layout-status">
                Layout: <strong>{layout.view.status}</strong> — {layout.view.items.length} finding(s)
                {layout.view.items.map((f) => (
                  <span key={`${f.code}-${f.stackIds.join()}`} className="finding__badge" title={f.remediation}>
                    {f.code}
                  </span>
                ))}
              </p>
            )}
            {layout.view !== null && layout.view.items.length > 0 && (
              <ul className="panel__list" aria-label="Layout findings">
                {layout.view.items.map((finding) => {
                  const focus = layoutFindingFocus(document, finding);
                  return (
                    <ListRow
                      key={focus.key}
                      buttonTestId="layout-finding"
                      swatch={focus.color}
                      selected={focusKey === focus.key}
                      onSelect={() => focusItem(focus)}
                    >
                      <StatusChip tone={finding.severity === 'error' ? 'bad' : 'warn'} text={finding.code} />
                      <span className="panel__row-main">{finding.message}</span>
                    </ListRow>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </PanelSection>
      <BomSections />
      {inserting && <InsertFastenerDialog onClose={() => setInserting(false)} />}
    </aside>
  );
}
