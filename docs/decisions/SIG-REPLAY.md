# SIG-REPLAY — signed records follow the edited history

Status: done 2026-11-20 (board task SIG-REPLAY, found in the VAC-M3 review).

## Problem

A signed plugin gate (a human act whose `confirmation` never reaches the history: the step records `{ verified: true }`) keeps its record
through a regeneration by the plugin `replaySeed`, because the replayed step can only re-apply a record the seed kept. The seeds copied every
record whatever the history said, so:

- suppressing (`set_step_suppressed`) or deleting (`delete_step`) the signing step and regenerating KEPT the decision;
- deleting the subject (e.g. `delete_acoustic_exposure`) and then editing an earlier step made the replayed signing step FAIL with a human-gate refusal.

## Decision

- A signed record carries `stepKey`, the key of the feature step that wrote it (`stepStamp(ctx)`, `@lib/replaySurvivors`; inside a `build_project`
  the key of the outer step).
- `replayHistory` passes the keys of the replayed history's live steps (not suppressed) to every `replaySeed(base, liveStepKeys)` (additive,
  optional). A step merged by `squash_steps` lists the other keys of its range in `FeatureStep.mergedStepKeys`, which count as live.
- A seed keeps a record only while its step is live (`survivingRecords` / `survivesReplay`).
- A replayed signing step whose subject has no kept record re-applies nothing (`notReapplied`, `data.notReapplied: true`); the history commands
  report it as "re-applied nothing … stay pending until a human signs again" (`data.notReapplied` = the step ids), not as a failure. So unsuppressing a
  signing step does NOT bring the decision back: a human signs again. A kept record that disagrees with the step (decision, justification,
  fingerprint, uid) or whose signature no longer verifies is still the gate's refusal.
- On load `stepKey` must be text of 1 to 64 characters (every signed slice and ledger).

Covered: `dispose_acoustic_export`, `accept_corrosion_item`, `dispose_bond_check`, `approve_environment_deviation`, `dispose_margin`,
`dispose_thermal_limit`, `dispose_fit_result`, `accept_verification_exception`. The contract test `tests/unit/contract/signedReplaySeeds.test.ts`
classifies every signed step gate and keeps the open ones as a ratchet (plant spec approvals, fabrication issue ledger, scan acceptance ledger,
probabilistic acceptance ledger; pipe-stress approval is carried, not seeded). PLM and review/VIS signed acts are metaHistory: they are never steps,
so they have no such seed.

## Limits

- **Legacy records** (written before SIG-REPLAY, no `stepKey`) are kept by every replay, as before: old documents regenerate unchanged, and such a
  decision does not follow the history until a human re-signs it. A replay does not stamp a kept legacy record.
- **`stepKey` is not signed.** It is bookkeeping outside every signed payload, so a hand edit of a saved file can delete or retarget it. That forges
  nothing (every read and replay still re-verifies the signature through the signing port); it only lets a real decision outlive its step, which is
  the pre-SIG-REPLAY behaviour.
- **Squash** keeps the merged keys live only through `mergedStepKeys`; a file whose merged step lost that list behaves as if the later steps of
  the range were deleted (their records drop on the next regeneration).
