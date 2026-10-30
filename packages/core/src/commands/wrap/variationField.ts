/** The `variation` parameter shared by the commands that pick a font (import_font, add_text, add_decal): a variable font instance by axis tag. */

import { z } from '../schema';

export const variationField = (): z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>> =>
  z
    .record(z.string(), z.number())
    .describe(
      'CFF2 variable font only: the instance as design values by axis tag, e.g. {"wght": 700, "wdth": 87.5}. Axes you leave out keep their default; ' +
        'import_font lists the axes (data.axes: tag, min, default, max). Absolute (not relative to another instance). Omitted = the default instance, the only one of a TrueType or CFF 1.x font. ' +
        'An unknown axis, a value outside its range or a font that is not CFF2 variable refuses with WRP_FONT_VARIATION.',
    )
    .optional();
