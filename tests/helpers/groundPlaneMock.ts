import type { Vec2 } from '@core/model/types';

type Handlers = Record<string, (event: unknown) => void>;

/** `vi.mock` factory result for `@ui/viewport/2d/GroundPlane`: captures the handler props it is given. */
export function groundPlaneMock(captured: { handlers: Handlers }): {
  GroundPlane: (props: Handlers) => null;
  toDocumentPoint: (hit: { x: number; y: number }) => Vec2;
} {
  return {
    GroundPlane: (props) => {
      captured.handlers = props;
      return null;
    },
    toDocumentPoint: (hit) => [hit.x, hit.y],
  };
}
