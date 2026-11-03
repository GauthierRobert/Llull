// Saved viewpoints and redlines: save the live camera (save_viewpoint), go to one (apply_viewpoint), pick the viewpoint redlines are drawn on,
// the redline tool in hand (line / arrow / cloud / text, drawn by the viewport layer) and the markups of that viewpoint (delete_markup).

import React, { useState } from 'react';
import type { ReviewModel } from '@core/model/review';
import { PanelSection } from '@ui/panels/PanelParts';
import { useStore } from '@ui/store';
import { REDLINE_TOOLS, type RedlineTool, useRedlineStore } from '@ui/store/redlineStore';
import { getCameraSnapshot } from '@ui/viewport/3d/cameraBridge';
import { viewpointCameraParams } from '@ui/viewport/3d/viewpointParams';

const TOOL_LABEL: Readonly<Record<RedlineTool, string>> = { line: 'Line', arrow: 'Arrow', cloud: 'Cloud', text: 'Text' };

export function ViewpointsSection({ review }: { review: ReviewModel | undefined }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const { tool, colour, viewpointId } = useRedlineStore();
  const [name, setName] = useState('');
  const viewpoints = (review?.viewpointOrder ?? []).flatMap((id) => (review?.viewpoints[id] === undefined ? [] : [review.viewpoints[id]]));
  const markups = Object.values(review?.markups ?? {}).filter((markup) => markup.viewpointId === viewpointId);

  const save = (): void => {
    const snapshot = getCameraSnapshot();
    const camera = snapshot === null ? null : viewpointCameraParams(snapshot);
    if (name.trim() === '' || camera === null) return;
    const section = review?.activeSectionBoxId;
    dispatch('save_viewpoint', { name: name.trim(), camera, ...(section === undefined ? {} : { sectionBoxId: section }) });
    setName('');
  };

  return (
    <PanelSection
      title="Viewpoints and redlines"
      count={viewpoints.length}
      countLabel={`${viewpoints.length} viewpoints`}
      testId="review-viewpoints"
    >
      <div className="issue-form">
        <input
          type="text"
          className="field__input"
          value={name}
          placeholder="Name this view…"
          aria-label="Viewpoint name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && save()}
        />
        <button type="button" className="btn btn--sm" disabled={name.trim() === ''} onClick={save}>
          Save view
        </button>
      </div>
      <ul className="panel__list" aria-label="Viewpoints">
        {viewpoints.map((viewpoint) => (
          <li key={viewpoint.id} className={`panel__row${viewpointId === viewpoint.id ? ' panel__row--selected' : ''}`}>
            <button
              type="button"
              className="building-row-btn"
              aria-pressed={viewpointId === viewpoint.id}
              aria-label={`Go to ${viewpoint.name}`}
              onClick={() => {
                dispatch('apply_viewpoint', { id: viewpoint.id });
                useRedlineStore.getState().setViewpointId(viewpoint.id);
              }}
            >
              <span className="panel__row-main">{viewpoint.name}</span>
              <span className="panel__row-meta">{viewpoint.id}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="redline-tools" role="group" aria-label="Redline tools">
        {REDLINE_TOOLS.map((value) => (
          <button
            key={value}
            type="button"
            className={`btn btn--sm ${tool === value ? 'btn--primary' : 'btn--ghost'}`}
            aria-pressed={tool === value}
            disabled={viewpointId === null}
            onClick={() => useRedlineStore.getState().setTool(tool === value ? null : value)}
          >
            {TOOL_LABEL[value]}
          </button>
        ))}
        <input
          type="color"
          className="redline-tools__colour"
          value={colour}
          aria-label="Redline colour"
          onChange={(event) => useRedlineStore.getState().setColour(event.target.value)}
        />
      </div>
      <p className="panel__row-meta">
        {viewpointId === null
          ? 'Go to a viewpoint to draw on it. Redlines belong to the view they are drawn in.'
          : `Drawing on ${review?.viewpoints[viewpointId]?.name ?? viewpointId}: keep the camera where the view was saved.`}
      </p>
      {viewpointId !== null && (
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => useRedlineStore.setState({ viewpointId: null, tool: null })}
        >
          Hide redlines
        </button>
      )}
      <ul className="panel__list" aria-label="Redlines">
        {markups.map((markup) => (
          <li key={markup.id} className="panel__row">
            <span className="panel__swatch" style={{ background: markup.colour }} aria-hidden="true" />
            <span className="panel__row-main">
              {markup.shape}
              {markup.text === undefined ? '' : `: ${markup.text}`}
            </span>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              aria-label={`Delete markup ${markup.id}`}
              onClick={() => dispatch('delete_markup', { id: markup.id })}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </PanelSection>
  );
}
