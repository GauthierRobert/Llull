// DOM overlay of saved viewpoints (document.review, save_viewpoint / apply_viewpoint / delete_viewpoint); presentation + param gathering only.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { enterEscapeKeys } from '../enterEscapeKeys';
import { getCameraSnapshot } from './cameraBridge';
import { viewpointCameraParams } from './viewpointParams';

export function NamedViewsOverlay(): React.ReactElement {
  const review = useStore((s) => s.document.review);
  const dispatch = useStore((s) => s.dispatch);
  const viewpoints = useMemo(
    () => (review?.viewpointOrder ?? []).flatMap((id) => (review?.viewpoints[id] === undefined ? [] : [review.viewpoints[id]])),
    [review],
  );

  const [newName, setNewName] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isExpanded) inputRef.current?.focus();
  }, [isExpanded]);

  const handleSave = (): void => {
    const trimmed = newName.trim();
    if (trimmed === '') return; // no silent "View"
    const snapshot = getCameraSnapshot();
    const camera = snapshot === null ? null : viewpointCameraParams(snapshot);
    if (camera === null) return; // the Canvas is not mounted yet
    dispatch('save_viewpoint', { name: trimmed, camera });
    setNewName('');
  };

  return (
    <div className="named-views" aria-label="Named camera views" role="group">
      <button
        type="button"
        className={`vp-btn${viewpoints.length > 0 ? '' : ' vp-btn--icon'}${isExpanded ? ' vp-btn--toggled' : ''}`}
        onClick={() => setIsExpanded((expanded) => !expanded)}
        aria-expanded={isExpanded}
        aria-controls="named-views-panel"
        aria-label={`Views${viewpoints.length > 0 ? ` (${viewpoints.length})` : ''}`}
        title="Saved viewpoints"
      >
        <Icon name="bookmark" size={14} />
        {viewpoints.length > 0 && <span className="vp-count">{viewpoints.length}</span>}
      </button>

      {isExpanded && (
        <div id="named-views-panel" className="vp-popover named-views-panel" role="region" aria-label="Named views panel">
          <div className="named-views-save-row">
            <label className="visually-hidden" htmlFor="named-view-name-input">
              Name
            </label>
            <input
              id="named-view-name-input"
              ref={inputRef}
              type="text"
              className="named-views-input"
              placeholder="Name this view…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={enterEscapeKeys({
                onEnter: handleSave,
                onEscape: () => {
                  setNewName('');
                  setIsExpanded(false);
                },
              })}
              aria-label="New view name"
              maxLength={64}
            />
            <button
              type="button"
              className="vp-primary-btn"
              onClick={handleSave}
              aria-label="Save current camera as named view"
              title="Save current camera"
            >
              Save
            </button>
          </div>

          {viewpoints.length > 0 ? (
            <ul className="named-views-list" role="list" aria-label="Saved views">
              {viewpoints.map((view) => (
                <li key={view.id} className="named-views-item">
                  <button
                    type="button"
                    className="named-views-restore-btn"
                    onClick={() => dispatch('apply_viewpoint', { id: view.id })}
                    title={`Restore view: ${view.name}`}
                    aria-label={`Restore view ${view.name}`}
                  >
                    {view.name}
                  </button>
                  <button
                    type="button"
                    className="named-views-delete-btn"
                    onClick={() => dispatch('delete_viewpoint', { id: view.id })}
                    title={`Delete view: ${view.name}`}
                    aria-label={`Delete view ${view.name}`}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="named-views-empty">No saved views yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
