# 06 E2E — Sources

Grades: **A** primary source read (official docs fetched) or read / counted in the llull repo; **B** one secondary extract
(search snippet, third-party page); **C** located, content not confirmed. Accessed 2026-10-28. Only grade A sources gate.

## External

| Id | Source | URL | Taken | Grade |
| -- | ------ | --- | ----- | ----- |
| R1 | Playwright — class `Electron` | https://playwright.dev/docs/api/class-electron | "experimental" support; Electron v21+; `launch` options `args`, `executablePath`, `env`, `cwd`, `recordVideo`, `timeout` (default 30 s), `chromiumSandbox` (default false), `tracesDir`; if launch times out, check that the `nodeCliInspect` (`EnableNodeCliInspectArguments`) fuse is not false; native dialogs are not intercepted — stub them in the main process with `electronApp.evaluate()`; `firstWindow()` | A |
| R2 | Electron — Automated Testing | https://www.electronjs.org/docs/latest/tutorial/automated-testing | no own test runner; WebdriverIO, Selenium, Playwright (experimental, via CDP); custom driver over a stdio IPC channel gated by an env var; WDIO finds electron-builder output; Playwright examples launch from source (`app.isPackaged` false) | A |
| R3 | Electron blog — Spectron deprecation notice | https://www.electronjs.org/blog/spectron-deprecation-notice | deprecated 2022-02-01, repo archived; alternatives Playwright and WebdriverIO | A |
| R4 | WebdriverIO — Electron service | https://webdriver.io/docs/desktop-testing/electron | auto-setup of Chromedriver; app path auto-detected for Forge / electron-builder; `appEntryPoint`, `appArgs` | A |
| R5 | WebdriverIO — Electron common issues | https://webdriver.io/docs/desktop-testing/electron/common-issues | CDP bridge relies on `--inspect`; with `EnableNodeCliInspectArguments` off, `browser.electron.execute()` and main log capture do not work, renderer testing does; recommends enabling the fuse only in test builds (`process.env.BUILD_FOR_TESTS`) | A |
| R6 | WebdriverIO — Electron API | https://webdriver.io/docs/desktop-testing/electron/api | `browser.electron.execute(fn)`, `browser.electron.mock('dialog', 'showOpenDialog')`; "no additional setup or imports are required" | A |
| R7 | Electron — Fuses | https://www.electronjs.org/docs/latest/tutorial/fuses | meaning of `runAsNode`, `nodeOptions`, `nodeCliInspect` (`--inspect*` flags and SIGUSR1), `embeddedAsarIntegrityValidation`, `onlyLoadAppFromAsar`; page silent on `--remote-debugging-port` | A |
| R8 | `@electron/fuses` README | https://github.com/electron/fuses | `npx @electron/fuses read --app <path>`; `write`; `flipFuses` after packaging, before signing; `resetAdHocDarwinSignature: true` on Apple Silicon when not re-signing | A |
| R9 | Electron — ASAR integrity | https://www.electronjs.org/docs/latest/tutorial/asar-integrity | validates the asar header hash at runtime; macOS (Electron ≥ 16, `Info.plist` `ElectronAsarIntegrity`) and Windows (Electron ≥ 30, resource `Integrity/ElectronAsar`); missing / mismatched hash → app forcibly shut down; pair with `onlyLoadAppFromAsar` | A |
| R10 | Electron — Supported command-line switches | https://www.electronjs.org/docs/latest/api/command-line-switches | `--remote-debugging-port`, `--enable-logging` documented; `--force-device-scale-factor`, `--use-angle`, `--user-data-dir` not listed; no complete list of Chromium switches | A |
| R11 | Chromium — Using Chromium with SwiftShader | https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md | CPU implementation of Vulkan / GLES; `--use-gl=angle --use-angle=swiftshader`; unsafe WebGL fallback `--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader`; automatic SwiftShader WebGL fallback deprecated | A |
| R12 | blink-dev — Intent to Remove: SwiftShader Fallback | https://groups.google.com/a/chromium.org/g/blink-dev/c/yhFguWS_3pM/m/oLrB5up_BwAJ | deprecation flagged in DevTools since Chrome 130 (via search extract) | C |
| R13 | Electron — Testing on headless CI | https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci | Electron needs a display driver on Linux; Xvfb / `xvfb-maybe`; nothing needed on Windows / macOS | A |
| R14 | Playwright — Visual comparisons | https://playwright.dev/docs/test-snapshots | `toHaveScreenshot`; rendering varies with OS, version, settings, hardware; baselines per browser + platform; `threshold` default 0.2; `stylePath`; `--update-snapshots` | A |
| R15 | Playwright — PageAssertions `toHaveScreenshot` | https://playwright.dev/docs/api/class-pageassertions | waits for two consecutive identical shots; `animations` default `disabled`; `caret` default `hide`; `mask`; `maxDiffPixelRatio`, `maxDiffPixels`; `scale` default `css`; `threshold` YIQ 0–1 default 0.2 | A |
| R16 | Playwright — Retries | https://playwright.dev/docs/test-retries | `retries` config; outcomes passed / flaky / failed; `test.describe.configure({ retries })`; `testInfo.retry` | A |
| R17 | GitHub Docs — GitHub-hosted runners | https://docs.github.com/en/actions/concepts/runners/github-hosted-runners | standard runners: Ubuntu, Windows, macOS; GPU-powered runners are "larger runners" on Team / Enterprise Cloud | A |
| R18 | GitHub changelog 2024-07-08 — GPU hosted runners GA | https://github.blog/changelog/2024-07-08-github-actions-gpu-hosted-runners-are-now-generally-available | GA for Windows and Linux with T4 GPUs | A |
| R19 | Electron — `contentTracing` | https://www.electronjs.org/docs/latest/api/content-tracing | main process, after `ready`; `startRecording(options)`, `stopRecording(path?)` → trace path; Perfetto protobuf format; `getCategories()`; `electron` category | A |
| R20 | Playwright — Accessibility testing | https://playwright.dev/docs/accessibility-testing | `@axe-core/playwright` `AxeBuilder({ page }).analyze()`; `withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa'])`; automated tests find only some problems | A |
| R21 | Electron — `DownloadItem` | https://www.electronjs.org/docs/latest/api/download-item | `setSavePath` only inside `will-download`; without it Electron "usually prompts a save dialog" | A |
| R22 | Electron — `crashReporter` | https://www.electronjs.org/docs/latest/api/crash-reporter | `uploadToServer: false` keeps reports locally; minidumps in `app.getPath('crashDumps')`; start as early as possible; covers later-created processes | A |
| R23 | Electron — `app` | https://www.electronjs.org/docs/latest/api/app | `render-process-gone`; `child-process-gone` (types Utility, GPU, …; reasons `clean-exit`, `abnormal-exit`, `killed`, `crashed`, `oom`, `launch-failed`, `integrity-failure`, `memory-eviction`); `setPath` (directory must exist) | A |
| R24 | Google Testing Blog — Flaky Tests at Google and How We Mitigate Them (2016) | https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html | page body not retrievable; only comments read (re-run limited to tests marked flaky) | C |
| R25 | Wang, Bovik, Sheikh, Simoncelli — Image quality assessment: from error visibility to structural similarity (SSIM), IEEE TIP 2004 | https://www.cns.nyu.edu/pub/lcv/wang03-preprint.pdf | located; PDF text not extracted in this session; used only for a non-gating report metric | C |
| R26 | electron-builder — Adding Electron fuses | https://electron.build/tutorials/adding-electron-fuses | `electronFuses` config in electron-builder (via search extract) | B |
| R27 | WebdriverIO desktop-mobile PR #481 | https://github.com/webdriverio/desktop-mobile/pull/481 | service moved to a shared native CDP bridge (search extract, June 2026); fuse requirement not re-checked | C |

## Code survey (llull repo, main f1351cff)

| Id | What | Where | Grade |
| -- | ---- | ----- | ----- |
| S1 | Main process: window 1440×900, sandbox, dialogs, single-instance lock, quit interception, main-error crash report, backend in `utilityProcess` with inherited stdio | `desktop/src/main.ts` | A |
| S2 | Release fuses (6 values) | `desktop/electron-builder.yml:51-60` | A |
| S3 | Menu template without ids; accelerators N / O / S / Shift+S | `desktop/src/menu.ts:25-63` | A |
| S4 | The desktop shell quits when the backend exits (no restart) | `docs/decisions/LC1-local-only.md` step 6 | A |
| S5 | Desktop crash report writer, `source: 'desktop-main'` | `desktop/src/crashes.ts` | A |
| S6 | Legacy browser suite: 7 specs, 30 tests; config (webServer, 1600×1000, retries CI 1, workers 1) | `tests/e2e/*.spec.ts`; `playwright.config.ts` | A (counted) |
| S7 | Live sync: command events with `stateHash`; `/live/snapshot`; `/live/ticket`; command log for crash reports | `packages/protocol/src/liveSync.ts`; `server/src/liveRoutes.ts`; `server/src/liveDocument.ts`; `server/src/liveCommandLog.ts` | A |
| S8 | Production UI driver; results 27 / 30 / 28 / 11; Chromium dropped 6 / 78 back-to-back anchor downloads (0 / 78 with 400 ms gap) | `tests/production/ui/session.ts:46-53`; `docs/PRODUCTION_GATE.md` Results | A |
| S9 | Quality gate 2 checks; 52 documents rendered without error; proposed gate 4 "pixel diff ≤ 0.5 %"; proposed gate 10 axe-core | `docs/QUALITY_GATES.md`; `tests/quality/display.gate.ts` | A |
| S10 | Bundled fonts (Hanken Grotesk 400–700, DM Mono 400, latin) ; canvas `dpr={[1, 2]}` | `src/main.tsx:5-9`; `src/ui/viewport/3d/Viewport3D.tsx:189`; `2d/Viewport2D.tsx:160` | A |
| S11 | CI: browser `e2e` job on ubuntu; `native-bundle` windows only, macOS deferred (owner 2026-10-19); desktop deps without Electron binary | `.github/workflows/check.yml` | A |
| S12 | Desktop tests run the backend without Electron (`child_process.fork`) | `desktop/tests/backend.e2e.test.ts:1-6` | A |
