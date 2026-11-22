# Third-party data in llull

llull embeds the following third-party DATA (numbers, tables) in its renderer and server bundles. This folder ships with the installer
(`resources/third-party-data/`); `desktop/electron-builder.yml` lists it and `desktop/tests/packaging.test.ts` checks that. Notices of the
bundled Python and native binaries ship with `python/` and `native/`.

## GMT colour table `dem2.cpt` (terrain tint of civil TIN surfaces)

- What: the 7 colour slices of `gmt/dem2` ("Digital Elevation Model (DEM) scale by Dewez/Wessel [R=0/4900, C=RGB]", Paul Wessel, "modified from
  DEM_poster at cpt city"), embedded as the constant `DEM2` in `packages/domain-aec/src/civil/surface/terrainPalette.ts`.
- Copyright (c) 1991-2026 by the GMT Team (https://www.generic-mapping-tools.org/team.html).
- Licence: GNU Lesser General Public License version 3 or later, with the GMT permission notice. The GMT `LICENSE.TXT` is in this folder as
  `LICENSE-GMT.TXT`, unmodified. The name of GMT is not used in advertising or publicity.
- Source: https://raw.githubusercontent.com/GenericMappingTools/gmt/master/share/cpt/gmt/dem2.cpt (the unmodified file and its notice are in
  `docs/plant/09-plant-visualization-review/validation/data/gmt_cpt/`).
- Upstream (Dewez, cpt-city DEM_poster): named in the file header only; its own terms are not verified.

## dodo tables (bundled open piping catalogue)

- What: dimensions read from `tablez/Reduct_SCH-STD.csv`, `Elbow_SCH-STD.csv` and `Flange_DIN-PN16.csv` of the dodo FreeCAD workbench (oddtopus),
  used in `packages/domain-aec/src/plant/catalog/` (`bundled.ts`, `data/`), each row tagged with its source id.
- Licence: GNU Lesser General Public License version 3 (`LICENSE-dodo-LGPL-3.0.txt`, unmodified, from https://raw.githubusercontent.com/oddtopus/dodo/master/LICENSE).
- Source and checksums: `docs/plant/01-piping-specs-catalog/validation/sources.md` (S11, S13).
