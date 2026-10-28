# 01 PIL — Moderator guide (R1, R2, F)

Version PIL-M1. Tasks: [`pilot-tasks.json`](pilot-tasks.json). Instruments: [`../data/questionnaires.md`](../data/questionnaires.md).
Logs: [`../data/observation-log.csv`](../data/observation-log.csv), [`../data/field-log.csv`](../data/field-log.csv). Defects:
[`../data/defect-taxonomy.md`](../data/defect-taxonomy.md) → [`../data/defect-intake.csv`](../data/defect-intake.csv).

## Before any session

1. The participant passed the screener (FR-PIL-02), has a code `P-<profile>-<nn>`, and signed the consent form
   ([`../data/consent-form.md`](../data/consent-form.md)) on an earlier day or before anything else today. File the signed
   copy outside the data folder, together with the code key.
2. The machine runs the pinned pilot build (About shows the pre-release label and version). The data dir is empty, or a
   fresh `LLULL_DATA_DIR` is set.
3. Checkpoint files for "start" states are ready: the scripted production run of the profile's scenario, cut after the
   preceding task (generated once per build and hashed in the session sheet).

## R1: formative lab (≤ 2 h, think-aloud)

| Step | Moderator says / does | Time |
| ---- | --------------------- | ---- |
| 1 | "We are testing the software, not you. Please think aloud. I cannot help unless you are stuck for 3 minutes or ask to skip." | 3 min |
| 2 | The participant opens Help › Pilot diagnostics, reads the notice, ticks consent and starts recording **themselves**. Recording is optional: if they decline, the stopwatch log is the only time source | 3 min |
| 3 | For each task in order: read the goal **verbatim** and hand over the task card. The participant clicks *Start task*. The stopwatch starts on the last word of the goal. The task stops at *Done* / *Give up* / time limit | per task |
| 4 | After each task: SEQ, said aloud and written down | 30 s |
| 5 | After each critical task: raw TLX (6 sliders, paper) | 1 min |
| 6 | Log each observation: `slip`, `mistake`, `assist`, `defect`, `workaround`, with the time and a note (observation-log.csv) | ongoing |
| 7 | End: SUS (or F-SUS), then the closing interview | 10 min |
| 8 | Export the metrics with the participant, who reads the file and chooses to hand it over; then *Stop and delete* | 3 min |

Assist rule (R1): after 3 min without progress, or when asked, give the **smallest** hint ("look in the Site tab"). Log it
as `assist`. A task with an assist counts as **not completed** for EX-1 (R1 data are formative and not gated anyway).

## R2: confirmatory lab

Same tasks, new participants, no think-aloud, **no assist**. A participant who is stuck may skip, which counts as a failure.
The time limit is enforced. Everything else is as in R1.

## F: field phase (≥ 4 weeks)

1. Kickoff at the office. Choose one real job, finished or live, that the office also does (or did) in its incumbent tool.
   Before any work, write down the deliverables and their tolerances (a tolerance sheet signed by the office lead; P-CIV starts
   from the PILOT.md comparison table). Remind the office that the incumbent stays the master of record (FR-PIL-22).
2. The participant works in llull on the job. Each working session gets a row in `field-log.csv`: date, task, minutes in
   llull, minutes the same step took (or takes) in the incumbent, blocked yes/no, defect refs.
3. Weekly: the participant may export and send the metrics file (optional). A 15 min call collects defects.
4. Week 1 and closing week (≥ 4 weeks later): SUS, a timed replay of one job step in both tools, and the closing interview,
   including "Would you use llull on a live job? yes / with changes / no — why".
5. Deliverable comparison against the tolerance sheet (VC-PIL-16). Record the issue of any deliverable to a third party,
   made after the office's own check (VC-PIL-24).

## Data handling

- Only codes appear in logs and files. Never write names, client names or job addresses in any shared file.
- Metrics files come only from the participant's own export. Never copy them from the machine yourself.
- Raw data per round: one folder; sha256 of the zipped folder goes into the pilot report (VC-PIL-26). Keep it until the
  end date in the consent form, then delete.
