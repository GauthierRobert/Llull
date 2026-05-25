# RULE: react (React 18 + TS + r3f + Zustand best practices)

Applies to `ui/` ONLY. `core/` has no React (architecture L2). Components are presentation +
param-gathering; the document changes ONLY via `dispatch` → `execute` (PRIME DIRECTIVE).

## R1 — No business logic in components
A component renders and gathers input. Geometry/document mutation belongs in a command. A
handler's job is: gather params → `store.dispatch(name, params)`. Never build an `Entity`
inline (architecture L4).

## R2 — Function components + hooks only
No class components. Extract reusable logic into `useThing` hooks (conventions C3). One hook =
one behavior (SRP). Custom hooks over copy-pasted effect logic.

## R3 — State: single store, narrow selectors
Zustand is the single source of truth. Subscribe to the **narrowest slice** you need
(`useStore(s => s.selectedEntityIds)`), never the whole store — broad selectors cause needless
re-renders. Derive values during render; do NOT mirror store state into `useState`.

## R4 — Small, single-responsibility components
One component, one concern. Split a growing component; lift shared state to the store rather
than prop-drilling. Compose; avoid deep prop chains.

## R5 — Typed props, no `any`
Explicit `PascalCase` prop interfaces, no `I` prefix (conventions C1/C3). `exactOptionalProperty
Types` is on — model optionality precisely.

## R6 — Effects are for external synchronization only
`useEffect` syncs with things outside React (three.js imperative calls, subscriptions, event
listeners) — NOT for deriving state from props. Always clean up; keep the dependency array
honest. Avoid effect chains that cascade renders.

## R7 — Memoize deliberately
`useMemo`/`useCallback` for values passed to memoized children, r3f props, or expensive compute
— not reflexively. `React.memo` only on measured hot paths. Premature memoization adds noise.

## R8 — Stable keys
Entities have ids — use them as React keys. Never array index for dynamic lists.

## R9 — r3f / three.js discipline
- Build geometries/materials with `useMemo` (or drei helpers); never recreate them every render.
  **Dispose** geometries/materials/textures you create.
- Per-frame work goes in `useFrame` mutating refs — never `setState` per frame.
- One pure render branch per entity `kind`; it is a function of props (the entity), with no
  side effects. New `kind` ⇒ new branch (OCP, solid S2).
- Wrap the canvas in an error boundary; use `<Suspense>` for drei async loaders.

## R10 — Accessibility & semantics
Real `<button>`/`<label>` for panels and toolbar; keyboard-operable; aria where needed. The
toolbar is generated from `listCommands()` (architecture L5) — render accessible controls from it.

## R11 — Testing (mirror workflow W3)
Testing Library. Assert observable behavior (a command dispatched, an entity rendered, a
`summary` shown) — NOT internal state or geometry math. Component tests cover panels &
param-gathering, never the command math (that's unit-tested in `core`).
