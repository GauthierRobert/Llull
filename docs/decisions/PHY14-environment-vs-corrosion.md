# PHY-14 space environment vs PHY-13 corrosion service environment

Decided 2026-11-09 (MOI review).

**Decision.** Keep two slices. `CadDocument.spaceEnvironment` (PHY-14: outgassing profile, humidity exposure, atomic-oxygen fluence, human deviations) and `CadDocument.corrosion.environment` (PHY-13: a categorical service environment `harsh | normal | controlled | artificial_seawater` per rule scheme) describe different physics and have different consumers; merging them would force one to carry fields it cannot interpret (the corrosion value is a category with no RH or temperature, the humidity exposure is numeric).

**Overlap handling.** `check_space_environment` compares them and adds the warning `ENV_SERVICE_ENVIRONMENT_MISMATCH` (a finding, never a status change) when both exist and disagree: `controlled` with a humidity exposure above 60 % RH, or `harsh` / `artificial_seawater` with one below 60 % RH; `normal` has no expectation. The 60 % thresholds are named constants (`serviceCheck.ts`) and a llull consistency heuristic, not a standard. Temperature is not compared (the corrosion category carries none).

**Shared code.** None yet: the environment deviation gate (`environment/gate.ts`) is a local copy of the corrosion pattern; both move to the shared signed-gate helper when the EOP lane lands it.
