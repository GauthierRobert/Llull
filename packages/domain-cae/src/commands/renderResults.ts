/** render_fea_results: read-only contour plot of a solved analysis (stress, displacement, temperature, heat flux) as an SVG image. */

import { defineCommand } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { fieldPlotSvg } from '../results/fieldPlotSvg';
import { fieldPlotRequest, NAME, renderParams } from '../results/plotRequest';

/**
 * @invariant read-only; values come from the verified results artifact (trustedRecord), never from the recorded summary; the plot is a
 *   z-buffered raster (nearest face per pixel, value interpolated per pixel) of the outer skin of the plotted parts, deformed by
 *   DISP × deformationScale (auto: the largest displacement drawn at 8 % of the model size); `cut` removes the half-space on the normal's
 *   side of the undeformed mesh and paints the section of every crossed tet; min / max are over the plotted (kept) nodes
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not solved / artifacts unavailable -> FEA_RESULTS_MISSING; field absent -> FEA_FIELD_MISSING;
 *   unknown entityId, zero cut normal / axis direction -> FEA_PLOT_INVALID
 */
export const renderFeaResults = defineCommand({
  name: NAME,
  description:
    'Render the solved results of an analysis as a contour plot an engineer (or you) can LOOK at: an SVG image (embedded z-buffered raster, ' +
    'parts hide each other correctly) of the outer skin of the meshed parts coloured by a field in 12 crisp bands (blue = low, red = high) ' +
    'with a colour legend in the analysis units, the MAX / MIN locations, supports (cyan dots), loads (magenta dots + arrow) and thermal ' +
    'BCs (orange dots; dots are drawn only where visible), on the deformed shape (structural fields; the scale is printed in the ' +
    'subtitle) over a faint silhouette of the undeformed part. field: von_mises (default for static / thermo-mechanical), u_mag, u_x, ' +
    'u_y, u_z, s_xx, s_yy, s_zz, temperature (default for heat_*), heat_flux, and cylindrical components about an axis (axisPoint + ' +
    'axisDirection, default: the z axis through the centre of the plotted parts bounding box; a quarter / half model needs the real axis ' +
    'point): s_hoop, s_radial, s_axial, u_radial. modal / buckling cases: field mode (default) colours the displacement magnitude of the mode ' +
    'shape normalised to 1 (it has no unit; mode = which mode, 1-based, default 1; the subtitle gives its frequency in Hz or its buckling ' +
    'factor; the shape is drawn deformed with the automatic scale because mode amplitudes are arbitrary); stress fields do not exist for them. To see an interior peak (e.g. under a PCB): cut = { normal, offset } removes the ' +
    'half-space dot(normal, p) > offset of the undeformed model and colours the section face by the field; entityIds plots only those ' +
    'parts (min / max and the colour range then refer to the plotted parts). With surface: true also data.surface { positions (flat xyz per triangle corner, deformed, document units), values (one per corner), triangles, truncated }. Returns data { svg, field, unit, resultSet, min { value, ' +
    'at }, max { value, at }, deformationScale, levels, trianglesDrawn, entityIds, cut, axis }; save it as PNG with the CLI (--save ' +
    'plot.png). Requires a solved analysis on this machine (fea_mesh then fea_solve). min.at / max.at / axis / target are in the analysis length unit; data.surface is in document units.',
  annotations: { readOnly: true },
  params: renderParams,
  run: (doc, params, ctx): CommandResult => {
    const request = fieldPlotRequest(doc, params, ctx);
    if (!('plot' in request)) return request;
    const { svg, facesDrawn } = fieldPlotSvg(request.plot);
    return request.finish(svg, facesDrawn);
  },
});
