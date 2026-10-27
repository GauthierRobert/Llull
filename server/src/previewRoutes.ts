/**
 * POST /preview { name, params }: a dry run of one command on a COPY of the live document (04 DIR TECHNICAL §7). The answer is the display meshes of
 * what the command would create or change and the ids it would replace (`@protocol/preview`). Nothing is applied: no live-document write, no undo
 * entry, no command log, no SSE broadcast, no audit record. A preview that needs a native mesh job (TECHNICAL_SPEC 07 MSH 13.8) awaits it without
 * blocking the backend, like `POST /command`; the shared REST rate limiter bounds how many a client can ask for, and a client that drops the connection
 * cancels the preview (the job is killed) and gets no reply.
 */

import { Router, type RequestHandler } from 'express';
import { isRecord } from '@lib/isRecord';
import { redactLicensedOutcome } from '@protocol/index';
import { runCommandOutcome, type CommandRun } from '@protocol/commandOutcome';
import { previewOf } from '@protocol/preview';
import { reportCommandCrash } from './commandBus';
import { serverContext } from './fea/context';
import { getLiveDoc } from './liveDocument';
import { resolveDeferred } from './native/deferredRun';
import { fillServerParams, refusedRun } from './plm/hostRun';
import { guardMutation, isLocalPeer } from './security';

export function buildPreviewRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  router.post('/preview', restLimiter, guardMutation(), (req, res) => {
    const body = req.body as unknown;
    if (!isRecord(body) || typeof body['name'] !== 'string' || body['name'].length === 0)
      return void res.status(400).json({ error: 'Request body must be an object with a non-empty "name" field.' });
    const name = body['name'];
    const filled = fillServerParams(name, body['params'] ?? {}, new Date());
    const cancel = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) cancel.abort();
    });
    let prior = getLiveDoc();
    resolveDeferred<CommandRun>(
      () => {
        prior = getLiveDoc();
        return runCommandOutcome(prior, name, filled, serverContext());
      },
      { signal: cancel.signal, refuse: (refusal) => refusedRun(getLiveDoc(), refusal) },
    )
      .then((run) => {
        if (run.thrown !== undefined) reportCommandCrash(run.thrown, name, body['params'], prior);
        const answer = previewOf(prior, run.document, run.outcome);
        if (isLocalPeer(req)) return void res.status(200).json(answer);
        // a non-local client gets the same licensed-value redaction as /command, and no geometry of a redacted answer
        const redacted = redactLicensedOutcome(prior, name, body['params'], answer);
        res
          .status(200)
          .json(
            redacted === answer
              ? answer
              : { ...redacted, entities: redacted.entities.map((entity) => ({ ...entity, positions: [], truncated: true })) },
          );
      })
      .catch(
        (error: unknown) =>
          void res.status(500).json({ error: `Preview of ${name} failed: ${error instanceof Error ? error.message : String(error)}` }),
      );
  });
  return router;
}
