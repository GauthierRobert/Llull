# PHY-22 MOV — Playback record (VC-MOV-10, OQ-MOV-01)

Machine: the owner's Windows 11 Home 10.0.26200 workstation. Spike file: a 1280×720, 30 fps, 300-frame AV1 MP4 of a synthetic
slider-crank (own ISOBMFF writer + `rav1e` 0.8.1, speed 10, 4×2 tiles; not llull output yet), `%TEMP%\mov-spike\spike_s10.mp4`
(sha256 of the packet stream `359084d2…7d41`; regenerate with `mov-spike 10 8 300 spike_s10.mp4`, `TC=4 TR=2`, see TECHNICAL_SPEC §13.2).

## Verified by the agent (2026-11-06, MOV-M0)

| Check                                       | Tool                                                                                                           | Result                                                                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container well-formed                       | `check_media.py` (bundled CPython, `-I`); first run of its MP4 branch on a real file                           | brand `isom`, codec `av01`, `av1C` present, 1280×720, 300 samples, timescale 30, 10.0 s                                                                                                            |
| Windows has an AV1 decoder                  | `Get-AppxPackage *AV1*`                                                                                        | `Microsoft.AV1VideoExtension` 2.0.35.0 installed (Store extension, not necessarily present on every Windows 11 install)                                                                            |
| Windows Media Foundation opens and plays it | `Windows.Media.Playback.MediaPlayer` (the engine of the Windows 11 Media Player) driven from PowerShell, muted | state `Opening` ≈ 2 s, then `Playing`, `NaturalVideoWidth × Height` 1280 × 720, `NaturalDuration` 10 s, `Position` advancing at real time (0.17 → 3.26 s over 3 s of wall clock); no `MediaFailed` |
| Chromium decodes the bitstream              | headless Microsoft Edge, `<video>` seeked to 5.0 s, screenshot                                                 | frame 150 decoded correctly (crank pointing left, rod, piston box, grid, background gradient); no decode error                                                                                     |

What these do not prove: that a human sees a correct, smooth picture in Media Player, or that PowerPoint accepts it. The agent cannot
watch playback.

## Owner steps (not done; record the result here, then answer OQ-MOV-01 in TECHNICAL_SPEC §11)

1. Double-click the spike MP4: Windows 11 Media Player plays it, the crank turns smoothly, no black or green frames, seek works.
2. PowerPoint: Insert → Video → This Device, insert the MP4, slideshow mode, play. Note the PowerPoint version and whether it plays
   inline or offers "convert". PowerPoint on Windows uses Media Foundation: it needs the same AV1 decoder as step 1.
3. Optional: a clean Windows 11 VM or a machine without `Microsoft.AV1VideoExtension`: does the MP4 play? (Decides whether H.264 via the OS encoder, V2 / OQ-MOV-02, moves into V1.)

| Date      | Player                            | Version | Plays | Notes |
| --------- | --------------------------------- | ------- | ----- | ----- |
| _pending_ | Media Player                      |         |       |       |
| _pending_ | PowerPoint                        |         |       |       |
| _pending_ | machine without the AV1 extension |         |       |       |
