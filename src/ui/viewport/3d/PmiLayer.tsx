// Semantic PMI drawn in the 3D viewport on each item's annotation plane: a label at the frame anchor and a leader to the feature.
// Presentation only: the items are document data written by commands; the layer reads `document.pmi` and the active saved view.

import React from 'react';
import { Line } from '@react-three/drei';
import { frameAnchor } from '@core/geometry/pmiPlacement';
import { pmiText } from '@core/geometry/pmiText';
import type { PmiItem } from '@core/model/pmi';
import { useStore } from '@ui/store';
import { ScreenAnchor } from '../screenAnchor/ScreenAnchor';
import { usePmiViewStore, visiblePmiItems } from './pmiViewStore';

const LEADER_COLOR = '#d97706';

function PmiMark({ item }: { item: PmiItem }): React.ReactElement {
  const anchor = frameAnchor(item.placement);
  const leader = item.placement.leaderTo;
  return (
    <>
      <ScreenAnchor id={`pmi-${item.id}`} position={anchor} center zIndex={16} className="pmi-anchor">
        <span
          className={`pmi-label pmi-label--${item.kind}${item.review.required ? ' pmi-label--review' : ''}`}
          data-testid={`pmi-label-${item.id}`}
          title={item.review.required ? 'Awaiting review by a qualified engineer' : 'Reviewed'}
        >
          {pmiText(item)}
        </span>
      </ScreenAnchor>
      {leader !== undefined && <Line points={[[...anchor], [...leader]]} color={LEADER_COLOR} lineWidth={1} />}
    </>
  );
}

export function PmiLayer(): React.ReactElement | null {
  const pmi = useStore((s) => s.document.pmi);
  const show = usePmiViewStore((s) => s.showPmi);
  if (!show) return null;
  const items = visiblePmiItems(pmi);
  if (items.length === 0) return null;
  return (
    <group name="pmi-layer">
      {items.map((item) => (
        <PmiMark key={item.id} item={item} />
      ))}
    </group>
  );
}
