/**
 * POST /preview { name, params }: a dry run of one command on a COPY of the live document (04 DIR TECHNICAL §7). The answer is the display meshes of
 * what the command would create or change and the ids it would replace (`@protocol/preview`). Nothing is applied: no live-document write, no undo
 * entry, no command log, no SSE broadcast, no audit record. The command runs synchronously on the one backend thread, so previews never overlap; the
 * shared REST rate limiter bounds how many a client can ask for, and a client that drops the connection simply gets no reply.
 */

import { Router, type RequestHandler } from 'express';
import { isRecord } from '@lib/isRecord';
import { redactLicensedOutcome } from '@protocol/index';
import { runCommandOutcome } from '@protocol/commandOutcome';
import { previewOf } from '@protocol/preview';
import { reportCommandCrash } from './commandBus';
import { serverContext } from './fea/context';
import { getLiveDoc } from './liveDocument';
import { fillServerParams } from './plm/hostRun';
import { guardMutation, isLocalPeer } from './security';

export function buildPreviewRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  router.post('/preview', restLimiter, guardMutation(), (req, res) => {
    const body = req.body as unknown;
    if (!isRecord(body) || typeof body['name'] !== 'string' || body['name'].length === 0)
      return void res.status(400).json({ error: 'Request body must be an object with a non-empty "name" field.' });
    const prior = getLiveDoc();
    const filled = fillServerParams(body['name'], body['params'] ?? {}, new Date());
    const run = runCommandOutcome(prior, body['name'], filled, serverContext());
    if (run.thrown !== undefined) reportCommandCrash(run.thrown, body['name'], body['params'], prior);
    const answer = previewOf(prior, run.document, run.outcome);
    if (isLocalPeer(req)) return void res.status(200).json(answer);
    // a non-local client gets the same licensed-value redaction as /command, and no geometry of a redacted answer
    const redacted = redactLicensedOutcome(prior, body['name'], body['params'], answer);
    res
      .status(200)
      .json(
        redacted === answer
          ? answer
          : { ...redacted, entities: redacted.entities.map((entity) => ({ ...entity, positions: [], truncated: true })) },
      );
  });
  return router;
}
