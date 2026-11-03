// Section boxes and colour profiles of the model review. A box is created around the selection (else the model), made active or deleted
// through commands; the viewport clips with the active one and shows its drag gizmo. The active colour profile tints the viewport.

import React, { useState } from 'react';
import type { CadDocument } from '@core/model/types';
import { PanelSection } from '@ui/panels/PanelParts';
import { useStore } from '@ui/store';
import { sectionBoxAround } from './issueModel';

const MARGIN_FRACTION = 0.05;

export function DisplaySection({ document }: { document: CadDocument }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [status, setStatus] = useState('');
  const review = document.review;
  const boxes = Object.values(review?.sectionBoxes ?? {});
  const profiles = Object.values(document.display?.colourProfiles ?? {});
  const activeProfile = document.display?.activeProfileId;
  const activeProfileRules = activeProfile === undefined ? [] : (document.display?.colourProfiles[activeProfile]?.rules ?? []);

  const create = (): void => {
    const probe = sectionBoxAround(document, document.selection, 0);
    if (probe === null) return setStatus('Nothing to put a box around.');
    const longest = Math.max(probe.max[0] - probe.min[0], probe.max[1] - probe.min[1], probe.max[2] - probe.min[2]);
    const params = sectionBoxAround(document, document.selection, longest * MARGIN_FRACTION);
    if (params !== null) dispatch('set_section_box', params);
  };

  return (
    <PanelSection title="Section and colour" testId="review-display" collapsible>
      <div className="issue-form">
        <button type="button" className="btn btn--sm" onClick={create}>
          Section box around {document.selection.length > 0 ? 'selection' : 'model'}
        </button>
      </div>
      {status !== '' && <p className="panel__row-meta">{status}</p>}
      <ul className="panel__list" aria-label="Section boxes">
        {boxes.map((box) => {
          const active = review?.activeSectionBoxId === box.id;
          return (
            <li key={box.id} className={`panel__row${active ? ' panel__row--selected' : ''}`}>
              <span className="panel__row-main">{box.name}</span>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                aria-pressed={active}
                aria-label={`Clip with ${box.name}`}
                disabled={active}
                onClick={() => dispatch('set_section_box', { ...box, activate: true })}
              >
                {active ? 'Clipping' : 'Clip'}
              </button>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                aria-label={`Delete section box ${box.id}`}
                onClick={() => dispatch('delete_section_box', { id: box.id })}
              >
                Delete
              </button>
            </li>
          );
        })}
      </ul>
      {boxes.length > 0 && <p className="panel__row-meta">Drag the round grips on the active box to resize it.</p>}
      <label className="field field--inline">
        <span className="field__label">Colour profile</span>
        <select
          className="field__input"
          aria-label="Colour profile"
          value={activeProfile ?? ''}
          disabled={profiles.length === 0}
          onChange={(event) => dispatch('set_active_colour_profile', { profileId: event.target.value === '' ? null : event.target.value })}
        >
          <option value="">{profiles.length === 0 ? 'No profiles' : 'Entity colours'}</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      {activeProfileRules.length > 0 && (
        <ul className="panel__list" aria-label="Colour legend" data-testid="colour-legend">
          {activeProfileRules.map((rule) => (
            <li key={rule.id} className="panel__row">
              <span className="panel__swatch" style={{ background: rule.appearance.colour }} aria-hidden="true" />
              <span className="panel__row-main">{rule.legend}</span>
            </li>
          ))}
        </ul>
      )}
    </PanelSection>
  );
}
