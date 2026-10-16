# PHY-15 Electrical, magnetic, optical & radiative properties: external sources

Accessed **2026-10-15**. Access modes: **git** (cloned, commit pinned), **search** (search-result text only; direct fetch
failed: DNS errors in WebFetch, `403` from the egress proxy for `curl` on standards.nasa.gov, ntrs.nasa.gov,
everyspec.com, incompliancemag.com, arxiv.org). Grades per `docs/physics/README.md` §6.3.

| Id | Source | Publisher / licence | URL | Access | What was verified | Grade of what we use |
| -- | ------ | ------------------- | --- | ------ | ----------------- | -------------------- |
| S1 | Copper Development Association, *Copper Design Guide — electrical properties* | CDA | https://copper.org/applications/industrial/DesignGuide/props/electrical.php | search | IACS adopted in 1913; annealed copper = 100 % IACS. The extract says the value was assigned "at 200 °C (392 °F)" — evidently a typo for 20 °C (all other sources say 20 °C); flagged, not used | A (with S2) |
| S2 | Secondary IACS definitions: viox.com "Conductivity vs resistivity vs %IACS", makeitfrom.com glossary, Windy City Wire glossary | various | https://viox.com/conductivity-vs-resistivity-iacs/ ; https://www.makeitfrom.com/glossary/Electrical-Conductivity | search | 100 % IACS = volume resistivity 1.7241 × 10⁻² µΩ·m (1.7241 µΩ·cm) at 20 °C; test wire 1 m, 1 g, 8.89 g/cm³, 0.15328 Ω. One page states 58.108 MS/m, which disagrees with 1/1.7241e-8 = 58.0013 MS/m by 0.2 % — not used | A (1.7241 µΩ·cm) |
| S3 | Classical electromagnetics and optics: skin depth δ = √(2ρ/(ωμ)), exponential field decay in a conductor, AC resistance of a round wire for r ≫ δ, Fresnel normal reflectance | textbooks (not fetched) | — | none | Implemented and exercised in `generate_eop_reference.py`; the absorption-loss constant 8.68589 dB per skin depth is 20 log10(e), derived | A (by derivation) |
| S4 | Radiative balance of a sun-facing plate (αS = nεσT⁴) | Lienhard & Lienhard, *A Heat Transfer Textbook* 6th ed. (PHY-03 S9) | https://ahtt.mit.edu/ | search | Standard grey-body balance; derived in the generator with the exact-SI σ | A (by derivation) |
| S5 | SI constants: σ from exact h, c, k_B (PHY-03 S11); μ0 = 4π × 10⁻⁷ N/A² (pre-2019 exact) and the CODATA 2018 value 1.256 637 062 12 × 10⁻⁶ | BIPM / NIST | https://www.bipm.org/en/publications/si-brochure ; https://physics.nist.gov/cuu/Constants/ | search (σ inputs) / not seen (CODATA μ0) | The CODATA μ0 is quoted from memory and used only for a comparison note (difference 5.5e-10 relative, far below any tolerance); llull uses 4π × 10⁻⁷ and names it | A (σ) / C (CODATA μ0, note only) |
| S6 | The 2.5 mΩ bonding value: InCompliance, "The Origin and Application of the 2.5 mΩ Requirement" (class L and R bonding; classes survive in MIL-STD-464 and NASA-STD-4003); MIL-STD-464C text as quoted by secondary pages ("2.5 milliohms has long been recognized as an indication of a good bond across a metallic interface, particularly aluminum … There is no technical evidence that this number must be strictly met to avoid problems"); FAA AC 43.13-1B as summarised by a study guide (equipment frames < 2.5 mΩ; static bonds < 1 Ω) | InCompliance; lectromec; open-exam-prep (secondary) | https://incompliancemag.com/?p=35487 ; https://lectromec.com/considerations-for-electrical-bonding/ | search | Only secondary text seen; no primary table read | **B** (rule value, `unverified` until a human reads MIL-STD-464C / NASA-STD-4003A) |
| S7 | SAE ARP1870 *Aerospace Systems Electrical Bonding and Grounding for Electromagnetic Compatibility and Safety* | SAE (paid) | https://saemobilus.sae.org/content/arp1870 | search (catalogue) | Scope: minimum requirements for electrical bonding and grounding of avionic / electronic installations; adequate low-resistance return path that withstands operating conditions and corrosion. Status conflict: SAE lists "Reaffirmed", some mirrors "withdrawn". No resistance class table seen | catalogue |
| S8 | MIL-STD-464C bond classes, as summarised by TEGAM / Advanced Energy application note AN109 | Advanced Energy (secondary) | https://www.advancedenergy.com/getattachment/340ed036-3ded-432b-bc46-ef8dfe32d732/AN109.pdf | search | Historical bond classes A, C, H, L, R, S; class H (shock hazard) ≤ 100 mΩ; class L = lightning protection | B |
| S9 | NASA-STD-4003A (with Change 1, revalidated 2026-03-13) *Electrical Bonding for NASA Launch Vehicles, Spacecraft, Payloads, and Flight Equipment* | NASA | https://standards.nasa.gov/node/239 | search (listing) | Revision and revalidation date listed; five bond classes "from static control to lightning protection" (InCompliance tag page). Values not seen | C |
| S10 | SAE ARP5414 *Aircraft Lightning Zoning*; SAE ARP5412C (2024) *Aircraft Lightning Environment and Related Test Waveforms*; FAA AC 20-155 (2006) | SAE (paid); FAA | https://www.faa.gov/sites/faa.gov/files/AC20-155.pdf ; https://webstore.ansi.org/standards/sae/saearp5412c2024 | search | AC 20-155 refers to ARP5414A (Feb 2005), which "describes aircraft lightning attachment zones used in defining where lightning will attach"; ARP5412C defines the external environment and points to ARP5414 (zones) and ARP5416 (test methods). **Scope only**: llull ships no zone definitions | catalogue |
| S11 | J. H. Henninger, *Solar Absorptance and Thermal Emittance of Some Common Spacecraft Thermal-Control Coatings*, NASA RP-1121 (April 1984), GSFC | NASA (public) | https://ntrs.nasa.gov/citations/19840015630 ; https://apps.dtic.mil/sti/pdfs/ADA305864.pdf | search | Report exists; tabulates α and ε for many coatings, some with UV / particle degraded values; DTIC scan partly illegible. **No value extracted** (fetch blocked). A vendor AZ-93 figure (α ≈ 0.15, ε ≈ 0.91) was seen but is vendor data, not used | C (candidate seed library) |
| S12 | CalculiX electromagnetics: `*ELECTRICAL CONDUCTIVITY` (isotropic, temperature dependent; example 5.96E7 S/m "electrical conductivity of copper"), `*MAGNETIC PERMEABILITY`, `*ELECTROMAGNETICS` (induction heating) | G. Dhondt; GPL-2.0 | https://github.com/Dhondtguido/CalculiX (commit fd588701edd6a92fde06e99b1bdf01f3b0f80f2c) | git | Cards exist (V2 hook for Joule / induction heating). Note: 5.96E7 S/m ≈ 102.8 % IACS (pure copper), not the IACS reference — an example of why llull stores the property with its basis | A (syntax) |

## Citation id mapping

Specs cite `[Rn]` = register `Sn` (n = 1…12).

## Data policy findings

- **No open, licence-clear, multi-material table of α_solar / ε_IR, resistivity or permeability was reached** in this
  session. NIST pages and the NASA coating report could not be fetched. PHY-15 therefore ships **no property values**; the
  seed-library candidates (Henninger RP-1121, a public-domain US-government work; NIST data) are listed for a later,
  human-checked import under 08's library rules.
- **Bonding limits are programme rules**, not physics: llull keeps them in a rule table with a source and `unverified`
  flag (AF-30/31). The 2.5 mΩ value is grade B.

## Not verified

- MIL-STD-464C, NASA-STD-4003A and ARP1870 resistance tables (paywalled or blocked).
- Henninger RP-1121 tables.
- The CODATA 2018 μ0 digits (note only).
