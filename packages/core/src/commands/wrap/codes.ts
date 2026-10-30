/** Stable error and finding codes of the wrap / emboss / font commands (03 WRP TECHNICAL_SPEC §7.1) with their one-line fixes. */

import { tableRejection } from '../noop';

export const WRAP_REMEDIATION: Readonly<Record<string, string>> = {
  WRP_ENTITY_NOT_FOUND: 'Run `llull describe_scene` to list entity ids.',
  WRP_NOT_A_SOLID: 'Pass the id of a 3D solid (a primitive, extrusion or kernel result).',
  WRP_FACE_NOT_FOUND: 'Re-pick with `faceNear` on the intended face (`inspect_faces` lists faces and samples).',
  REF_LOST: 'Re-pick with `faceNear` on the intended face (`inspect_faces` lists faces and samples).',
  WRP_FACE_NOT_DEVELOPABLE:
    'Only plane, cylinder and cone faces develop without stretch; a sphere or torus needs method geodesic or parametric (read data.distortion).',
  WRP_METHOD_UNAVAILABLE:
    'Use method develop, geodesic or parametric on a plane, cylinder, cone, sphere or torus face; freeform (B-spline) faces have no chart yet, and method project is project_to_face.',
  WRP_GEODESIC_FAILED:
    'Pick points closer together (a quarter great circle at most on a sphere), not through the cone apex, or use mode "uv" with intermediate points.',
  WRP_SPLIT_CURVE_NOT_ON_FACE:
    'Make the curves with project_to_face, wrap_to_face or create_curve_on_face on this solid, and keep each on one face.',
  WRP_SPLIT_NO_EFFECT: 'Use closed curves, or open curves that run from edge to edge of the face.',
  WRP_SPLIT_FIT_FAILED: 'Split the curve in shorter pieces, or raise the tolerance.',
  WRP_ANCHOR_OFF_FACE: 'Give a point on the face for placement.anchor.on (`inspect_faces` samples) or omit it.',
  WRP_OUTSIDE_FACE: 'Move the anchor, rotate, or scale the sketch so every loop stays on the trimmed face.',
  WRP_WRAP_OVERLAP: 'Shrink the sketch below data.fullWrapChartWidth (the circumference of the face, or the sector of a cone).',
  WRP_PROFILE_OPEN: 'Close the profile, or use mode "scribe" for open curves.',
  WRP_PROFILE_SELF_INTERSECT: 'Fix the sketch so no loop crosses itself or another loop; text loops are united automatically.',
  WRP_PROFILE_EMPTY: 'Give closed 2D profiles (rectangle, circle, ellipse, closed polyline / spline, or text with a font).',
  WRP_DEPTH_INVALID: 'Give depth > 0 in document units.',
  WRP_DEPTH_EXCEEDS_SOLID: 'Reduce depth below data.maxDepth (the radius of the face).',
  WRP_DISTORTION_EXCEEDED: 'Use a smaller sketch or another anchor, or raise maxLengthStrain with the owner consent.',
  WRP_PROJECTION_MISSES_FACE: 'Change `direction` or move the sketch plane so the curves face the solid.',
  WRP_KERNEL_BUILD_FAILED: 'Simplify the profile, reduce depth, or report the document (the exact kernel refused the construction).',
  WRP_FONT_UNAVAILABLE: 'Run `list_fonts`, then `import_font` for a font that is not listed.',
  WRP_FONT_PARSE: 'Give a TrueType (.ttf), CFF OpenType (.otf) or CFF2 variable font file.',
  WRP_FONT_FORMAT_UNSUPPORTED: 'Use a TrueType (.ttf), CFF-outline OpenType (.otf) or CFF2 font; WOFF and collections are not supported.',
  WRP_FONT_VARIATION:
    'Name only axes the font has (import_font returns data.axes with tag, min, default, max), keep each value inside its range, and use a CFF2 variable font: TrueType (gvar) fonts only have their default instance.',
  WRP_FONT_EMBEDDING_RESTRICTED: 'Use a font licensed for embedding (the bundled fonts are SIL OFL).',
  WRP_FONT_TOO_LARGE: 'Subset the font to under 4 MB, or use a bundled one.',
  WRP_CHAIN_FACE_UNSUPPORTED:
    'Chain only plane and cylinder faces (they unfold without stretch); cones, spheres and tori have no isometric chart across an edge: wrap each face separately.',
  WRP_CHAIN_NOT_ADJACENT:
    'List the faces of the chain so that each shares an edge with the faces before it (inspect_faces / inspect_topology show the adjacency).',
  WRP_CHAIN_EDGE_CURVED:
    'Only an edge that develops to a straight line on both faces joins them (a generatrix of a cylinder, a straight edge of a plane); leave out the face across a circular edge, or wrap each face separately.',
  WRP_CHAIN_EDGE_SHARP:
    'Raised walls cannot meet along a sharp edge without a mitre: blend or round the edge first (fillet_edge), or emboss each face separately; wrap_to_face and scribe cross sharp edges.',
  WRP_CHAIN_CLIP_FAILED:
    'The sketch outline touches a chain edge tangentially or the kernel could not orient it: move the sketch slightly (placement.anchor) or turn it (placement.angleDeg).',
  WRP_TEXT_NO_FONT: 'Set `font` on the text (`edit_step_params` on its add_text step, or add_text with `font`).',
  WRP_TEXT_TOO_LONG: 'Split the text; outline text is limited to 2000 characters per entity.',
  WRP_PARAM_INVALID: 'Fix the named parameter; see `llull describe <command>`.',
  WRP_GLYPH_MISSING: 'Choose a font that covers the characters.',
  WRP_CHECK_DISTORTION: 'Use a smaller sketch or another anchor, or raise maxLengthStrain with the owner consent.',
  WRP_CHECK_OUTSIDE_FACE: 'Move the anchor, rotate, or scale the sketch so every loop stays on the trimmed face.',
  WRP_CHECK_THIN_FEATURE: 'Thicken the strokes (a bolder font or a larger height) or lower minFeatureSize if the process allows.',
  WRP_CHECK_DEPTH: 'Reduce the deboss depth below the radius of the face.',
  WRP_CHECK_VOLUME_MISMATCH:
    'The kernel volume disagrees with the closed form: rebuild the emboss with a smaller fitTolerance, or report the document.',
  WRP_CHECK_GLYPH_MISSING: 'Choose a font that covers the characters of the text.',
  WRP_CHECK_FONT_UNVERIFIED: 'Pin the font file: import_font with sourceSha256 set to the sha256 of the file you trust.',
  WRP_CHECK_STROKE_SKIPPED:
    'The stroke width is measured on plane and cylinder faces only; inspect the strokes of cone, sphere and torus embosses by hand or with a sketch on a plane.',
  WRP_CHECK_LIMIT_DEFAULTED: 'Pass the limit explicitly (maxLengthStrain) once the owner has named it.',
};

export const wrapRejection = tableRejection(WRAP_REMEDIATION);
