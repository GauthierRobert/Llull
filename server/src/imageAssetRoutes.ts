/**
 * GET /assets/image/:key (RV1 RV-M1): the bytes of a texture file of the image asset store (key = sha256, 64 lowercase hex), for the desktop viewport.
 * Guarded like `/live/snapshot` (`guardRead`). 400 for a malformed key (no path can leave the store), 404 for an unknown or damaged one. The content
 * type follows the file header (image/png, image/jpeg, image/vnd.radiance); content-addressed bytes never change, so they cache for good.
 */

import { Router, type RequestHandler } from 'express';
import { readImageHeader } from '@lib/imageHeader';
import { defaultImageAssetStore, isImageAssetKey } from './imageAssets/store';
import { guardRead } from './security';

const CONTENT_TYPES = { png: 'image/png', jpeg: 'image/jpeg', hdr: 'image/vnd.radiance' } as const;

export function buildImageAssetRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  router.get('/assets/image/:key', restLimiter, guardRead(), (req, res) => {
    const raw = req.params['key'];
    const key = typeof raw === 'string' ? raw : '';
    if (!isImageAssetKey(key)) return void res.status(400).json({ error: 'The image key must be 64 lowercase hex characters.' });
    const bytes = defaultImageAssetStore().readImage(key);
    if (bytes === null) return void res.status(404).json({ error: 'No such image.' });
    const header = readImageHeader(bytes);
    res
      .status(200)
      .setHeader('Content-Type', header === null ? 'application/octet-stream' : CONTENT_TYPES[header.format])
      .setHeader('Cache-Control', 'private, max-age=31536000, immutable')
      .end(Buffer.from(bytes));
  });
  return router;
}
