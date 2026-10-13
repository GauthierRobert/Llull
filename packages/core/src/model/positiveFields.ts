/**
 * Numeric entity fields that must be finite and > 0, per entity kind: the single table behind the
 * load-time guard (persistence/guards) and the model check (inspect/check_model).
 */

export const POSITIVE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  cylinder: ['radius', 'height'],
  cone: ['radius', 'height'],
  sphere: ['radius'],
  torus: ['ringRadius', 'tubeRadius'],
  pyramid: ['baseWidth', 'baseDepth', 'height'],
  arc: ['radius'],
  circle: ['radius'],
  extrusion: ['depth'],
  rectangle: ['width', 'height'],
  ellipse: ['radiusX', 'radiusY'],
  text: ['height'],
  image: ['width', 'height', 'pixelWidth', 'pixelHeight'],
};
