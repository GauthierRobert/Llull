# Pilot kit — evaluate llull on the sugar-factory model in a plant engineering office

This kit lets a process-plant office judge, in about half a day and without anyone from llull in the room, whether llull can
carry part of its real work. It uses the demonstration model of this folder. The automated gates say the tool does scripted jobs
correctly; only engineers doing their own tasks can say whether it is usable. That is what this pilot measures.

**What the model is, and is not.** A cane sugar factory (diffuser extraction, evaporation, boiling house, steam cycle) built only
with llull commands. Sizes, pressures and loads are the author's assumptions. The piping catalogue is demonstration data typed
from published tables and mostly unverified. Every result llull prints is marked "review required". Nothing here is a design.

## Who and how long

| Role                        | Time              | Brings                                                         |
| --------------------------- | ----------------- | -------------------------------------------------------------- |
| Piping engineer or designer | 90 min            | one finished isometric and line list from a past job           |
| Structural engineer         | 60 min            | one pipe-rack or equipment-support calculation from a past job |
| Process engineer            | 60 min            | one issued P&ID from a past job                                |
| Lead engineer (decision)    | 30 min at the end | the three feedback forms                                       |

Each person works alone on one machine, then fills in the form at the end of this page.

## Set-up (15 minutes, once per machine)

1. Install and open the llull desktop app ([DEPLOYMENT.md](../../DEPLOYMENT.md)). It runs offline.
2. Build the model into the open app (about three minutes):

   ```bash
   llull run docs/demo/sugar-factory/plant-1-equipment-steel.plan.json --app
   llull run docs/demo/sugar-factory/plant-2-piping-pid.plan.json --app
   ```

3. Save it with File › Save. The native kernel is needed; `llull kernel_info --app` must report the exact kernel as active.

Expected state after the build, to confirm the machine is right before judging anything:

| Check                             | Expected                                            |
| --------------------------------- | --------------------------------------------------- |
| `llull check_clashes --app`       | no clashes                                          |
| `llull check_pipe_supports --app` | 75 of 75 pipes pass                                 |
| `llull check_steel_members --app` | all analysed members pass, maximum utilisation 0.95 |
| `llull check_pid_3d --app`        | pass, 107 matched, nothing unmatched                |

If any of these differs, stop and report it: the pilot would be judging a broken set-up.

## Tasks

Do each task the way you would at work. Note the time it took, where you got stuck, and whether you would trust the output
enough to check it rather than redo it.

### Piping (90 minutes)

1. **Find your way.** Locate line `JC-1002-250` in the 3D view and on P&ID `PID-301`. Is it obvious which is which?
2. **Change a route.** Move the LP steam header `LS-2001-300` 500 mm sideways on the rack, or add an elbow pair. Do the supports and
   branches follow? Run `check_clashes` and `check_pipe_supports` again.
3. **Add a line.** Route a new DN100 line from a free pump nozzle to a tank nozzle of your choice with a gate valve and a check valve.
4. **Isometric.** Export the isometric of your new line (`export_isometric`). Compare it with the isometric you brought: dimensions,
   weld numbers, bill of material, cut list. What is missing for your fabricator?
5. **Stress.** Open the Stress panel. Change the HP steam line temperature from 420 to 450 degrees C and re-check. Does the result move
   the way you expect? Is the report (`pipe_stress_report`) something you could attach to a calculation note?
6. **Break it.** Put a pipe through a beam on purpose. Does `check_clashes` find it and name both items clearly?

### Structural (60 minutes)

1. **Read the check.** Run `check_steel_members` and open the result of the most loaded member (`BR41`). Can you follow the
   verification clause by clause, and does it match a hand check?
2. **Change a section.** Replace one rack column by a lighter profile until it fails. Is the failure reported where you expect?
3. **Loads.** Find what load a pipe support puts on its beam. Is the load path from pipe to foundation visible?
4. **Compare.** Rebuild one bent of the rack you brought from your past job and compare utilisations with your calculation.
5. **Deliverable.** Export a plan or an IFC of the steel. Would your detailer accept it?

### Process (60 minutes)

1. **Read a sheet.** Open `PID-801` (steam cycle). Are symbols, tags and line numbers what you expect from ISA 5.1?
2. **Edit.** Add a pressure transmitter and a control valve with its controller on a line of `PID-301`. Run `check_pid`.
3. **Consistency.** Rename a line on the P&ID only, then run `check_pid_3d`. Does it report the mismatch with the 3D model?
4. **Compare.** Redraw ten items of the P&ID you brought. How long did it take compared with your current tool?
5. **Data.** Export the line list and the equipment list. Are the columns the ones your office issues?

## What we already know is weak

Tell us if these matter to you; do not spend pilot time rediscovering them.

- The catalogue is demonstration data: do not judge quantities or weights.
- Boiler, turbo-alternator, mills, conveyors, dryer and clarifier are presentation geometry, not equipment models.
- Vapour ducts are plain pipe runs without fittings. Boiler feed water, condensate and bagasse handling are not modelled.
- Pictures are technical renders, not photo-realistic ones (planned: `docs/decisions/RV1-realistic-visualisation.md`).
- Results are never signed off by the tool: a qualified engineer reviews every one.

## Feedback form (one per person)

| Question                                                                        | Answer                     |
| ------------------------------------------------------------------------------- | -------------------------- |
| Role and years of experience                                                    |                            |
| Tool you use today for this work                                                |                            |
| Tasks completed (numbers)                                                       |                            |
| Tasks abandoned, and where                                                      |                            |
| Time per task against your usual tool (faster / same / slower)                  |                            |
| One result you checked by hand: did it agree? (what, your value, llull's value) |                            |
| One thing that would stop you using it on a real job                            |                            |
| One thing that surprised you positively                                         |                            |
| Would you check its output or redo it?                                          | check / redo               |
| Would you use it on a real job next month?                                      | yes / with conditions / no |

## Decision (lead engineer)

The pilot is a pass when, for at least two of the three roles: the tasks were completed without help, one hand check agreed, and the
answer to the last question is "yes" or "with conditions" with conditions that are listed. Send the three forms and the list of
conditions to your llull contact; each condition becomes a task with its own test.
