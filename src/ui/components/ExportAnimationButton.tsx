// Opens the "Export animation…" dialog (mounted once in App).

import React from 'react';
import { useAnimationExportStore } from '@ui/store/animationExportStore';

export function ExportAnimationButton({ testId = 'export-animation-open' }: { testId?: string }): React.ReactElement {
  const setOpen = useAnimationExportStore((s) => s.setOpen);
  return (
    <button
      type="button"
      className="btn btn--sm btn--ghost"
      onClick={() => setOpen(true)}
      title="Render the motion to an MP4, GIF or APNG file"
      data-testid={testId}
    >
      Export animation…
    </button>
  );
}
