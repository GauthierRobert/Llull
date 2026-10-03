/**
 * build_project — execute an AI-authored plan (an ordered list of command
 * actions) as one transaction.
 *
 * @layer core/commands
 *
 * This is the headline MCP capability: an agent describes a whole project as a
 * list of actions and applies it in a single round-trip. It does NOT bypass the
 * command layer — it routes every step through `execute` (the Prime Directive
 * choke point). Adding it to the registry made it one undoable step in the UI
 * and one MCP tool, like any other command.
 *
 * Cross-step references: a step may bind its result to an alias via `as`, and a
 * later step may reference the created id with `$alias` (first affected id) or
 * `$alias[N]` (Nth). This lets an agent author a multi-step plan without knowing
 * generated ids in advance — e.g. create a box `as: "base"`, then `move` `$base`.
 *
 * `onError: "abort"` (default) rolls the document fully back on the first failing
 * step (commands are pure, so the original doc is simply returned). `"continue"`
 * keeps going, recording per-step status. `validate: true` is a dry run: it
 * checks every step (command exists, required params present, alias refs defined)
 * without mutating the document.
 *
 * The result `data` carries a per-step report plus the final SceneSnapshot, so an
 * agent sees the whole outcome in one call.
 */

import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { currentContext, runInContext } from './context';
import { MAX_PROJECT_DEPTH } from './limits';
import { type BuildProjectParams } from './projectTypes';
import { noop } from './projectResolve';
import { runProject } from './projectRun';

/**
 * @command build_project
 * @pure
 * @layer core/commands
 * @affects runs an ordered list of commands; affected = union of created/changed ids
 * @invariant onError:'abort' on failure returns the input doc unchanged (full rollback)
 * @failure empty/invalid actions -> no-op, affected:[]; validate:true never mutates
 */
export const buildProject = defineCommand({
  name: 'build_project',
  description:
    'Apply an ordered list of command actions as one project. Each action is one of: ' +
    '(1) { command, params, as? } — plain action; ' +
    '(2) { repeat: { count, as? }, step: { command, params } } — run step N times; ' +
    'count may be a number or expression string. Each iteration exposes $i (0-based) in params expressions. ' +
    '(3) { for_each: { values, as }, step: { command, params } } — iterate over values array (or expression). ' +
    '$as is the current element, $i the index. ' +
    'A step may bind its result to an alias with "as"; later steps reference it as "$alias" or "$alias[N]". ' +
    'params values starting with "=" are evaluated as arithmetic expressions against doc.parameters plus $i/$as. ' +
    'onError="abort" (default) rolls the whole document back on the first failing step; "continue" applies what it can. ' +
    'validate=true performs a dry run without changing the document.',
  params: z.object({
    actions: z
      .array(z.unknown())
      .describe(
        'Ordered list of actions. Each item is { command, params?, as? } OR ' +
          '{ repeat: { count, as? }, step: { command, params? } } OR ' +
          '{ for_each: { values, as }, step: { command, params? } }. ' +
          'Params values may be "$alias" references or "=expr" arithmetic expressions.',
      ),
    onError: z
      .enum(['abort', 'continue'])
      .optional()
      .describe('Failure policy: "abort" (default, full rollback on first failure) or "continue".'),
    validate: z
      .boolean()
      .optional()
      .describe('When true, dry-run only: validate every step without modifying the document.'),
  }),
  // Each inner step is recorded in featureHistory by `execute`; recording the plan itself too
  // would replay every step twice.
  annotations: { metaHistory: true },
  run: (doc, params, ctx): CommandResult => {
    const context = ctx ?? currentContext();
    if (context.projectDepth >= MAX_PROJECT_DEPTH) {
      return noop(
        doc,
        { ok: false, validated: params.validate === true, stepCount: 0, steps: [], failedAt: null },
        `build_project: nesting depth exceeds MAX_PROJECT_DEPTH (${MAX_PROJECT_DEPTH}).`,
      );
    }
    return runInContext({ ...context, projectDepth: context.projectDepth + 1 }, () =>
      runProject(doc, params as unknown as BuildProjectParams),
    );
  },
});
