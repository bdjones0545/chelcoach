# Scotty Step 8 — Complete coaching report experience

Step 8 turns the persisted `ScottyReport` into a coach-led gameplay review.
The Postgres-backed report remains authoritative. The frontend organizes and
presents — it never invents observations, scores, controls, or faceoff outcomes.

**Out of scope:** Cloudflare, live Scotty, callbacks, report comparison/sharing,
PDF export, persistent drill tracking, Step 9 E2E.

## Report hierarchy

```text
Header
→ Executive coaching summary
→ Performance focus areas (evidence counts; no invented scores)
→ What you did well
→ Biggest opportunities
→ Key gameplay moments
→ Tactical / strategic review
→ Position-specific coaching
→ Controls and mechanics
→ Faceoffs (when present)
→ Practice plan
→ Next-game focus
→ About this analysis
```

## Authority

| Source | Role |
|---|---|
| `GET /api/analysis/:id/report` envelope | Report + safe media context |
| `ScottyReport` | Coaching content |
| Presentation adapter | Grouping, labels, navigation |
| Local drill state | Presentation-only completion UI |

## Report API envelope

```ts
{
  applicationRequestId,
  uploadId,
  report, // ScottyReport
  sourceMediaAvailable,
  sourceMediaExpiresAt?,
  mediaClassification?,
  mediaDurationSec?,
  platform?,
  controlScheme?,
  gameMode?,
  simulatorMode? // non-production only
}
```

No storage keys, owner IDs, fingerprints, or provider URLs.

## Presentation adapter

`buildCoachingReportView(payload)` in `src/lib/coachingReportView.ts`:

* maps strengths / priorities into coaching cards,
* classifies moments with textual severity labels,
* builds focus areas from observation categories (counts only),
* isolates platform/control schemes,
* omits faceoffs when count is zero,
* links drills to priorities when mechanics match,
* derives next-game focus from report content,
* builds navigation that skips absent sections.

## Evidence navigation

Timestamp buttons select an active evidence note. Secure byte-range video
playback is **deferred** — the report remains fully usable after media deletion.

## Platform / control isolation

Xbox and PlayStation guidance never mix. Total Control and Skill Stick remain
separated. Unverified inputs show conceptual coaching without invented buttons.

## Accessibility & print

* Semantic `main` / `nav` / `section` / `article` / `aside`
* Score/focus visuals include text equivalents
* Timestamp buttons have descriptive accessible names
* Print CSS keeps summary, strengths, priorities, practice plan, next-game focus
* Interactive controls hidden in print

## Remaining risks

* No numeric overall score in the Scotty contract — omitted honestly
* Video playback foundation is UI-only until a secure media route lands
* Drill completion is local / presentation-only
* Simulator observation copy is still somewhat generic

## Step 9 inputs

* Durable report route + envelope
* Presentation adapter and section test IDs
* Simulator fixtures (Xbox / PlayStation / faceoff / short clip)
* Status + report reload recovery from Step 7
