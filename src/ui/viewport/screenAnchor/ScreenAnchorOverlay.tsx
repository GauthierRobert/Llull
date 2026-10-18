// DOM half of the screen anchors: sits over the Canvas (inside the viewport wrapper) and renders each label; its
// position is written per frame by the matching in-Canvas <ScreenAnchor>.

import { registerAnchorElement, useScreenAnchorStore } from './screenAnchorStore';

export function ScreenAnchorOverlay(): React.ReactElement {
  const anchors = useScreenAnchorStore((s) => s.anchors);
  return (
    <div className="screen-anchors">
      {Object.values(anchors).map((anchor) => (
        <div
          key={anchor.id}
          ref={(element) => registerAnchorElement(anchor.id, element)}
          className={`screen-anchor ${anchor.className}`.trim()}
          style={{ zIndex: anchor.zIndex }}
        >
          {anchor.content}
        </div>
      ))}
    </div>
  );
}
