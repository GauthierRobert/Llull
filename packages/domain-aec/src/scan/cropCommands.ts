/** Crop boxes (TECHNICAL_SPEC §4.1): named document-frame boxes that clip clouds in views and serve as query regions. */

import type { CropBox } from '@core/model/pointCloud';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import { nextId } from '@lib/id';
import { refuseScan } from './codes';
import { findCloud, scanOf, withScan } from './model';

const point = (text: string): z.ZodArray<z.ZodNumber> => z.array(z.number()).length(3).describe(text);

/**
 * @affects adds 1 crop box to doc.scan (affected: [cropId])
 * @failure min >= max on an axis -> SCN_CROP_INVALID; unknown cloud id -> SCN_CLOUD_NOT_FOUND
 */
export const setScanCrop = defineCommand({
  name: 'set_scan_crop',
  description:
    'Create a named crop box (document units and frame) on some clouds (default: all). keep "inside" shows only the points inside and can be ' +
    'used as a query region ({kind:"crop",cropId}); "outside" hides them. Remove it with clear_scan_crop.',
  params: z.object({
    name: z.string().describe('Crop name, e.g. "tie-in area".'),
    min: point('[x, y, z] low corner (document units).'),
    max: point('[x, y, z] high corner (document units).'),
    keep: z.enum(['inside', 'outside']).optional().describe('inside (default) or outside.'),
    cloudIds: z.array(z.string()).optional().describe('Clouds it applies to; default every cloud.'),
  }),
  run: (doc, { name, min, max, keep = 'inside', cloudIds = [] }): CommandResult => {
    const bad = [0, 1, 2].filter((axis) => !((min[axis] ?? 0) < (max[axis] ?? 0)));
    if (bad.length > 0)
      return refuseScan(
        doc,
        'set_scan_crop',
        'SCN_CROP_INVALID',
        `min must be < max on every axis (axis ${bad.join(', ')})`,
        [],
        bad.map((a) => `min.${a}`),
      );
    const unknown = cloudIds.filter((id) => findCloud(doc, id) === undefined);
    if (unknown.length > 0)
      return refuseScan(doc, 'set_scan_crop', 'SCN_CLOUD_NOT_FOUND', `no attached cloud ${unknown.join(', ')}`, unknown, ['cloudIds']);
    const id = nextId('crop');
    const crop: CropBox = {
      id,
      name: name.trim() || id,
      cloudIds,
      min: [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0],
      max: [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0],
      keep,
    };
    const scan = scanOf(doc);
    return changed(withScan(doc, { ...scan, crops: { ...scan.crops, [id]: crop } }), `Created crop ${id} "${crop.name}" (keep ${keep}).`, [
      id,
    ]);
  },
});

/**
 * @affects removes 1 crop box (affected: [cropId])
 * @failure unknown crop -> SCN_CROP_NOT_FOUND
 */
export const clearScanCrop = defineCommand({
  name: 'clear_scan_crop',
  description: 'Remove a crop box created by set_scan_crop.',
  params: z.object({ cropId: z.string().describe('Crop id (affected[0] of set_scan_crop).') }),
  run: (doc, { cropId }): CommandResult => {
    const scan = scanOf(doc);
    if (!Object.hasOwn(scan.crops, cropId))
      return refuseScan(doc, 'clear_scan_crop', 'SCN_CROP_NOT_FOUND', `no crop '${cropId}'`, [cropId], ['cropId']);
    const { [cropId]: removed, ...crops } = scan.crops;
    void removed;
    return changed(withScan(doc, { ...scan, crops }), `Removed crop ${cropId}.`, [cropId]);
  },
});
