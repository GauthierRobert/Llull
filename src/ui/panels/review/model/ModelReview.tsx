// Model review sections of the Review tab: issues (with comments and the signed status flow), viewpoints and redlines, section box and colour
// profile. The document's `review` / `display` slices are read here; every change is a command.

import React from 'react';
import { useStore } from '@ui/store';
import { DisplaySection } from './DisplaySection';
import { IssuesSection } from './IssuesSection';
import { ViewpointsSection } from './ViewpointsSection';

export function ModelReview(): React.ReactElement {
  const document = useStore((s) => s.document);
  return (
    <div className="model-review" data-testid="model-review">
      <IssuesSection review={document.review} />
      <ViewpointsSection review={document.review} />
      <DisplaySection document={document} />
    </div>
  );
}
