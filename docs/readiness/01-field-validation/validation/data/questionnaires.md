# 01 PIL — Instruments and CSV layout

All responses are keyed by participant code, round (`R1` / `R2` / `F1` / `F4`) and language (`en` / `fr` / `nl`).

## SEQ — after each task [R7]

"Overall, how difficult or easy was the task to complete?" 1 = very difficult … 7 = very easy (only the ends labelled).
Asked immediately after the task attempt, including failed ones.

## SUS — after each session [R6][R30]

Five-point agreement, 1 = strongly disagree … 5 = strongly agree. Items (Brooke; wording to be cross-checked against [R6]
at M0):

1. I think that I would like to use this system frequently.
2. I found the system unnecessarily complex.
3. I thought the system was easy to use.
4. I think that I would need the support of a technical person to be able to use this system.
5. I found the various functions in this system were well integrated.
6. I thought there was too much inconsistency in this system.
7. I would imagine that most people would learn to use this system very quickly.
8. I found the system very cumbersome to use.
9. I felt very confident using the system.
10. I needed to learn a lot of things before I could get going with this system.

"System" is replaced by "llull" in the printed form. French speakers get the F-SUS of Gronier & Baudet (2021) verbatim
[R20]. Dutch speakers get the English version until a validated Dutch translation is chosen (TECHNICAL Q7).

Scoring (analysis script): odd items r − 1; even items 5 − r; sum × 2.5. A missing item invalidates the response, which is
reported as missing, never imputed.

## Raw NASA-TLX — after each critical task [R13]

Six 0–100 scales in steps of 5: mental demand, physical demand, temporal demand, performance (0 = perfect, 100 = failure),
effort, frustration. Raw TLX = mean of the six. No pairwise weighting. Diagnostic only, not gating.

## Closing interview (fixed questions)

1. What blocked you today?
2. What does your current tool do better?
3. What does llull do better?
4. What is missing for your national standard or office practice?
5. Would you use llull on a live job? yes / with changes / no — why? (EX-6 counts "yes" + "with changes")

## CSV layout (`responses.csv`)

```text
code,round,lang,instrument,taskId,item,value,timestamp
P-CIV-03,R2,fr,SEQ,T-CIV-03,,6,2027-01-14T10:42
P-CIV-03,R2,fr,SUS,,1,4,2027-01-14T11:50
P-CIV-03,R2,fr,TLX,T-CIV-08,mental,45,2027-01-14T11:31
P-CIV-03,F4,fr,INTERVIEW,,5,with changes,2027-02-20T16:05
```

(The rows above show the format; they are not data.)
