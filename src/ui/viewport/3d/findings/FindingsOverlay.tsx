// Severity badges at the location of each Review finding (failing and warning ones) while the Review panel has results and
// "Mark findings on the model" is on. Pure DOM pills anchored in the floating-origin group; the clicked finding gets its beacon from FocusOverlay.

import React, { useMemo } from 'react';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { useReviewStore } from '@ui/panels/review/reviewStore';
import { flattenFindings } from '@ui/panels/review/findings';
import { SEVERITY_COLORS, findingLocation } from '@ui/panels/review/findingLocations';
import { STATUS_GLYPH } from '@ui/panels/review/checklist';
import { ProjectedLabel } from '../ProjectedLabel';
import { findingTitle } from '@ui/panels/review/checklist';

/** Badges drawn at most (the list holds the rest). */
const MAX_BADGES = 60;

export function FindingsOverlay(): React.ReactElement | null {
  const document = useDocumentWithoutSelection();
  const result = useReviewStore((s) => s.result);
  const shown = useReviewStore((s) => s.markersShown);
  const badges = useMemo(
    () =>
      result === null
        ? []
        : flattenFindings(result.checks)
            .filter(({ item }) => item.status === 'fail' || item.status === 'warn')
            .map((finding) => findingLocation(document, finding))
            .filter((location) => location.position !== null)
            .slice(0, MAX_BADGES),
    [result, document],
  );
  if (!shown || badges.length === 0) return null;
  return (
    <group name="review-findings">
      {badges.map((badge) =>
        badge.position === null ? null : (
          <ProjectedLabel
            key={badge.findingKey}
            position={badge.position}
            text={`${STATUS_GLYPH[badge.status]} ${findingTitle(badge.code)}`}
            className="load-label"
            borderColor={SEVERITY_COLORS[badge.status]}
            opacity={0.95}
            testId={`finding-badge-${badge.findingKey}`}
          />
        ),
      )}
    </group>
  );
}
