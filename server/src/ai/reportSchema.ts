/**
 * JSON Schema for Anthropic structured outputs.
 * Mirrors the shared AnalysisReport Zod contract with Anthropic constraints
 * (additionalProperties: false; no numeric min/max — Zod enforces ranges locally).
 */
export const analysisReportJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scorecard", "coachingMoments", "filmRoom"],
  properties: {
    scorecard: {
      type: "object",
      additionalProperties: false,
      required: [
        "chelRating",
        "percentile",
        "overallGrade",
        "eventsAnalyzed",
        "gameContext",
        "metrics",
        "biggestStrength",
        "biggestWeakness",
      ],
      properties: {
        chelRating: { type: "integer" },
        percentile: { type: "string" },
        overallGrade: { type: "string" },
        eventsAnalyzed: { type: "integer" },
        gameContext: { type: "string" },
        metrics: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "label", "value", "icon", "tone", "note"],
            properties: {
              key: { type: "string" },
              label: { type: "string" },
              value: { type: "number" },
              icon: { type: "string" },
              tone: { type: "string", enum: ["good", "warn", "bad"] },
              note: { type: "string" },
            },
          },
        },
        biggestStrength: {
          type: "object",
          additionalProperties: false,
          required: ["title", "detail"],
          properties: { title: { type: "string" }, detail: { type: "string" } },
        },
        biggestWeakness: {
          type: "object",
          additionalProperties: false,
          required: ["title", "detail"],
          properties: { title: { type: "string" }, detail: { type: "string" } },
        },
      },
    },
    coachingMoments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "label", "timestamp", "period", "title", "teaser", "fullBreakdown"],
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["great", "missed", "breakdown"] },
          label: { type: "string" },
          timestamp: { type: "string" },
          period: { type: "string" },
          title: { type: "string" },
          teaser: { type: "string" },
          fullBreakdown: { type: "string" },
          thumbnail: { type: "string" },
        },
      },
    },
    filmRoom: {
      type: "object",
      additionalProperties: false,
      required: [
        "matchup",
        "clipLabel",
        "clipPhase",
        "markers",
        "commentary",
        "strengths",
        "mistakes",
        "highestImpactAdjustment",
        "nextGameFocus",
        "weeklySkillFocus",
        "gameSummary",
        "impactMeters",
      ],
      properties: {
        matchup: { type: "string" },
        clipLabel: { type: "string" },
        clipPhase: { type: "string" },
        videoPoster: { type: "string" },
        markers: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["position", "tone", "label", "timestamp"],
            properties: {
              position: { type: "number" },
              tone: { type: "string", enum: ["good", "warn", "bad"] },
              label: { type: "string" },
              timestamp: { type: "string" },
            },
          },
        },
        commentary: { type: "string" },
        strengths: { type: "array", items: { type: "string" } },
        mistakes: { type: "array", items: { type: "string" } },
        highestImpactAdjustment: {
          type: "object",
          additionalProperties: false,
          required: ["title", "detail"],
          properties: { title: { type: "string" }, detail: { type: "string" } },
        },
        nextGameFocus: { type: "string" },
        weeklySkillFocus: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "detail"],
            properties: { title: { type: "string" }, detail: { type: "string" } },
          },
        },
        gameSummary: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "value"],
            properties: { label: { type: "string" }, value: { type: "string" } },
          },
        },
        impactMeters: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "detail", "value", "score", "tone"],
            properties: {
              label: { type: "string" },
              detail: { type: "string" },
              value: { type: "number" },
              score: { type: "string" },
              tone: { type: "string", enum: ["good", "warn", "bad"] },
            },
          },
        },
      },
    },
  },
} as const;
