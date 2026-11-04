// DOM layer over the 3D canvas: the redlines (document.review.markups) of the viewpoint in `redlineStore`, and the drawing of new ones with
// the active tool. A finished drag / text entry is ONE `add_markup` (screen space, author "human"); the layer holds only the draft.

import React, { useEffect, useRef, useState } from 'react';
import type { Markup } from '@core/model/review';
import type { Vec2 } from '@core/model/vectors';
import { useStore } from '@ui/store';
import { type RedlineTool, useRedlineStore } from '@ui/store/redlineStore';
import { arrowBarbs, cloudPath, markupPoints, pointsAttribute, toNormalised } from './markupDraw';

const DRAFT_COLOUR_WIDTH = 2;

interface Drag {
  readonly tool: RedlineTool;
  readonly from: Vec2;
  to: Vec2;
}

function MarkupShape({ markup, width, height }: { markup: Markup; width: number; height: number }): React.ReactElement | null {
  if (markup.space !== 'screen') return null;
  const points = markup.points.filter((point): point is Vec2 => point.length === 2);
  const stroke = { stroke: markup.colour, strokeWidth: markup.lineWidthPx ?? DRAFT_COLOUR_WIDTH, fill: 'none' };
  const first = points[0];
  if (first === undefined) return null;
  const anchor = [first[0] * width, first[1] * height] as const;
  switch (markup.shape) {
    case 'text':
      return (
        <text x={anchor[0]} y={anchor[1]} fill={markup.colour} className="redline__text">
          {markup.text}
        </text>
      );
    case 'cloud':
      return <path d={cloudPath(points, width, height)} {...stroke} strokeLinejoin="round" />;
    case 'arrow': {
      const head = points[1];
      if (head === undefined) return null;
      const [left, right] = arrowBarbs(first, head, width, height);
      return (
        <g {...stroke} strokeLinecap="round">
          <polyline points={pointsAttribute(points, width, height)} />
          <polyline points={`${left[0]},${left[1]} ${head[0] * width},${head[1] * height} ${right[0]},${right[1]}`} />
        </g>
      );
    }
    case 'ellipse': {
      const corner = points[1];
      if (corner === undefined) return null;
      return (
        <ellipse
          cx={((first[0] + corner[0]) / 2) * width}
          cy={((first[1] + corner[1]) / 2) * height}
          rx={(Math.abs(corner[0] - first[0]) / 2) * width}
          ry={(Math.abs(corner[1] - first[1]) / 2) * height}
          {...stroke}
        />
      );
    }
    default:
      return <polyline points={pointsAttribute(points, width, height)} {...stroke} strokeLinecap="round" strokeLinejoin="round" />;
  }
}

export function MarkupOverlay(): React.ReactElement | null {
  const tool = useRedlineStore((s) => s.tool);
  const colour = useRedlineStore((s) => s.colour);
  const viewpointId = useRedlineStore((s) => s.viewpointId);
  const markups = useStore((s) => s.document.review?.markups);
  const dispatch = useStore((s) => s.dispatch);
  const surface = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [textAt, setTextAt] = useState<Vec2 | null>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });

  const visible = viewpointId !== null || tool !== null;
  // Keeps the SVG pixel size in step with the viewport it covers.
  useEffect(() => {
    const element = surface.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  const shown = viewpointId === null ? [] : Object.values(markups ?? {}).filter((markup) => markup.viewpointId === viewpointId);
  if (!visible) return null;

  const pointOf = (event: React.PointerEvent): Vec2 | null => {
    const rect = surface.current?.getBoundingClientRect();
    if (rect === undefined) return null;
    return toNormalised(event.clientX, event.clientY, rect);
  };
  const add = (shape: RedlineTool, points: Vec2[], text?: string): void => {
    if (viewpointId === null) return;
    dispatch('add_markup', {
      viewpointId,
      shape,
      space: 'screen',
      points,
      colour,
      author: 'human',
      ...(text === undefined ? {} : { text }),
    });
  };

  const onPointerDown = (event: React.PointerEvent): void => {
    if (tool === null || viewpointId === null) return;
    const point = pointOf(event);
    if (point === null) return;
    if (tool === 'text') return setTextAt(point);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ tool, from: point, to: point });
  };
  const onPointerMove = (event: React.PointerEvent): void => {
    if (drag === null) return;
    const point = pointOf(event);
    if (point !== null) setDrag({ ...drag, to: point });
  };
  const onPointerUp = (event: React.PointerEvent): void => {
    if (drag === null) return;
    const point = pointOf(event) ?? drag.to;
    setDrag(null);
    const points = markupPoints(drag.tool, drag.from, point);
    if (points !== null) add(drag.tool, points);
  };

  const draftPoints = drag === null ? null : markupPoints(drag.tool, drag.from, drag.to);
  const { width, height } = size;
  return (
    <div
      ref={surface}
      className={`redline${tool === null ? '' : ' redline--drawing'}`}
      data-testid="redline-surface"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <svg className="redline__svg" width="100%" height="100%" aria-hidden="true">
        {shown.map((markup) => (
          <MarkupShape key={markup.id} markup={markup} width={width} height={height} />
        ))}
        {drag !== null && draftPoints !== null && (
          <MarkupShape
            markup={{
              id: 'draft',
              viewpointId: viewpointId ?? '',
              shape: drag.tool,
              space: 'screen',
              points: draftPoints,
              colour,
              author: 'human',
            }}
            width={width}
            height={height}
          />
        )}
      </svg>
      {textAt !== null && (
        <input
          className="redline__input"
          autoFocus
          aria-label="Redline text"
          placeholder="Note…"
          style={{ left: `${textAt[0] * 100}%`, top: `${textAt[1] * 100}%`, color: colour }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setTextAt(null);
            if (event.key !== 'Enter') return;
            const text = event.currentTarget.value.trim();
            if (text !== '') add('text', [textAt], text);
            setTextAt(null);
          }}
          onBlur={() => setTextAt(null)}
        />
      )}
    </div>
  );
}
