# LIC1 — llull is GPL-3.0-or-later

Status: decided 2026-11-03 by the owner ("Go with GPL-3.0 or later"). Closes cross-gap decision 5 of
[`docs/aerospace/README.md`](../aerospace/README.md) for llull's own code.

## Decision

All llull code (root app, `packages/*`, `server/`, `desktop/`, `solver/`) is licensed **GPL-3.0-or-later**: [`LICENSE`](../../LICENSE),
`"license": "GPL-3.0-or-later"` in every `package.json`, `license = "GPL-3.0-or-later"` in `solver/Cargo.toml` `[workspace.package]`.
The copyright holder (Gauthier Robert) keeps the right to offer separate commercial licences; contributions carry the grant in
[`docs/CONTRIBUTING.md`](../CONTRIBUTING.md) § Licensing of contributions, which makes that possible.

## Why

| Option | Outcome | Verdict |
| --- | --- | --- |
| Apache-2.0 / MIT | Maximum adoption, but anyone may ship a closed fork of the whole CAD | No: no protection for a solo-built product |
| **GPL-3.0-or-later + commercial licence** | Code stays open; redistributed forks must publish their source; dual licensing stays possible | **Chosen** |
| AGPL-3.0 | Adds the network clause | Not needed: llull runs only locally, no hosting (LC1) |
| FSL / BUSL (source-available) | Blocks competing use for ~2 years | No: not open source |
| Proprietary (`UNLICENSED`, before) | All rights reserved; nobody may use or contribute | No |

## Compatibility with what llull bundles

| Component | Licence | Combined with GPL-3.0 |
| --- | --- | --- |
| OCCT 7.9 (shared library) | LGPL-2.1 + OCCT exception | Yes (LGPL-2.1 §3 / §6); shipped as a replaceable shared library with its notice (`prepare-native.mjs`) |
| Netgen (`llull-mesh`) | LGPL-2.1 | Yes; the §6 condition of NG1 (our terms must permit modification and reverse engineering) is met by the GPL |
| CadQuery / OCP, Manifold, MuJoCo | Apache-2.0 | Yes with GPL-3.0 (not with GPL-2.0-only, one reason for "3.0-or-later") |
| npm dependencies (React, three.js, Electron, zod, …), Rust crates | MIT / BSD / Apache-2.0 / ISC | Yes |
| CPython | PSF-2.0 | Yes |
| CalculiX, XFOIL (planned, 05 / 10) | GPL-2.0 (check "or later" for the version bundled) | Yes as separate processes (how llull runs them). Linking would need "or later"; bundling means shipping or offering their source |

Licensed MMPDS / NAS / CMH-17 data (08) is not a code-licence question: it stays in private libraries that never land in saved files.

## Consequences

- Distributing the desktop installer (GPL §6) requires the corresponding source: point to the public repository at the release tag,
  or ship a written source offer.
- User documents, drawings and exports are not covered by the GPL (the program's output is the user's).
- The installer ships `LICENSE` in its resources next to the third-party notices.
