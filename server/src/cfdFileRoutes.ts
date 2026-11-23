/**
 * GET /cfd/file/:sha256 (12 CFD M3c): the bytes of a content-addressed flow result file (a `cfd_slice` / `cfd_streamlines` file the query returned by hash)
 * from the FE artifact store's `cfd-files` directory. Guarded like `/live/snapshot` (`guardRead`). The hash is 64 lowercase hex or the request is refused
 * (400), so no path can leave the store; `get` verifies the content against the hash. 404 when the file is absent or damaged. Only slice / streamline files are served (LLSL / LLST magic: 415 otherwise, so a solve's
 * `field.bin` never leaves through here) and at most `MAX_CFD_FILE_BYTES` (413); the size is checked by `stat` before any read, and the read is asynchronous.
 */

import { readFile, stat } from 'node:fs/promises';
import { Router, type RequestHandler } from 'express';
import { defaultFeArtifactStore } from './fea/artifactStore';
import { cfdFileStore, hashFile, readHead } from './cfd/fileStore';
import { guardRead } from './security';

const HASH = /^[0-9a-f]{64}$/;
/** Named cap: the largest result file served (a slice is at most 512 x 512 floats; streamlines at most 4096 seeds of 20000 steps). */
export const MAX_CFD_FILE_BYTES = 64 * 1024 * 1024;
const MAGICS = ['LLSL', 'LLST'];

export function buildCfdFileRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  router.get('/cfd/file/:sha256', restLimiter, guardRead(), (req, res) => {
    const raw = req.params['sha256'];
    const hash = typeof raw === 'string' ? raw : '';
    if (!HASH.test(hash)) return void res.status(400).json({ error: 'The file hash must be 64 lowercase hex characters.' });
    const file = cfdFileStore(defaultFeArtifactStore().directory).pathOf(hash);
    const serve = async (): Promise<void> => {
      const size = file === null ? null : ((await stat(file).catch(() => null))?.size ?? null);
      if (file === null || size === null) return void res.status(404).json({ error: 'No such result file.' });
      if (size > MAX_CFD_FILE_BYTES) return void res.status(413).json({ error: `The file is larger than ${MAX_CFD_FILE_BYTES} bytes.` });
      if (!MAGICS.includes((await readHead(file, 4)).toString('latin1')))
        return void res.status(415).json({ error: 'Only slice and streamline files are served.' });
      const bytes = await readFile(file);
      if ((await hashFile(file)).sha256 !== hash || bytes.length !== size)
        return void res.status(404).json({ error: 'No such result file.' });
      res
        .status(200)
        .setHeader('Content-Type', 'application/octet-stream')
        .setHeader('Cache-Control', 'private, max-age=31536000, immutable')
        .end(bytes);
    };
    serve().catch(() => void res.status(404).json({ error: 'No such result file.' }));
  });
  return router;
}
