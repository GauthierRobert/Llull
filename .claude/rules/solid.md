# RULE: solid (design principles, mapped to llull)

SOLID is not abstract here — llull's architecture already encodes it. Follow the mapping;
a violation of SOLID is usually also a violation of an architecture law (architecture.md).

## S1 — Single Responsibility (SRP)
One reason to change per unit. One concern per file (conventions C7). A command performs
ONE document operation; a component renders ONE thing; a hook encapsulates ONE behavior.
If a file mixes geometry math + rendering + I/O, split it.

## S2 — Open/Closed (OCP)
Open for extension, closed for modification. Add a capability by adding a NEW command file
and appending to `definitions` in `registry.ts` — never by editing the flow of existing
commands or callers. New entity kind ⇒ extend the `kind` union + add a render branch; do
NOT grow a `switch` in every caller. The registry is the extension point.

## S3 — Liskov Substitution (LSP)
Every command satisfies the same contract: `(doc, params) => CommandResult`, pure, graceful
no-op on bad input. Any command is interchangeable through `execute()` — callers never
special-case one. Likewise every `Entity` honors the base shape (`id`, `kind`, `position`);
shared code must not branch on a specific subtype except in its dedicated render/handler.

## S4 — Interface Segregation (ISP)
Small, focused interfaces. Each command has its own minimal `<Command>Params` — no fat
shared params god-type. Inject narrow ports (e.g. an `AiClient`, a `Clock`) rather than
passing the whole world. A consumer should depend only on the fields it uses.

## S5 — Dependency Inversion (DIP)
Depend on abstractions, not concretions. `ui` depends on the registry contract
(`listCommands` / `getCommand` / `execute` / `toToolSchemas`), never on a command's internals.
`core` depends on injected interfaces for side effects (network/DOM/clock) — never on `ui`.
Dependency direction stays `ui → core → lib` (architecture L2); the registry IS the boundary
(architecture L5).

## Quick check before adding code
- New behavior with no edit to existing files? (OCP) — if you're editing a `switch`, reconsider.
- Could I swap this command/entity for another of its kind with no caller change? (LSP)
- Does this module depend on a concrete thing it shouldn't know about? (DIP)
