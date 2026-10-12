/**
 * Names and colors for STEP text written by a kernel: the kernel transfers each solid as its own
 * product (`Open CASCADE STEP translator <ver> <n>`) in input order, which `labelStep` rewrites to
 * the entity label and tags with a STYLED_ITEM color chain. Text-level on purpose: kernels expose
 * only `exportStep(shapes)`, and the label data lives in the document, not in the shape.
 *
 * @layer core/commands
 * @pure
 * @failure text that is not recognizably kernel STEP, or a product/solid count that does not match
 *   the labels -> that part is left untouched (never throws, never corrupts)
 */

/** What to stamp on the n-th transferred shape. */
export interface StepLabel {
  /** PRODUCT id and name (entity name, else its id). */
  readonly name: string;
  /** PRODUCT description (the entity's group name), when it has one. */
  readonly description?: string;
  /** Hex color "#rrggbb" for the solid's surface style. */
  readonly color?: string;
}

const PRODUCT_PATTERN =
  /PRODUCT\('Open CASCADE STEP translator [\d.]+ (\d+)',\s*'Open CASCADE STEP translator [\d.]+ \1',''/g;
const REPRESENTATION_PATTERN =
  /#(\d+) = (?:ADVANCED_BREP_SHAPE_REPRESENTATION|MANIFOLD_SURFACE_SHAPE_REPRESENTATION|SHAPE_REPRESENTATION)\('',\(([^)]*)\),(#\d+)\);/g;

/** STEP string literal body: quotes and backslashes doubled, non-ASCII as \X2\…\X0\, no control characters. */
export function stepString(text: string): string {
  let out = '';
  let wide = '';
  const flush = (): void => {
    if (wide !== '') out += `\\X2\\${wide}\\X0\\`;
    wide = '';
  };
  for (const char of text.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 126) {
      for (let i = 0; i < char.length; i++) {
        wide += char.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
      }
      continue;
    }
    flush();
    out += char === "'" ? "''" : char === '\\' ? '\\\\' : char;
  }
  flush();
  return out;
}

function rgbOf(hex: string | undefined): [number, number, number] | null {
  if (hex === undefined || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const channel = (offset: number): number =>
    Math.round((parseInt(hex.slice(offset, offset + 2), 16) / 255) * 1000) / 1000;
  return [channel(1), channel(3), channel(5)];
}

/** `#id` numbers of the representation items that are solids/surfaces (not the placement axis). */
function geometryItems(step: string, itemList: string): string[] {
  return itemList
    .split(',')
    .map((ref) => ref.trim())
    .filter((ref) => ref.startsWith('#') && !step.includes(`${ref} = AXIS2_PLACEMENT_3D(`));
}

function named(statement: string, label: StepLabel): string {
  const name = stepString(label.name);
  const description = stepString(label.description ?? '');
  return statement.replace(
    /PRODUCT\('[^']*',\s*'[^']*',''/,
    `PRODUCT('${name}','${name}','${description}'`,
  );
}

/** Append a color chain per distinct color and one STYLED_ITEM per labeled solid. */
function addColors(
  step: string,
  styled: readonly { items: string[]; rgb: [number, number, number] }[],
  context: string,
): string {
  const end = step.lastIndexOf('ENDSEC;');
  if (end < 0 || styled.length === 0) return step;
  let next = Math.max(...[...step.matchAll(/^#(\d+) = /gm)].map((m) => Number(m[1]))) + 1;
  const lines: string[] = [];
  const styleOfColor = new Map<string, number>();
  const allItems: number[] = [];
  for (const { items, rgb } of styled) {
    const key = rgb.join(',');
    let style = styleOfColor.get(key);
    if (style === undefined) {
      const [colour, fillColour, fill, area, side, usage] = [0, 1, 2, 3, 4, 5].map((k) => next + k);
      style = next + 6;
      next += 7;
      lines.push(
        `#${colour} = COLOUR_RGB('',${rgb.map((c) => c.toFixed(3)).join(',')});`,
        `#${fillColour} = FILL_AREA_STYLE_COLOUR('',#${colour});`,
        `#${fill} = FILL_AREA_STYLE('',(#${fillColour}));`,
        `#${area} = SURFACE_STYLE_FILL_AREA(#${fill});`,
        `#${side} = SURFACE_SIDE_STYLE('',(#${area}));`,
        `#${usage} = SURFACE_STYLE_USAGE(.BOTH.,#${side});`,
        `#${style} = PRESENTATION_STYLE_ASSIGNMENT((#${usage}));`,
      );
      styleOfColor.set(key, style);
    }
    for (const item of items) {
      lines.push(`#${next} = STYLED_ITEM('color',(#${style}),${item});`);
      allItems.push(next++);
    }
  }
  lines.push(
    `#${next} = MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${allItems.map((id) => `#${id}`).join(',')}),${context});`,
  );
  return `${step.slice(0, end)}${lines.join('\n')}\n${step.slice(end)}`;
}

/**
 * `step` with the n-th product renamed to `labels[n-1]` (id, name, description), its solids named
 * likewise, and its solids colored. Labels beyond the products found are ignored.
 */
export function labelStep(step: string, labels: readonly StepLabel[]): string {
  const labeled = step.replace(PRODUCT_PATTERN, (statement, ordinal: string) => {
    const label = labels[Number(ordinal) - 1];
    return label === undefined ? statement : named(statement, label);
  });
  const representations = [...labeled.matchAll(REPRESENTATION_PATTERN)];
  if (representations.length !== labels.length) return labeled;
  const styled: { items: string[]; rgb: [number, number, number] }[] = [];
  let withNames = labeled;
  representations.forEach((match, index) => {
    const label = labels[index];
    if (label === undefined) return;
    const items = geometryItems(labeled, match[2] ?? '');
    for (const item of items) {
      withNames = withNames.replace(
        new RegExp(`(${item} = (?:MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS)\\()''`),
        `$1'${stepString(label.name)}'`,
      );
    }
    const rgb = rgbOf(label.color);
    if (rgb !== null && items.length > 0) styled.push({ items, rgb });
  });
  const context = representations[0]?.[3];
  return context === undefined ? withNames : addColors(withNames, styled, context);
}
