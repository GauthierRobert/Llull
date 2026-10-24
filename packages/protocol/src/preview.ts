/**
 * The dry-run answer of `POST /preview` (04 DIR TECHNICAL §7): what a command WOULD do to a document, as display meshes of the entities it creates or
 * changes and the ids it replaces. Pure presentation of a command result: the host runs the command on a copy and calls `previewOf`; nothing here
 * writes a document, a log or a stream.
 */

import type { CadDocument, Entity } from '@core/model/types';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { roundTo } from '@lib/compactNumber';
import type { CommandError } from '@core/commands/types';
import type { CommandOutcome } from './restProtocol';

/** Most triangles one preview carries; a bigger entity is listed without geometry (`truncated`). */
const MAX_PREVIEW_TRIANGLES = 150_000;

/** World-space display mesh of one entity of the preview. */
interface PreviewEntity {
  readonly id: string;
  readonly kind: string;
  readonly color: string;
  /** Unindexed triangles: x, y, z of three vertices per triangle (9 numbers), rounded to 1e-6. Empty for a 2D entity or when `truncated`. */
  readonly positions: number[];
  readonly triangleCount: number;
  readonly truncated: boolean;
}

/** Body of a `POST /preview` reply. */
export interface PreviewResponseBody {
  /** The command ran and changed the document. */
  readonly ok: boolean;
  readonly summary: string;
  /** Entities created or changed by the command, with their meshes. */
  readonly entities: PreviewEntity[];
  /** Ids of the live document the preview replaces: consumed by the command or changed in place. The client hides them while the ghost is shown. */
  readonly replacedIds: string[];
  readonly data?: unknown;
  readonly error?: CommandError;
}

function previewEntity(entity: Entity, doc: CadDocument, budget: { left: number }): PreviewEntity {
  const triangles = ((): ReturnType<typeof entityToTriangles> => {
    try {
      return entityToTriangles(entity, doc);
    } catch {
      return [];
    }
  })();
  const truncated = triangles.length > budget.left;
  const used = truncated ? [] : triangles;
  budget.left -= used.length;
  return {
    id: entity.id,
    kind: entity.kind,
    color: entity.color,
    positions: used.flatMap((triangle) => triangle.flatMap((p) => p.map((value) => roundTo(value, 6)))),
    triangleCount: triangles.length,
    truncated,
  };
}

/**
 * The preview of running a command on `prior` (result `next`, `outcome`). `entities` are the affected ids that exist in `next`; `replacedIds` are the
 * ids of `prior` that are gone or changed in `next`.
 */
export function previewOf(prior: CadDocument, next: CadDocument, outcome: CommandOutcome): PreviewResponseBody {
  const budget = { left: MAX_PREVIEW_TRIANGLES };
  const shown = [...new Set(outcome.affected)].filter((id) => next.entities[id] !== undefined);
  const replacedIds = Object.keys(prior.entities).filter((id) => next.entities[id] !== prior.entities[id]);
  return {
    ok: outcome.changed && !outcome.isError,
    summary: outcome.summary,
    entities: shown.map((id) => previewEntity(next.entities[id] as Entity, next, budget)),
    replacedIds,
    ...(outcome.data !== undefined ? { data: outcome.data } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
  };
}
