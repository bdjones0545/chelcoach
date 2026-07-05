/**
 * Deterministic sample AnalysisReport (Phase 1 static loop).
 *
 * Mirrors the frontend's `src/data/mockData.ts` content verbatim so we can prove the
 * frontend → API swap has ZERO shape drift. `thumbnail` / `videoPoster` are intentionally
 * omitted (optional in the contract): the backend has no frame assets yet, and the
 * frontend keeps its local SVGs as fallbacks until Phase 3.
 *
 * The object is `analysisReportSchema.parse(...)`-validated at module load, so any drift
 * from the shared contract throws immediately when the server boots.
 */
import { analysisReportSchema, type AnalysisReport } from "../contract";

const sample: AnalysisReport = {
  scorecard: {
    chelRating: 742,
    percentile: "Top 18% of Players",
    overallGrade: "B-",
    eventsAnalyzed: 250,
    gameContext: "Your free coach-grade breakdown of your last uploaded game — every core skill graded, no sign-up required.",
    metrics: [
      { key: "offensive-iq", label: "Offensive IQ", value: 88, icon: "sports_hockey", tone: "good", note: "Elite spatial awareness in the offensive zone." },
      { key: "defense", label: "Defense", value: 63, icon: "shield", tone: "bad", note: "Struggles with gap control and board battles." },
      { key: "passing", label: "Passing", value: 91, icon: "sync_alt", tone: "good", note: "Top-tier distribution and outlet speed." },
      { key: "positioning", label: "Positioning", value: 58, icon: "location_on", tone: "bad", note: "Often caught deep or out of defensive rotation." },
      { key: "decision-making", label: "Decision Making", value: 81, icon: "psychology", tone: "good", note: "Quick reactions under pressure in the neutral zone." },
      { key: "puck-management", label: "Puck Management", value: 76, icon: "front_loader", tone: "warn", note: "Low turnover rate during the transition phase." },
    ],
    biggestStrength: {
      title: "Excellent puck movement under pressure",
      detail:
        "Your transition efficiency sits in the 95th percentile. You consistently find the open lane within 1.2s of gaining possession.",
    },
    biggestWeakness: {
      title: "Poor defensive positioning",
      detail:
        "You gave up four high-danger chances by over-committing to the strong side — opposition wingers found 25% more open ice in your zone. The full film shows every one.",
    },
  },
  coachingMoments: [
    {
      id: "moment-1",
      type: "great",
      label: "Great Play",
      timestamp: "8:42",
      period: "P2",
      title: "Neutral Zone Transition",
      teaser: "Textbook gap control at the red line turned defense into offense — here's exactly how you pulled it off.",
      fullBreakdown:
        "AI detected 94% efficiency in gap control during this transition. You maintained a tight stick-side seal and stepped up at the perfect moment to force the turnover. Maintain this gap control in man-up scenarios to convert defense into instant offense.",
    },
    {
      id: "moment-2",
      type: "missed",
      label: "Missed Opportunity",
      timestamp: "4:18",
      period: "P2",
      title: "Missed Passing Lane",
      teaser: "For 1.2 seconds a cross-crease look worth 0.68 xG was wide open. See the read you missed — and the tell that gives it away.",
      fullBreakdown:
        "The opponent's weak side was exposed for 1.2s with a cross-crease lane worth an expected-goals value of 0.68. Instead of scanning weak-side before receiving, you defaulted to the perimeter carry. Add a shoulder-check on zone entry to spot this look in real time.",
    },
    {
      id: "moment-3",
      type: "breakdown",
      label: "Defensive Breakdown",
      timestamp: "2:55",
      period: "P3",
      title: "Defensive Zone Disconnect",
      teaser: "One missed call on a line change handed them a 3-on-2 the other way. See the coverage that shuts it down.",
      fullBreakdown:
        "Communication failure during the line change left the weak-side lane uncovered and triggered a 3-on-2 rush. Your defensive cohesion dropped below the 40% threshold. Call the switch early and hold the middle of the ice on tired legs.",
    },
  ],
  filmRoom: {
    matchup: "Your Game — vs. Toronto",
    clipLabel: "P3 — 14:22",
    clipPhase: "Defensive Transition Phase",
    markers: [
      { position: 10, tone: "good", label: "Clean zone exit", timestamp: "1:24" },
      { position: 25, tone: "bad", label: "D-zone pinch", timestamp: "5:03" },
      { position: 45, tone: "good", label: "Neutral zone strip", timestamp: "8:42" },
      { position: 65, tone: "warn", label: "Perimeter carry", timestamp: "11:10" },
      { position: 85, tone: "bad", label: "Coverage lapse", timestamp: "14:18" },
    ],
    commentary:
      "Your positioning in the neutral zone is improving, but edge control during transitions is costing you roughly 0.4s on zone entries. Tighten the first three strides out of the defensive zone and you flip several of tonight's neutral-zone losses into clean exits.",
    strengths: [
      "Stick-checking accuracy up 14% vs. your average",
      "Back-check intensity sustained into the third period",
      "Vision on cross-seam passes creating high-danger looks",
    ],
    mistakes: [
      "Over-commitment on the defensive-zone pinch",
      "Narrow stance losing board battles",
      "Head-down on power-play zone entries",
    ],
    highestImpactAdjustment: {
      title: "Hold the middle of the ice on transitions",
      detail:
        "Nearly every high-danger chance against came from you chasing the puck to the wall. Staying middle-lane forces play to the perimeter and cuts your high-danger chances-against roughly in half.",
    },
    nextGameFocus:
      "Win the first three strides out of your zone. Prioritize a controlled exit over a hero stretch pass.",
    weeklySkillFocus: [
      { title: "Crossover Efficiency Drill", detail: "Focus on weight transfer — 3 sets of edge work before each session." },
      { title: "D-Zone Shadowing", detail: "Study elite defensive gap control and mirror it in your next two games." },
    ],
    gameSummary: [
      { label: "Ice Time", value: "22:14" },
      { label: "Top Speed", value: "34.2 km/h" },
      { label: "Pass Completion", value: "88%" },
      { label: "Shot Accuracy", value: "62%" },
    ],
    impactMeters: [
      { label: "Offensive Threat Rating", detail: "Possession time and dangerous chances", value: 78, score: "7.8", tone: "good" },
      { label: "Defensive Reliability", detail: "Gap control and successful zone exits", value: 92, score: "9.2", tone: "good" },
    ],
  },
};

/** Validated at load — throws on any drift from the shared contract. */
export const sampleReport: AnalysisReport = analysisReportSchema.parse(sample);
