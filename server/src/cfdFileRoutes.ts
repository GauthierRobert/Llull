/**
 * GET /cfd/file/:sha256 (12 CFD M3c): the bytes of a content-addressed flow result file (a `cfd_slice` / `cfd_streamlines` file the query returned by hash)
 * from the FE artifact store's `cfd-files` directory. Guarded like `/live/snapshot` (`guardRead`). The hash is 64 lowercase hex or the request is refused
 * (400), so no path can leave the store; `get` verifies the content against the hash. 404 when the file is absent or damaged.
 */

import { Router, type RequestHandler } from 'express';
import { defaultFeArtifactStore } from './fea/artifactStore';
import { cfdFileStore } from './cfd/fileStore';
import { guardRead } from './security';

const HASH = /^[0-9a-f]{64}$/;

export function buildCfdFileRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  router.get('/cfd/file/:sha256', restLimiter, guardRead(), (req, res) => {
    const raw = req.params['sha256'];
    const hash = typeof raw === 'string' ? raw : '';
    if (!HASH.test(hash)) return void res.status(400).json({ error: 'The file hash must be 64 lowercase hex characters.' });
    const bytes = cfdFileStore(defaultFeArtifactStore().directory).get(hash);
    if (bytes === null) return void res.status(404).json({ error: 'No such result file.' });
    res
      .status(200)
      .setHeader('Content-Type', 'application/octet-stream')
      .setHeader('Cache-Control', 'private, max-age=31536000, immutable')
      .end(bytes);
  });
  return router;
}
