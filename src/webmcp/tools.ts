/**
 * ChelCoach's WebMCP tool surface.
 *
 * Every tool is a read over the analysis the user is already looking at.
 * Nothing here uploads a clip, starts an analysis, or unlocks premium.
 *
 * Entitlements are enforced here, not left to the caller. ChelCoach shows a
 * moment's teaser to everyone and its full coaching breakdown only when the
 * moment is unlocked, and the film room requires a completed analysis. These
 * tools apply the same rules, so an agent cannot read past a gate the UI holds
 * shut.
 */
import type { CoachingMoment, GameReport } from "../data/mockData";
import { defineReadOnlyTool, type WebMcpTool } from "./runtime";

export type ChelCoachSnapshot = {
  report: GameReport;
  source: "mock" | "api";
  isPremium: boolean;
  hasAnalysis: boolean;
};

const NO_ANALYSIS =
  "No completed analysis in this session. Ask the person to upload a gameplay clip and let it finish processing first.";

/**
 * Mirrors FilmPreview's rule: highlight moments are open to everyone, the rest
 * need premium.
 */
function isUnlocked(moment: CoachingMoment, isPremium: boolean): boolean {
  return isPremium || moment.type === "great";
}

export function buildChelCoachTools(
  getSnapshot: () => ChelCoachSnapshot,
): readonly WebMcpTool[] {
  return [
    defineReadOnlyTool({
      name: "chelcoach_get_analysis_status",
      title: "Get analysis status",
      description:
        "Report whether this session has a completed gameplay analysis, whether premium is unlocked, and whether the report came from the backend or the built-in sample. Call this first to find out which other tools will return data.",
      read() {
        const { hasAnalysis, isPremium, source } = getSnapshot();
        return {
          hasAnalysis,
          isPremium,
          reportSource: source,
          note:
            source === "mock"
              ? "This is ChelCoach's built-in sample report, not a real analysis of the user's gameplay."
              : "This report came from the ChelCoach backend.",
        };
      },
    }),

    defineReadOnlyTool({
      name: "chelcoach_get_scorecard",
      title: "Get gameplay scorecard",
      description:
        "Get the gameplay scorecard: CHEL rating, percentile, overall grade, every graded metric with its note, and the single biggest strength and weakness of the game.",
      read() {
        const { report, source } = getSnapshot();
        const { scorecard } = report;
        return {
          reportSource: source,
          chelRating: scorecard.chelRating,
          percentile: scorecard.percentile,
          overallGrade: scorecard.overallGrade,
          eventsAnalyzed: scorecard.eventsAnalyzed,
          gameContext: scorecard.gameContext,
          metrics: scorecard.metrics.map((metric) => ({
            key: metric.key,
            label: metric.label,
            value: metric.value,
            tone: metric.tone,
            note: metric.note,
          })),
          biggestStrength: scorecard.biggestStrength,
          biggestWeakness: scorecard.biggestWeakness,
        };
      },
    }),

    defineReadOnlyTool<{ type?: string }>({
      name: "chelcoach_list_coaching_moments",
      title: "List coaching moments",
      description:
        "List the coaching moments found in the clip — great plays, missed chances and breakdowns — each with its timestamp and teaser. The full coaching breakdown is included only for moments the user has unlocked; locked ones are reported as locked rather than revealed.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["great", "missed", "breakdown"],
            description: "Restrict to a single moment type.",
          },
        },
      },
      read({ type }) {
        const { report, isPremium } = getSnapshot();
        const moments = report.coachingMoments
          .filter((moment) => !type || moment.type === type)
          .map((moment) => {
            const unlocked = isUnlocked(moment, isPremium);
            return {
              id: moment.id,
              type: moment.type,
              label: moment.label,
              period: moment.period,
              timestamp: moment.timestamp,
              title: moment.title,
              teaser: moment.teaser,
              locked: !unlocked,
              fullBreakdown: unlocked ? moment.fullBreakdown : undefined,
            };
          });

        const lockedCount = moments.filter((moment) => moment.locked).length;
        return {
          count: moments.length,
          lockedCount,
          moments,
          ...(lockedCount > 0 && {
            note: `${lockedCount} moment(s) need ChelCoach premium before their full coaching breakdown can be read.`,
          }),
        };
      },
    }),

    defineReadOnlyTool({
      name: "chelcoach_get_film_room_breakdown",
      title: "Get film room breakdown",
      description:
        "Get the full film room breakdown for the analyzed clip: strengths, mistakes, the highest-impact adjustment, next-game focus, weekly skill drills, game summary stats and impact meters. Requires a completed analysis.",
      read() {
        const { report, hasAnalysis } = getSnapshot();
        if (!hasAnalysis) return { error: NO_ANALYSIS };

        const { filmRoom } = report;
        return {
          matchup: filmRoom.matchup,
          clipLabel: filmRoom.clipLabel,
          clipPhase: filmRoom.clipPhase,
          commentary: filmRoom.commentary,
          strengths: filmRoom.strengths,
          mistakes: filmRoom.mistakes,
          highestImpactAdjustment: filmRoom.highestImpactAdjustment,
          nextGameFocus: filmRoom.nextGameFocus,
          weeklySkillFocus: filmRoom.weeklySkillFocus,
          gameSummary: filmRoom.gameSummary,
          impactMeters: filmRoom.impactMeters.map((meter) => ({
            label: meter.label,
            detail: meter.detail,
            value: meter.value,
            score: meter.score,
            tone: meter.tone,
          })),
          timelineMarkers: filmRoom.markers.map((marker) => ({
            timestamp: marker.timestamp,
            label: marker.label,
            tone: marker.tone,
          })),
        };
      },
    }),
  ];
}
