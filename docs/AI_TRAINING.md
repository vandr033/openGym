# AI routines and training data

openGym has a routine format for plans made with an external AI and a separate, focused export
for analysing training history. Neither uses internal exercise IDs. These tools work without
enabling the optional server AI Coach.

## Import a routine from JSON

Open **Plan → Routines → Import Routine**. Paste JSON or choose a `.json` file, review the exercise
matches and schedule changes, then import. The screen also offers **Download JSON template**,
**Copy JSON template**, and **Copy ChatGPT prompt**.

The stable format identifier is `opengym-routine-v1`. Its shape is:

```json
{
  "format": "opengym-routine-v1",
  "name": "Upper Lower Hypertrophy",
  "schedule": [
    { "day": "monday", "routine": "Upper A" },
    { "day": "tuesday", "routine": "Lower A" },
    { "day": "thursday", "routine": "Upper A" },
    { "day": "friday", "routine": "Lower A" }
  ],
  "routines": [
    {
      "name": "Upper A",
      "deload": false,
      "exercises": [
        {
          "exercise": "Incline Dumbbell Bench Press",
          "sets": 3,
          "repRange": { "min": 8, "max": 12 },
          "weight": 30,
          "weightUnit": "kg",
          "warmupSets": 2,
          "restSeconds": 180,
          "progression": { "type": "double", "step": 2 },
          "notes": "2 RIR, controlled eccentric"
        },
        {
          "exercise": "Plank",
          "mode": "time",
          "sets": 3,
          "durationSeconds": 45,
          "restSeconds": 60,
          "progression": { "type": "time", "step": 5 },
          "notes": "Keep a straight line from head to heels"
        }
      ]
    },
    {
      "name": "Lower A",
      "deload": false,
      "exercises": [
        {
          "exercise": "Barbell Squat",
          "sets": 4,
          "repRange": { "min": 6, "max": 10 },
          "weight": 80,
          "weightUnit": "kg",
          "restSeconds": 180,
          "intensifier": { "type": "restpause", "totalReps": 12, "restSec": 15 },
          "progression": { "type": "double", "step": 2.5 },
          "notes": "Leave 1–2 reps in reserve"
        }
      ]
    }
  ]
}
```

`name` and `schedule` are optional. A schedule uses full weekday names and routine names from the
same JSON; omit it to keep the current weekly schedule. Each routine needs a unique name and 1–100
exercises. There can be 1–16 routines. Exercise values are:

| Field | Meaning |
|---|---|
| `exercise` | Conventional library name, or a name for a new custom exercise |
| `sets` | Number of planned sets; defaults to 3 |
| `mode` | Optional `"time"` for a timed hold; otherwise exercises use reps |
| `repRange` | Rep exercises only: `{ "min": 8, "max": 12 }`; `reps` can be used for one fixed target |
| `durationSeconds` | Timed holds only: integer from 5–3600; do not also provide `repRange` or `reps` |
| `weight` | Optional starting load |
| `weightUnit` | `kg` or `lb`; if omitted, the profile's current unit is used |
| `warmupSets` | Optional integer from 0–5; adds ramp-up sets before work, excluded from volume, records and progression |
| `restSeconds` | Optional rest duration from 1 to 3600 seconds |
| `progression` | Rep exercises: `double`, `linear`, `greyskull`, or `off`; timed holds: `time` or `off`. `step` is the load increment for reps or seconds for timed holds |
| `intensifier` | Rep exercises only: optional `{"type":"dropset","count":2,"pct":20}` or `{"type":"restpause","totalReps":12,"restSec":15}`; details below |
| `notes` | Optional plain-text exercise note |
| routine `deload` | `true` excludes the routine's exercises from normal progression |

`warmupSets` creates up to five ramp-up sets before the work sets. Each ramp closes half the
remaining gap to the work weight, and warm-ups do not count as work, volume, records or progression.
A drop-set uses `count` from 1–30 and `pct` from 5–90. It applies that many drops to **every** work
set; each drop is `pct` percent lighter than the previous load, with no rest between drops.
Rest-pause uses `totalReps` from 1–100 and `restSec` from 5–3600 seconds. It replaces the configured
set list with one automatic warm-up at the exercise's rep target and one work set. `totalReps` is the
work set's total, split into roughly halving bursts that sum to that number; `restSec` is the brief
rest between bursts. Do not combine rest-pause with `warmupSets`; rest-pause provides its own
warm-up. The `sets` value is unused for rest-pause exercises.

For example, this is a prompt you can paste into ChatGPT:

> Create a gym routine using the openGym JSON format below. Return only valid JSON. Do not include
> Markdown or internal exercise IDs. Use conventional exercise names. Include sets, rep ranges,
> rest times, progression type, progression step and notes where appropriate. Timed holds use
> `mode: "time"` and `durationSeconds` (5–3600), with no reps or rep range; their progression is
> `time` or `off`, and progression steps are seconds. `warmupSets` (0–5)
> adds ramp-up sets before work; they do not count as work, volume, records or progression. A
> drop-set uses `intensifier: {"type":"dropset","count":2,"pct":20}` (`count` 1–30, `pct` 5–90)
> and adds that many no-rest, progressively lighter drops to every work set. Rest-pause uses
> `intensifier: {"type":"restpause","totalReps":12,"restSec":15}` (`totalReps` 1–100,
> `restSec` 5–3600 seconds); it replaces the set list with one automatic warm-up and one work set
> split into short bursts summing to `totalReps`, with `restSec` between bursts. Do not combine
> rest-pause with `warmupSets`.

Use the full example above as the format reference, then add your training goal, available days,
equipment and preferences.

### Match review and routine safety

openGym normalizes spaces and capitalization for exact name matches, then uses its import aliases
and exercise search to suggest likely matches. Ambiguous names are left for you to choose. The
preview distinguishes exact, likely, ambiguous and unmatched entries; unmatched exercises can be
created as custom exercises. Review the proposed weekly schedule before checking **Apply this as
my weekly schedule**.

If an imported routine name already exists, choose **Create new version** (the default), **Replace**,
or **Cancel import**. Replace keeps the old routine as an archived definition and points its
current weekly and program schedules to the imported copy. Existing workouts remain in history.

## Program blocks and deloads

Create a block in **Plan → Programs**. A program has a name, start date and ordered phases. Set a
duration in weeks and a weekday-by-weekday routine schedule for each phase. Empty weekdays are rest
days. Mark a phase as a deload to keep its planned work out of normal progression. The active phase
is selected by date; Home shows the phase, week, today's routine and the next phase. Program
management includes **Switch now**, **Extend one week**, **Pause**, and **Resume**.

Day-specific overrides still take precedence over the program calendar. Without a selected active
program, the existing weekly schedule continues to apply. Finished workouts keep a snapshot of the
program and phase that were active when they started, so moving to a later phase does not rewrite
that session's history.

You can also start today's scheduled workout as a manual deload, or open a routine editor and use
**Generate deload version**. This creates a separate routine copy with configurable load and set
multipliers (defaults: 0.85 and 0.50). Loads are rounded using the exercise increment or plate grid;
the generated routine is excluded from progression. openGym does not infer when a deload is needed.

## Notes, readiness and discomfort

- **Set notes** are optional plain text, separate from exercise and session notes. Use the set
  number's menu while training; in history use **Edit set notes & discomfort** on an exercise.
- **Readiness** is an optional Energy, Sleep and Soreness check-in, each scored 1–5. Turn it on in
  **Settings → During a workout**. It can be skipped and never changes a routine automatically.
- **Discomfort** is optional set-level logging with None, Mild, Moderate or Severe and optional
  text. It records what you entered and does not give medical recommendations.

All of these fields are optional. Older profiles and workouts without them continue to load as
before. Notes, readiness and discomfort are preserved in backups and device sync.

## Export training data for AI

Go to **Settings → Data → Export Training Data for AI**. Choose Last 7 days, Last 14 days, Last 4
weeks, Last 6 weeks, or a custom inclusive date range. The compact JSON uses format
`opengym-training-export-v1` and includes workout and routine context, program/phase and deload
metadata, exercise targets and progression, sets, RIR/RPE, notes, PRs, body weight, readiness and
discomfort when available. It contains no unrelated profile settings. **Download CSV** provides
one row per set plus body-weight rows.

**Copy AI Prompt + Data** prepends this instruction:

> Analyze my training over this period. Look for progression trends, stalled exercises, repeated
> missed rep targets, major performance drops, fatigue patterns, whether a deload may be
> appropriate, load or rep-range adjustments, body-weight patterns, and RIR/RPE patterns. Do not
> make medical diagnoses.

For a narrower question, open an exercise's **History** and choose **Copy history for AI**. It copies
the latest 6–10 sessions for that exercise with logged sets, effort, notes and a progression
decision.

## Formats and persisted fields

The external formats introduced here are `opengym-routine-v1`, `opengym-training-export-v1`, and
`opengym-exercise-history-v1`. No destructive profile migration or storage schema version was
added. New profile, workout, entry and set fields are optional; old saved data is left intact.
