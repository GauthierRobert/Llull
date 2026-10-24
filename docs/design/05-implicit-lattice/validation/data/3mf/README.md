# 3MF Volumetric & Implicit Extensions 1.0.0 schemas (pinned)

`implicit.xsd` (99 216 bytes, sha256 `e88ce8d50612dc740ca2fdc877f137d2eccc9595d02870974df32356f8963a2e`) and `volumetric.xsd` (10 300 bytes) from
https://github.com/3MFConsortium/spec_volumetric (3MF Consortium, BSD-2-Clause), fetched 2026-10-24 and vendored so the level-set export can be validated
offline (`server/tests/threeMfImplicit.test.ts`, TR-IMP-12, VC-IMP-31). Do not edit; replace both files together when the extension is revised.

`Validate.java` is the single-file validator the test runs (`java Validate.java <schema dir> <xml>...`): it rewrites the schema's `maxOccurs="2147483647"` to
`unbounded` (same meaning; Xerces would expand the count and run out of memory). Known schema defect: `<i:sqrt>` requires two inputs against its own
documentation, so llull writes the square root as `<i:pow>` with exponent 0.5.

`beamlattice.xsd` (5 349 bytes, sha256 `c525676ff645680c98b128d1ed9891387dd69c207abaaafe9282664a7a5430cd`) and `beamlattice-balls.xsd` (3 570 bytes, sha256
`d389425abf514b50e2ea0c52bc006c9306a3264d4bfc1b6cb8d5739ff61406e9`) are Appendix B (A.1, A.2) of the Beam Lattice Extension 1.2 in
https://github.com/3MFConsortium/spec_beamlattice (`3MF Beam Lattice Extension.md`, BSD-2-Clause), fetched 2026-10-24. The spec publishes them only inside that
document; the sole change is dropping the `xs:import` of `http://www.w3.org/2001/xml.xsd` (network) which neither schema uses. `Validate.java` picks the root schema
with `-Dschema=beamlattice.xsd` (default `implicit.xsd`); `server/tests/threeMfImplicit.test.ts` validates the beam-lattice objects of a strut lattice export with and without
`beamRepresentation`.
