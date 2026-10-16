# Sources — PHY-12 SEL (material selection & substitution)

All sources accessed **2026-10-15**.

**How sources were verified.** From this session `WebFetch` failed with DNS errors on every host tried
(asm.matweb.com, archive.nptel.ac.in, esmat.esa.int) and `curl` reached only PyPI, npm and GitHub (no
material data there). As in 08 MAT, verification used the **web-search index content** of each page. Grades
follow `docs/physics/README.md` §6.3: **A** = ≥ 2 independent sources or an exact analytic derivation in the
generator; **B** = one secondary source; **C/TBD** = not confirmed.

| Id | Source | URL | What it supports | Grade |
| -- | ------ | --- | ---------------- | ----- |
| S1 | M. F. Ashby, "Performance Indices", ASM Handbook Vol. 20 *Materials Selection and Design* (catalogue page) | https://dl.asminternational.org/handbooks/edited-volume/59/chapter/687368 | The chapter exists and is the authoritative statement of performance indices (paywalled; no content quoted). | catalogue |
| S2 | NPTEL course 112104122 lecture 24 (Ashby method); IIT Kharagpur DOME notes "materials"; Muğla University "Materials Selection and Design, Course 3" | https://archive.nptel.ac.in/content/storage2/courses/112104122/lecture24/24_5.htm · https://facweb.iitkgp.ac.in/~jeevanjyoti/teaching/dome/2025/notes/materials.pdf · https://metalurji.mu.edu.tr/Icerik/metalurji.mu.edu.tr/Sayfa/Materials%20Selection%20and%20Design%20-%20Course%203%20Selection%20practice(4).pdf | Tie stiffness → E/ρ (area free); beam with square section → E^½/ρ (worked cantilever S = C E t⁴/(12 L³)); free height → E^⅓/ρ (panel). | secondary (index), **A for the exponents** because `generate_selection_reference.py` re-derives every exponent numerically (VC-SEL-01) |
| S3 | nTop documentation, sample material Ti-6Al-4V (values attributed to matweb.com) | https://docs.ntop.com/Product-Documentation/ntop/block-documentation/blocks/design-analysis/sample-materials/ti-6al-4v.md | Density 4.43 g/cm³, E 113.8 GPa, ν 0.342; heat-treatment condition not stated. UPMET ELI datasheet gives 107–122 GPa (ELI grade, not the same alloy grade). | **B** |
| S4 | MakeItFrom "Normalized 4130 Cr-Mo Steel"; Industeel DS-MOLD-4130 | https://makeitfrom.com/material-properties/Normalized-4130-Cr-Mo-Steel · https://industeel.arcelormittal.com/fichier/ds-mold-4130 | Normalized 4130: E 190 GPa, yield 440 MPa, UTS 670 MPa, density 7.8 g/cm³ (MakeItFrom). Industeel Q&T plate: 7.85 g/cm³, E 190–210 GPa (different condition). | **B** |
| S5 | 08 MAT `validation/sources.md` S12 (MatWeb/ASM 7075-T6), S15 (Rolled Alloys Ti-6Al-4V), S16 (Aircraft Materials Ti-6Al-4V annealed sheet) | `../../../aerospace/08-materials-standards-libraries/validation/sources.md` | 7075-T6: 2.81 g/cm³, 71.7 GPa, Fty 503 MPa, ν 0.33 (AA typical). Ti-6Al-4V: 0.160 lb/in³ (supplier; 0.163 also seen), Fty 126 ksi typical. | typical / supplier (verified in 08) |
| S6 | 06 CMP `validation/clt_reference.json` (`generate_clt_reference.py`) | `../../../aerospace/06-composites/validation/clt_reference.json` | T300/5208 quasi-isotropic Ex = 69 675.7 MPa, νxy = 0.296031 (derived from Tsai & Hahn lamina data). No density. | derived |
| S7 | Circular Ecology: "Changes to the ICE Database Registration Process", "Overview of Upcoming Changes to the ICE Database", ICE V4.0 launch webinar (28 Nov 2024) | https://circularecology.com/?p=7239 · https://circularecology.com/?p=7291 · https://circularecology.com/wp-content/uploads/2024/11/Webinar-2-ICE-V4.0-Launch-28-Nov-24.pdf | ICE V4.0 launched late 2024 (V4.1 current), superseding V3 (2019). Educational use free; professionals need an Individual Licence; embedding in tools/APIs needs a **Tools and Integration Licence**; non-educational validity limited to 3 years from release; the machine-readable file is sold separately. | primary (index) |
| S8 | Stress independence of elastic constants: arXiv 1204.6419 (Vigdergauz equations proof); Lewiński, Arch. Mech. 74 (v74p319); J. Elasticity s10659-005-9040-2; Illinois abstract on Michell (1899) | https://arxiv.org/pdf/1204.6419 · https://am-old.ippt.pan.pl/am/article/download/v74p319/pdf · https://link.springer.com/article/10.1007/s10659-005-9040-2 · https://experts.illinois.edu/en/publications/new-results-in-the-theory-of-elasticity-for-two-dimensional-compo/ | 2D traction problems in homogeneous isotropic bodies: stress independent of the moduli (simply connected; extra conditions for holes). ν-independence needs divergence-free body forces. | secondary; llull uses only the weaker, exact statement K(E, ν) = E·K̂(ν) (TECHNICAL_SPEC §5.4) |
| S9 | Ansys Granta Selector (CADFEM, Econ Engineering, Develop3D, Cambridge Network) | https://www.cadfem.net/en/systematic-selection-of-materials-using-ansys-granta-selector-13138.html · https://econengineering.com/en/software/ansys-system-tools/ansys-granta-selector/ · https://develop3d.com/product-design/masters-of-the-material-world/ | Selector applies the Ashby method over a 4,000+ material dataset with charts; Eco Audit estimates energy and CO₂ per life stage; Ansys acquired Granta Design in 2019. | vendor / trade |
| S10 | Ashby, *Materials and the Environment* (Elsevier catalogue) | https://shop.elsevier.com/books/materials-and-the-environment/ashby/978-1-85617-608-8 | Book on eco-selection exists (catalogue only). | catalogue |

## Not verified in this session

- CFRP T300/5208 density (Tsai & Hahn / Kaw Table 2.1 not reached) → `tbd`; the CFRP row of the worked
  example is deliberately the `SEL_PROPERTY_MISSING` case (VC-SEL-14).
- 4130 Poisson's ratio; any A/B-basis value (licensed MMPDS only).
- Any embodied-carbon or price figure: none is used; CO₂ and cost appear only on synthetic materials.
- The ASM Handbook vol. 20 text itself (paywalled); exponents are proved analytically instead.
