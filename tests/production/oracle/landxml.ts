/**
 * @layer tests/production/oracle
 *
 * Independent LandXML 1.2 reader for issued civil exchange files: well-formedness (every element
 * closed in order, one root) and what Civil 3D / 12d import — CgPoints, TIN surfaces, alignments
 * (spirals, profile) and the pipe network (structures, pipes with their slope attribute).
 */

export interface LandXmlSummary {
  errors: string[];
  cgPoints: number;
  surfaces: { name: string; points: number; faces: number }[];
  alignments: { name: string; lines: number; curves: number; spirals: number; profile: boolean }[];
  structs: number;
  pipes: { name: string; slope: number; diameterMm: number }[];
}

const attribute = (tag: string, name: string): string =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? '';

/** Tag-balance check: every start tag closed by its matching end tag, a single root element. */
function wellFormedness(xml: string): string[] {
  const errors: string[] = [];
  if (!/^\s*<\?xml[^>]*\?>/.test(xml)) errors.push('no XML declaration');
  const stack: string[] = [];
  let roots = 0;
  const body = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const match of body.matchAll(/<(\/?)([A-Za-z_][\w.-]*)\b[^>]*?(\/?)>/g)) {
    const [, closing, name = '', selfClosing] = match;
    if (closing === '/') {
      const open = stack.pop();
      if (open !== name) {
        errors.push(`</${name}> closes <${open ?? 'nothing'}>`);
        break;
      }
    } else if (selfClosing !== '/') {
      if (stack.length === 0) roots++;
      stack.push(name);
    } else if (stack.length === 0) roots++;
  }
  if (stack.length > 0) errors.push(`unclosed <${stack.join('> <')}>`);
  if (roots !== 1) errors.push(`${roots} root elements`);
  if (!/^\s*(<\?xml[^>]*\?>\s*)<LandXML\b/.test(xml)) errors.push('root is not <LandXML>');
  return errors;
}

function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'g'))].map(
    (match) => match[0],
  );
}

export function parseLandXml(xml: string): LandXmlSummary {
  if (xml.trim() === '') {
    return {
      errors: ['empty file'],
      cgPoints: 0,
      surfaces: [],
      alignments: [],
      structs: 0,
      pipes: [],
    };
  }
  const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;
  return {
    errors: wellFormedness(xml),
    cgPoints: count(xml, /<CgPoint\b/g),
    surfaces: blocks(xml, 'Surface').map((surface) => ({
      name: attribute(surface, 'name'),
      points: count(surface, /<P\b/g),
      faces: count(surface, /<F\b/g),
    })),
    alignments: blocks(xml, 'Alignment').map((alignment) => ({
      name: attribute(alignment, 'name'),
      lines: count(alignment, /<Line\b/g),
      curves: count(alignment, /<Curve\b/g),
      spirals: count(alignment, /<Spiral\b/g),
      profile: /<ProfAlign\b/.test(alignment),
    })),
    structs: count(xml, /<Struct\b/g),
    pipes: blocks(xml, 'Pipe').map((pipe) => ({
      name: attribute(pipe, 'name'),
      slope: Number(attribute(pipe, 'slope')),
      diameterMm: Number(attribute(/<CircPipe\b[^>]*>/.exec(pipe)?.[0] ?? '', 'diameter')),
    })),
  };
}
