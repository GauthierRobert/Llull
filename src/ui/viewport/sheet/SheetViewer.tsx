// Paper-space viewer: the open sheet's SVG (`export_sheet_svg`, recomputed per document) on a neutral desk, pan / zoom / fit,
// dimensions toggle, SVG download, click-to-select a view. Read-only: it never changes the document.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import '@ui/styles/panels/sheets.css';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { Icon } from '@ui/components/Icon';
import { IconButton } from '@ui/panels/PanelParts';
import { QueryDownloadButton } from '@ui/panels/QueryDownloadButton';
import { runQuery } from '@ui/services/localQuery';
import { useSheetViewStore } from './sheetViewStore';
import { type PaperTransform, fitTransform, readSheetExport, screenToPaper, viewAtPaperPoint, zoomAt } from './sheetData';

const WHEEL_ZOOM_PER_NOTCH = 1.0015;
const DRAG_THRESHOLD_PX = 4;
/** Fallback when the layout is unmeasurable (tests). */
const DEFAULT_VIEWPORT: readonly [number, number] = [900, 600];

const svgDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export function SheetViewer(): React.ReactElement | null {
  const sheetId = useSheetViewStore((s) => s.openSheetId);
  const document = useDocumentWithoutSelection();
  const sheet = sheetId === null ? undefined : document.drawings?.sheets[sheetId];
  const showDimensions = useSheetViewStore((s) => s.showDimensions);
  const selectedViewId = useSheetViewStore((s) => s.selectedViewId);
  const { closeSheet, selectView, setShowDimensions } = useSheetViewStore.getState();

  // The document is immutable: its identity is the cache key of the derived SVG.
  const exported = useMemo(
    () => (sheet === undefined ? null : readSheetExport(runQuery('export_sheet_svg', { sheetId: sheet.id, showDimensions }).data)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sheet` is derived from `document`; `runQuery` reads the same document
    [document, sheet?.id, showDimensions],
  );
  const url = useMemo(() => (exported === null ? '' : svgDataUrl(exported.svg)), [exported]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const [transform, setTransform] = useState<PaperTransform>({ x: 0, y: 0, k: 1 });
  const [status, setStatus] = useState('');
  const drag = useRef<{ startX: number; startY: number; origin: PaperTransform; moved: boolean } | null>(null);
  const paper = exported === null ? null : ([exported.widthMm, exported.heightMm] as const);
  const paperW = paper?.[0];
  const paperH = paper?.[1];

  const fit = (): void => {
    if (paperW === undefined || paperH === undefined) return;
    const rect = stageRef.current?.getBoundingClientRect();
    const [w, h] = rect !== undefined && rect.width > 0 ? [rect.width, rect.height] : DEFAULT_VIEWPORT;
    setTransform(fitTransform(w, h, paperW, paperH));
  };

  useLayoutEffect(fit, [sheetId, paperW, paperH]);

  useEffect(() => {
    if (sheetId !== null && sheet === undefined) closeSheet();
  }, [sheetId, sheet, closeSheet]);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const factor = WHEEL_ZOOM_PER_NOTCH ** -event.deltaY;
      setTransform((current) => zoomAt(current, factor, event.clientX - rect.left, event.clientY - rect.top));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [sheet === undefined]); // eslint-disable-line react-hooks/exhaustive-deps -- the stage mounts once a sheet is open

  if (sheet === undefined) return null;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = { startX: event.clientX, startY: event.clientY, origin: transform, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (state === null) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    state.moved = true;
    setTransform({ ...state.origin, x: state.origin.x + dx, y: state.origin.y + dy });
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    drag.current = null;
    if (state === null || state.moved || exported === null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const [x, y] = screenToPaper(transform, event.clientX - rect.left, event.clientY - rect.top);
    selectView(viewAtPaperPoint(exported.views, x, y));
  };

  const selectedBounds = exported?.views.find((view) => view.id === selectedViewId)?.bounds;
  const { k } = transform;

  return (
    <div className="sheet-viewer" role="region" aria-label={`Drawing sheet ${sheet.name}`} data-testid="sheet-viewer">
      <div className="sheet-viewer__bar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={closeSheet} data-testid="sheet-close" title="Back to the model">
          <Icon name="arrowLeft" size={12} />
          Model
        </button>
        <span className="sheet-viewer__name" title={sheet.name}>
          {sheet.name}
        </span>
        {exported !== null && (
          <span className="chip chip--accent" data-testid="sheet-scale">
            {exported.paper} {exported.scaleText}
          </span>
        )}
        {exported !== null && !exported.fits && (
          <span
            className="chip chip--warning"
            role="status"
            data-testid="sheet-fits-warning"
            title={
              exported.warnings.length > 0
                ? exported.warnings.join(' ')
                : 'Views overflow the drawing area; use a smaller scale or larger paper.'
            }
          >
            Views overflow the sheet
          </span>
        )}
        {exported !== null && exported.warnings.length > 0 && (
          <details className="sheet-viewer__warnings" data-testid="sheet-warnings">
            <summary className="chip chip--warning">
              <Icon name="info" size={12} />
              {exported.warnings.length === 1 ? '1 warning' : `${exported.warnings.length} warnings`}
            </summary>
            <ul role="status" aria-label="Sheet warnings">
              {exported.warnings.map((warning) => (
                <li key={warning}>Warning: {warning}</li>
              ))}
            </ul>
          </details>
        )}
        <span className="sheet-viewer__spacer" />
        <label className="sheet-viewer__toggle" title="Overall width and height on each projection view">
          <input type="checkbox" checked={showDimensions} onChange={(event) => setShowDimensions(event.target.checked)} />
          Dimensions
        </label>
        <IconButton icon="fit" label="Fit sheet to window" testId="sheet-fit" onClick={fit} />
        <QueryDownloadButton
          label="Download SVG"
          command="export_sheet_svg"
          params={{ sheetId: sheet.id, showDimensions }}
          field="svg"
          fallbackName={`${sheet.name}.svg`}
          mimeType="image/svg+xml"
          onStatus={setStatus}
        />
      </div>
      <div
        ref={stageRef}
        className="sheet-viewer__stage"
        data-testid="sheet-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
      >
        {exported === null || paper === null ? (
          <p className="sheet-viewer__empty">This sheet could not be rendered.</p>
        ) : (
          <div className="sheet-viewer__paper" style={{ left: transform.x, top: transform.y, width: paper[0] * k, height: paper[1] * k }}>
            <img src={url} alt={`${sheet.name} drawing`} draggable={false} data-testid="sheet-image" />
            {selectedBounds !== undefined && (
              <div
                className="sheet-viewer__selection"
                data-testid="sheet-selection"
                style={{
                  left: selectedBounds[0] * k,
                  top: selectedBounds[1] * k,
                  width: (selectedBounds[2] - selectedBounds[0]) * k,
                  height: (selectedBounds[3] - selectedBounds[1]) * k,
                }}
              />
            )}
          </div>
        )}
      </div>
      {status !== '' && (
        <p className="sheet-viewer__status" role="status">
          {status}
        </p>
      )}
    </div>
  );
}
