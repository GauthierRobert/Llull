import { z } from '@core/commands/schema';

/** The file parameters of the spreadsheet imports. */
export const sourceFields = {
  fileBase64: z
    .string()
    .optional()
    .describe(
      'The spreadsheet as base64: an .xlsx (as written by export_plant_data or edited in Excel / LibreOffice) or a .csv. With the CLI send file=<path>. Send this or csv.',
    ),
  csv: z.string().optional().describe('The CSV text instead of a file (header row, then one row per object). Send this or fileBase64.'),
  sheet: z.string().optional().describe('Sheet (tab) name of an .xlsx; default the first visible sheet.'),
};
