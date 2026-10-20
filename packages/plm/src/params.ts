/** Param schemas shared by the PLM commands. Timestamps and users come from the host (commands never read a clock, TR-PLM-05). */

import { z } from '@core/commands/schema';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** ISO-8601 UTC timestamp, e.g. 2026-11-02T09:30:00Z (the host fills it when a CLI or UI call omits it). */
export const atSchema = z
  .string()
  .regex(ISO_UTC, 'must be ISO-8601 UTC like 2026-11-02T09:30:00Z')
  .describe(
    'When the act happened: ISO-8601 UTC, e.g. 2026-11-02T09:30:00Z. The host (UI / llull CLI) fills it; commands never read a clock.',
  );

export const bySchema = z
  .string()
  .min(1)
  .describe(
    'User id doing the act (the host fills it from the authenticated user; an agent cannot override it where the server has named users).',
  );

export const effectivitySchema = z
  .object({
    kind: z.enum(['serial', 'msn', 'date', 'lot']).describe('serial / msn: positive integers; date: YYYY-MM-DD; lot: an id string.'),
    from: z.union([z.number(), z.string()]).describe('First unit covered (inclusive), of the kind.'),
    to: z.union([z.number(), z.string()]).optional().describe('Last unit covered (inclusive). Absent = open-ended.'),
  })
  .describe('One effectivity range.');

export const dispositionSchema = z.enum(['use-as-is', 'rework', 'scrap', 'return-to-supplier', 'no-action']);

export const approvalSchema = z
  .object({
    role: z
      .string()
      .min(1)
      .describe("Approval role, e.g. 'design-authority' or 'checker' (see policy.requiredApprovalRoles in plm_status)."),
    userId: z.string().min(1).describe('The approving user id.'),
    at: atSchema.optional(),
    comment: z.string().optional().describe('Optional remark.'),
  })
  .describe('One approval by a role.');
