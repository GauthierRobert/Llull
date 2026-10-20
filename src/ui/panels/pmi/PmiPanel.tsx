// Semantic PMI (`document.pmi`): the items with their review state, saved views, the governing standard and the viewport toggle. The
// document changes only through commands (`add_datum_feature`, `set_pmi_standard`, `activate_saved_view`, `delete_pmi`, ...).

import React from 'react';
import '@ui/styles/panels/pmi.css';
import { PMI_STANDARDS } from '@core/model/pmi';
import { pmiText } from '@core/geometry/pmiText';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import { usePmiViewStore } from '@ui/viewport/3d/pmiViewStore';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { DeleteButton, ListRow, PanelEmpty, PanelHeader, PanelSection } from '@ui/panels/PanelParts';
import { ReviewBanner } from '@ui/panels/ReviewBanner';
import { AddDatumForm } from './AddDatumForm';

/** The app has no signing port yet, so a review cannot be signed here (the command refuses an unsigned decision). */
const NO_SIGNING_PORT = 'Accepting or rejecting PMI is a human decision that needs a signature; this app has no signing port yet.';

export function PmiPanel({ className }: { className?: string }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const pmi = useStore((s) => s.document.pmi);
  const showPmi = usePmiViewStore((s) => s.showPmi);
  const setShowPmi = usePmiViewStore((s) => s.setShowPmi);
  const items = (pmi?.order ?? []).flatMap((id) => pmi?.items[id] ?? []);
  const views = (pmi?.savedViewOrder ?? []).flatMap((id) => pmi?.savedViews[id] ?? []);
  const unreviewed = items.filter((item) => item.review.required).length;

  return (
    <aside className={classNames('panel', className)} aria-label="PMI" data-testid="pmi-panel">
      <PanelHeader title="PMI" count={items.length} countLabel={`${items.length} PMI items`} />
      <PanelSection title="Standard" hint="Governs symbols and rules; stored with the document.">
        <LabeledSelect
          label="Standard"
          value={pmi?.standard ?? 'ASME_Y14.5_2018'}
          options={PMI_STANDARDS.map((standard): readonly [string, string] => [standard, standard.replace('_', ' ')])}
          testId="pmi-standard"
          onChange={(standard) => dispatch('set_pmi_standard', { standard })}
        />
        <label className="field field--inline">
          <input type="checkbox" checked={showPmi} data-testid="pmi-show" onChange={(event) => setShowPmi(event.target.checked)} />
          <span className="field__label">Show PMI in the viewport</span>
        </label>
      </PanelSection>
      {unreviewed > 0 && (
        <ReviewBanner
          reason={`${unreviewed} PMI item(s) were created or edited by commands and are not approved by a qualified engineer.`}
        />
      )}
      <PanelSection title="Items" count={items.length} countLabel={`${items.length} items`}>
        {items.length === 0 ? (
          <PanelEmpty
            compact
            icon="ruler"
            message="No PMI yet"
            hint="Add a datum below, or use add_size_dimension / add_geometric_tolerance."
          />
        ) : (
          <ul className="panel__list" aria-label="PMI items">
            {items.map((item) => (
              <li key={item.id} className="panel__row pmi-row" data-testid={`pmi-row-${item.id}`}>
                <span className="pmi-row__body">
                  <span className="panel__row-main pmi-text">{pmiText(item)}</span>
                  <span className="panel__row-meta">
                    {item.kind.replace('_', ' ')}
                    {item.review.required ? ' · review required' : ` · accepted by ${item.review.acceptedBy ?? 'a reviewer'}`}
                    {item.unverified === undefined ? '' : ' · unverified'}
                  </span>
                </span>
                <span className="panel__row-actions">
                  <>
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      disabled
                      title={NO_SIGNING_PORT}
                      data-testid={`pmi-accept-${item.id}`}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      disabled
                      title={NO_SIGNING_PORT}
                      data-testid={`pmi-reject-${item.id}`}
                    >
                      Reject
                    </button>
                    <DeleteButton
                      label={`Delete PMI ${item.id}`}
                      testId={`pmi-delete-${item.id}`}
                      onDelete={() => dispatch('delete_pmi', { pmiId: item.id })}
                    />
                  </>
                </span>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
      <PanelSection title="Saved views" count={views.length} countLabel={`${views.length} saved views`} hint="Open one to see its PMI.">
        {views.length === 0 ? (
          <PanelEmpty compact icon="eye" message="No saved views" hint="create_saved_view stores a camera and a PMI set." />
        ) : (
          <ul className="panel__list" aria-label="Saved views">
            {views.map((view) => (
              <ListRow
                key={view.id}
                testId={`pmi-view-${view.id}`}
                buttonTestId={`pmi-view-open-${view.id}`}
                current={pmi?.activeSavedViewId === view.id}
                selected={pmi?.activeSavedViewId === view.id}
                label={`Open saved view ${view.name}`}
                onSelect={() => dispatch('activate_saved_view', { savedViewId: view.id })}
                actions={
                  <DeleteButton
                    label={`Delete saved view ${view.name}`}
                    testId={`pmi-view-delete-${view.id}`}
                    onDelete={() => dispatch('delete_saved_view', { savedViewId: view.id })}
                  />
                }
              >
                <span className="panel__row-main">{view.name}</span>
                <span className="panel__row-meta">{view.pmiIds.length} items</span>
              </ListRow>
            ))}
          </ul>
        )}
      </PanelSection>
      <PanelSection title="Add datum" collapsible defaultOpen={false}>
        <AddDatumForm />
      </PanelSection>
    </aside>
  );
}
