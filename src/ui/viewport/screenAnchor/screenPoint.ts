// Pure NDC -> CSS-pixel mapping for DOM labels anchored to a world point.

export interface ScreenPoint {
  x: number;
  y: number;
  /** False when the point is behind the camera or outside the clip volume's depth range. */
  visible: boolean;
}

/** NDC (x, y, z in [-1, 1]) to pixels from the canvas top-left; hidden when the depth is outside the frustum. */
export function ndcToScreenPoint(ndcX: number, ndcY: number, ndcZ: number, width: number, height: number): ScreenPoint {
  return { x: (ndcX * 0.5 + 0.5) * width, y: (-ndcY * 0.5 + 0.5) * height, visible: Number.isFinite(ndcZ) && ndcZ >= -1 && ndcZ <= 1 };
}

/** CSS transform placing an element's top-left (or centre) on the point. */
export function anchorTransform(point: ScreenPoint, centered: boolean): string {
  return `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)${centered ? ' translate(-50%, -50%)' : ''}`;
}
