// Centralised mock data for the ChelCoach MVP.
// No real AI / video processing — everything here is polished placeholder content
// so we can build the full product & conversion experience first.
//
// Imagery is local: SVG tactical stills in ../assets (no remote/network dependencies).
import momentGreat from "../assets/moment-great.svg";
import momentMissed from "../assets/moment-missed.svg";
import momentBreakdown from "../assets/moment-breakdown.svg";
import filmPoster from "../assets/film-poster.svg";

export type MetricTone = "good" | "warn" | "bad";

export interface Metric {
  key: string;
  label: string;
  value: number;
  icon: string;
  tone: MetricTone;
  note: string;
}

export interface Scorecard {
  chelRating: number;
  percentile: string;
  overallGrade: string;
  eventsAnalyzed: number;
  gameContext: string;
  metrics: Metric[];
  biggestStrength: {
    title: string;
    detail: string;
  };
  biggestWeakness: {
    title: string;
    detail: string;
  };
}

export type MomentType = "great" | "missed" | "breakdown";

export interface CoachingMoment {
  id: string;
  type: MomentType;
  label: string;
  timestamp: string;
  period: string;
  title: string;
  teaser: string;
  /** Full explanation — gated behind the paywall in the preview screen. */
  fullBreakdown: string;
  thumbnail: string;
}

export interface PaywallBenefit {
  icon: string;
  title: string;
  detail: string;
}

// --- Free Gameplay Scorecard -------------------------------------------------

export const scorecard: Scorecard = {
  chelRating: 742,
  percentile: "Top 18% of Players",
  overallGrade: "B-",
  eventsAnalyzed: 250,
  gameContext: "Your free coach-grade breakdown of your last uploaded game — every core skill graded, no sign-up required.",
  metrics: [
    {
      key: "offensive-iq",
      label: "Offensive IQ",
      value: 88,
      icon: "sports_hockey",
      tone: "good",
      note: "Elite spatial awareness in the offensive zone.",
    },
    {
      key: "defense",
      label: "Defense",
      value: 63,
      icon: "shield",
      tone: "bad",
      note: "Struggles with gap control and board battles.",
    },
    {
      key: "passing",
      label: "Passing",
      value: 91,
      icon: "sync_alt",
      tone: "good",
      note: "Top-tier distribution and outlet speed.",
    },
    {
      key: "positioning",
      label: "Positioning",
      value: 58,
      icon: "location_on",
      tone: "bad",
      note: "Often caught deep or out of defensive rotation.",
    },
    {
      key: "decision-making",
      label: "Decision Making",
      value: 81,
      icon: "psychology",
      tone: "good",
      note: "Quick reactions under pressure in the neutral zone.",
    },
    {
      key: "puck-management",
      label: "Puck Management",
      value: 76,
      icon: "front_loader",
      tone: "warn",
      note: "Low turnover rate during the transition phase.",
    },
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
};

// --- Locked Film Preview -----------------------------------------------------

export const coachingMoments: CoachingMoment[] = [
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
    thumbnail: momentGreat,
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
    thumbnail: momentMissed,
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
    thumbnail: momentBreakdown,
  },
];

// --- AI Processing screen ----------------------------------------------------

export const processingMessages: string[] = [
  "Reviewing positioning...",
  "Evaluating defensive coverage...",
  "Analyzing offensive decisions...",
  "Identifying scoring opportunities...",
  "Comparing your tendencies...",
  "Building your coaching report...",
];

// --- Paywall -----------------------------------------------------------------

// Outcome-based — each title is the result the player gets, the detail is how.
export const paywallBenefits: PaywallBenefit[] = [
  {
    icon: "error",
    title: "Know exactly what cost you the game",
    detail: "Every high-danger chance you allowed, ranked by how many goals it actually cost.",
  },
  {
    icon: "psychology",
    title: "Read the ice like a pro",
    detail: "AI commentary shows the smarter read on every play, in plain hockey language.",
  },
  {
    icon: "movie_filter",
    title: "Rewatch every mistake on film",
    detail: "Jump straight to each tagged moment on an interactive timeline — no scrubbing.",
  },
  {
    icon: "event_note",
    title: "Walk into your next game with a plan",
    detail: "A weekly focus built from your own film, so you know what to fix before puck drop.",
  },
  {
    icon: "fitness_center",
    title: "Practice the right things",
    detail: "Personalized drills mapped to the exact mistakes in your uploads.",
  },
  {
    icon: "trending_up",
    title: "Watch your Chel Rating climb",
    detail: "Track your rating and skill grades improving game over game.",
  },
  {
    icon: "cloud_upload",
    title: "Break down every game you play",
    detail: "Unlimited uploads build a season-long tactical profile of how you play.",
  },
  {
    icon: "verified",
    title: "Coaching tuned to you",
    detail: "Insights sharpen the more you upload — built around your tendencies, not generic tips.",
  },
];

// --- Full Film Room ----------------------------------------------------------

export interface TimelineMarker {
  position: number; // percentage along the track
  tone: MetricTone;
  label: string;
  timestamp: string;
}

export const filmRoom = {
  matchup: "Your Game — vs. Toronto",
  clipLabel: "P3 — 14:22",
  clipPhase: "Defensive Transition Phase",
  videoPoster: filmPoster,
  markers: [
    { position: 10, tone: "good", label: "Clean zone exit", timestamp: "1:24" },
    { position: 25, tone: "bad", label: "D-zone pinch", timestamp: "5:03" },
    { position: 45, tone: "good", label: "Neutral zone strip", timestamp: "8:42" },
    { position: 65, tone: "warn", label: "Perimeter carry", timestamp: "11:10" },
    { position: 85, tone: "bad", label: "Coverage lapse", timestamp: "14:18" },
  ] as TimelineMarker[],
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
    {
      title: "Crossover Efficiency Drill",
      detail: "Focus on weight transfer — 3 sets of edge work before each session.",
    },
    {
      title: "D-Zone Shadowing",
      detail: "Study elite defensive gap control and mirror it in your next two games.",
    },
  ],
  gameSummary: [
    { label: "Ice Time", value: "22:14" },
    { label: "Top Speed", value: "34.2 km/h" },
    { label: "Pass Completion", value: "88%" },
    { label: "Shot Accuracy", value: "62%" },
  ],
  impactMeters: [
    { label: "Offensive Threat Rating", detail: "Possession time and dangerous chances", value: 78, score: "7.8", tone: "good" as MetricTone },
    { label: "Defensive Reliability", detail: "Gap control and successful zone exits", value: 92, score: "9.2", tone: "good" as MetricTone },
  ],
};

// --- Report assembly ---------------------------------------------------------
// The full analysis report the UI consumes. Mirrors the shared Analysis Contract
// (scorecard + coachingMoments + filmRoom). Screens read from here (via the report
// source) so the same shape can later come from the backend with zero drift.

export type FilmRoom = typeof filmRoom;

export interface GameReport {
  scorecard: Scorecard;
  coachingMoments: CoachingMoment[];
  filmRoom: FilmRoom;
}

/** Local SVG fallbacks used when the API omits imagery (Phase 3 fills these for real). */
export const momentThumbnailByType: Record<MomentType, string> = {
  great: momentGreat,
  missed: momentMissed,
  breakdown: momentBreakdown,
};
export const defaultVideoPoster: string = filmPoster;

/** The default (mock) report — identical behavior to before the report source existed. */
export const mockReport: GameReport = { scorecard, coachingMoments, filmRoom };

// --- Upload rules ------------------------------------------------------------

export const uploadRules = {
  acceptExtensions: [".mp4", ".mov"],
  acceptMimeTypes: ["video/mp4", "video/quicktime"],
  // value for the <input accept="…"> attribute
  accept: "video/mp4,video/quicktime,.mp4,.mov",
  // Keep in sync with shared/analysisContract.ts uploadRules (250 MB Phase-3 cap).
  maxBytes: 250 * 1024 ** 2, // 250 MB
  maxLabel: "250 MB",
};

// --- UX state copy (validation errors, empty & failure states) ---------------
// Every message answers: what happened, what to do next, how to continue.

export const uploadErrors = {
  unsupported: (name: string) =>
    `"${name}" isn't a supported clip. ChelCoach reads MP4 and MOV files — export your gameplay in one of those and try again.`,
  oversized: (name: string, size: string) =>
    `"${name}" is ${size}, over the ${uploadRules.maxLabel} limit. Trim it to a single game or re-export at a lower bitrate, then upload again.`,
  empty: "That file didn't come through. Pick an MP4 or MOV clip to continue.",
};

export interface StatePanelCopy {
  icon: string;
  tone: "neutral" | "error";
  title: string; // what happened
  message: string; // what to do next
  primaryLabel: string; // how to continue
  secondaryLabel: string;
}

export const stateCopy: Record<
  | "processingFailed"
  | "processingTimeout"
  | "processingUnreachable"
  | "processingInvalid"
  | "filmRoomEmpty"
  | "dataUnavailable",
  StatePanelCopy
> = {
  processingFailed: {
    icon: "sync_problem",
    tone: "error",
    title: "Analysis interrupted",
    message:
      "The review stopped before it finished. Your clip is still on file — check status again, or go back to upload and start a new analysis.",
    primaryLabel: "Check Status Again",
    secondaryLabel: "Back to Upload",
  },
  processingTimeout: {
    icon: "hourglass_disabled",
    tone: "error",
    title: "This is taking too long",
    message:
      "We didn't get a finished report in time. Your clip may still be processing — check status again, or return to upload.",
    primaryLabel: "Check Status Again",
    secondaryLabel: "Back to Upload",
  },
  processingUnreachable: {
    icon: "cloud_off",
    tone: "error",
    title: "Can't reach the analysis service",
    message:
      "ChelCoach couldn't reach the server for a status update. Check your connection, then try checking status again.",
    primaryLabel: "Check Status Again",
    secondaryLabel: "Back to Upload",
  },
  processingInvalid: {
    icon: "error",
    tone: "error",
    title: "We got an unexpected response",
    message:
      "The analysis service returned something we couldn't use. This isn't your demo report — head back to upload and try again.",
    primaryLabel: "Back to Upload",
    secondaryLabel: "Start Over",
  },
  filmRoomEmpty: {
    icon: "movie_filter",
    tone: "neutral",
    title: "No game in the film room yet",
    message:
      "Upload a clip and ChelCoach breaks down every shift — tagged coaching moments, an interactive timeline, and your next-game plan.",
    primaryLabel: "Analyze a Game",
    secondaryLabel: "View Demo Report",
  },
  dataUnavailable: {
    icon: "cloud_off",
    tone: "error",
    title: "We couldn't load this report",
    message:
      "Your analysis data didn't come through this time. Re-run the analysis and ChelCoach will rebuild your breakdown.",
    primaryLabel: "Re-run Analysis",
    secondaryLabel: "Back to Scorecard",
  },
};
