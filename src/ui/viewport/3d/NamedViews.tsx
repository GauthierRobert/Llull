/**
 * @layer ui/viewport/3d
 *
 * NamedViews — savable camera bookmarks for the 3D viewport.
 *
 * `NamedViewsOverlay` is mounted OUTSIDE the Canvas; it reads `useNamedViewStore` and drives the
 * camera through `cameraBridge` (placeCamera / getCameraSnapshot).
 *
 * Purely presentational: reads stores and never mutates the document (PRIME DIRECTIVE).
 */

import React, { useEffect, useRef, useState } from 'react';
import { useNamedViewStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { enterEscapeKeys } from '../enterEscapeKeys';
import { getCameraSnapshot, placeCamera } from './cameraBridge';

/** Rendered OUTSIDE the Canvas as a DOM overlay. */
export function NamedViewsOverlay(): React.ReactElement {
  const namedViews = useNamedViewStore((s) => s.namedViews);
  const saveNamedView = useNamedViewStore((s) => s.saveNamedView);
  const restoreNamedView = useNamedViewStore((s) => s.restoreNamedView);
  const deleteNamedView = useNamedViewStore((s) => s.deleteNamedView);

  const [newName, setNewName] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the name field once the panel opens.
  useEffect(() => {
    if (isExpanded) inputRef.current?.focus();
  }, [isExpanded]);

  const handleSave = (): void => {
    const trimmed = newName.trim();
    if (trimmed === '') return; // ignore blank names — don't silently create a "View"
    saveNamedView(trimmed, getCameraSnapshot);
    setNewName('');
  };

  return (
    <div className="named-views" aria-label="Named camera views" role="group">
      <button
        type="button"
        className={`vp-btn${namedViews.length > 0 ? '' : ' vp-btn--icon'}${isExpanded ? ' vp-btn--toggled' : ''}`}
        onClick={() => setIsExpanded((expanded) => !expanded)}
        aria-expanded={isExpanded}
        aria-controls="named-views-panel"
        aria-label={`Views${namedViews.length > 0 ? ` (${namedViews.length})` : ''}`}
        title="Named views"
      >
        <Icon name="bookmark" size={14} />
        {namedViews.length > 0 && <span className="vp-count">{namedViews.length}</span>}
      </button>

      {isExpanded && (
        <div
          id="named-views-panel"
          className="vp-popover named-views-panel"
          role="region"
          aria-label="Named views panel"
        >
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

          {namedViews.length > 0 ? (
            <ul className="named-views-list" role="list" aria-label="Saved views">
              {namedViews.map((view) => (
                <li key={view.id} className="named-views-item">
                  <button
                    type="button"
                    className="named-views-restore-btn"
                    onClick={() => restoreNamedView(view.id, placeCamera)}
                    title={`Restore view: ${view.name}`}
                    aria-label={`Restore view ${view.name}`}
                  >
                    {view.name}
                  </button>
                  <button
                    type="button"
                    className="named-views-delete-btn"
                    onClick={() => deleteNamedView(view.id)}
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
