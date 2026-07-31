import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SCOTTY_CONTRACT_VERSION,
  isCompatibleContractVersion,
  scottyAnalysisRequestSchema,
  assertDurationAllowed,
  resolveTrustedDuration,
  assertNoRawMediaFields,
  rawUploadMetadataSchema,
  toPublicUploadView,
  SCOTTY_MAX_DURATION_SEC,
  validatePlatformControlCombination,
  controlledPlayerIdentificationSchema,
  playerConfirmationRequestSchema,
  strategyAnalysisSchema,
  faceoffAnalysisSchema,
  controlGuidanceSchema,
  scottyReportSchema,
  scottyErrorResponseSchema,
  scottyErrorMessage,
  practiceDrillListSchema,
  MAX_PRACTICE_DRILLS,
  calculateExpiresAt,
  calculateAbsoluteDeleteAt,
  evaluateRetention,
  DEFAULT_MEDIA_RETENTION_POLICY,
  mediaRetentionPolicySchema,
  classifyMediaDuration,
  defaultGameplayProfile,
  gameplayProfileUpdateSchema,
  createUploadSessionRequestSchema,
  buildGameContextFromSelection,
  isGameAcceptableForUpload,
  RELEASED_NOT_SUPPORTED_MESSAGE,
  findGameById,
  boundingBoxSchema,
  publicPlayerIdentificationSchema,
  MAX_PLAYER_CANDIDATES,
  mediaTransferDescriptorSchema,
  scottyCallbackEventSchema,
  scottyAnalysisSubmissionSchema,
  applicationAnalysisSubmissionResultSchema,
} from "./index";
import {
  FIXED_NOW,
  xboxPlayerContext,
  playstationPlayerContext,
  sampleGameContext,
  trustedMedia,
  xboxControlGuidance,
  minimalScottyReport,
} from "./fixtures";

function baseUpload(durationSec: number) {
  const createdAt = FIXED_NOW;
  const policy = DEFAULT_MEDIA_RETENTION_POLICY;
  return rawUploadMetadataSchema.parse({
    uploadId: "upload-1",
    ownerId: "owner-1",
    originalFilename: "My Game.MP4",
    displayFilename: "my-game.mp4",
    mimeType: "video/mp4",
    byteSize: 50_000_000,
    durationSec,
    trustedMedia: trustedMedia(durationSec),
    storageProvider: "memory",
    storageObjectKey: "clips/upload-1/source.mp4",
    uploadStatus: "ready",
    createdAt: createdAt.toISOString(),
    uploadedAt: createdAt.toISOString(),
    expiresAt: calculateExpiresAt(createdAt, policy).toISOString(),
    absoluteDeleteAt: calculateAbsoluteDeleteAt(createdAt, policy).toISOString(),
    deletionAttemptCount: 0,
    retentionPolicyVersion: policy.policyVersion,
  });
}

describe("Scotty contracts — media duration", () => {
  it("accepts a valid short clip contract", () => {
    const req = scottyAnalysisRequestSchema.parse({
      contractVersion: SCOTTY_CONTRACT_VERSION,
      requestId: "req-1",
      idempotencyKey: "idem-1",
      ownerId: "owner-1",
      uploadId: "upload-1",
      mediaClassification: "short_clip",
      gameContext: sampleGameContext(),
      playerContext: xboxPlayerContext(),
      mediaMetadata: trustedMedia(90),
      createdAt: FIXED_NOW.toISOString(),
    });
    assert.equal(req.mediaClassification, "short_clip");
    assert.equal(req.mediaMetadata.durationSec, 90);
  });

  it("accepts a valid 30-minute full-game contract", () => {
    const upload = baseUpload(1800);
    assert.equal(upload.durationSec, 1800);
    const req = scottyAnalysisRequestSchema.parse({
      contractVersion: SCOTTY_CONTRACT_VERSION,
      requestId: "req-2",
      idempotencyKey: "idem-2",
      ownerId: "owner-1",
      uploadId: upload.uploadId,
      mediaClassification: "full_game",
      gameContext: sampleGameContext(),
      playerContext: xboxPlayerContext(),
      mediaMetadata: trustedMedia(1800),
      createdAt: FIXED_NOW.toISOString(),
    });
    assert.equal(req.mediaClassification, "full_game");
  });

  it("accepts duration exactly 1,800 seconds", () => {
    assert.equal(assertDurationAllowed(1800).ok, true);
    assert.equal(trustedMedia(SCOTTY_MAX_DURATION_SEC).durationSec, 1800);
  });

  it("rejects duration over 1,800 seconds", () => {
    assert.equal(assertDurationAllowed(1801).ok, false);
    assert.throws(() => trustedMedia(1801).durationSec && rawUploadMetadataSchema.parse({
      ...baseUpload(1800),
      durationSec: 1801,
      trustedMedia: { ...trustedMedia(1800), durationSec: 1801 },
    }));
  });

  it("trusted duration overrides false client metadata", () => {
    const resolved = resolveTrustedDuration({
      trustedDurationSec: 120,
      clientDeclaredDurationSec: 9999,
    });
    assert.equal(resolved, 120);
    assert.equal(assertDurationAllowed(resolved!).ok, true);
    assert.equal(assertDurationAllowed(9999).ok, false);
  });

  it("raw video bytes cannot be persisted in metadata schemas", () => {
    assert.throws(() => assertNoRawMediaFields({ bytes: Buffer.from("x") }));
    assert.throws(() => assertNoRawMediaFields({ base64: "aaaa" }));
    assert.throws(() =>
      rawUploadMetadataSchema.parse({
        ...baseUpload(60),
        ...({ videoBytes: "nope" } as Record<string, unknown>),
      }),
    );
  });
});

describe("Scotty contracts — versioning", () => {
  it("accepts the current contract version", () => {
    assert.equal(isCompatibleContractVersion(SCOTTY_CONTRACT_VERSION), true);
    assert.equal(isCompatibleContractVersion("1.9.9"), true);
  });

  it("rejects an unsupported major contract version", () => {
    assert.equal(isCompatibleContractVersion("2.0.0"), false);
    assert.equal(isCompatibleContractVersion("0.9.0"), false);
    assert.equal(isCompatibleContractVersion("nope"), false);
  });
});

describe("Scotty contracts — player / platform", () => {
  it("validates Xbox player context", () => {
    const ctx = xboxPlayerContext();
    assert.equal(validatePlatformControlCombination(ctx).ok, true);
  });

  it("validates PlayStation player context", () => {
    const ctx = playstationPlayerContext();
    assert.equal(validatePlatformControlCombination(ctx).ok, true);
  });

  it("rejects invalid platform-control combination", () => {
    const bad = xboxPlayerContext({ controlScheme: "goalie", position: "C" });
    const result = validatePlatformControlCombination(bad);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "INVALID_PLATFORM_CONTROL_COMBINATION");
  });

  it("validates controlled-player identification", () => {
    const id = controlledPlayerIdentificationSchema.parse({
      detected: true,
      confidence: 0.82,
      confidenceLabel: "high",
      position: "C",
      jerseyNumber: 19,
      indicatorColor: "blue",
      teamSide: "home",
      evidenceTimestampsSec: [10, 20],
      evidenceSummaries: ["Blue indicator near #19"],
      uncertainties: ["Away jersey briefly occluded"],
      userConfirmed: false,
      confirmationRequired: true,
      candidateId: "cand-1",
    });
    assert.equal(id.confirmationRequired, true);
  });

  it("validates player confirmation", () => {
    const conf = playerConfirmationRequestSchema.parse({
      contractVersion: SCOTTY_CONTRACT_VERSION,
      jobId: "job-1",
      uploadId: "upload-1",
      selectedCandidateId: "cand-1",
      representativeFrame: { frameId: "frame-1", uploadId: "upload-1", timestampSec: 12 },
      confirmedPosition: "C",
      confirmedJerseyNumber: 19,
      confirmedAt: FIXED_NOW.toISOString(),
    });
    assert.equal(conf.representativeFrame.frameId, "frame-1");
  });
});

describe("Scotty contracts — report sections", () => {
  it("validates strategy schema", () => {
    const s = strategyAnalysisSchema.parse({
      observedStrategy: "unknown",
      strategyCategory: "insufficient_evidence",
      controlledPlayerPosition: "unknown",
      playerResponsibility: "Insufficient evidence",
      executionAssessment: "Sparse frames",
      strategicStrengths: [],
      strategicImprovements: [],
      knownCounters: [],
      requiredMechanics: [],
      confidence: "insufficient",
      supportingTimestampsSec: [],
    });
    assert.equal(s.strategyCategory, "insufficient_evidence");
  });

  it("allows optional faceoff section and validates when present", () => {
    const report = minimalScottyReport();
    assert.equal(report.faceoffAnalysis, undefined);
    const faceoffs = faceoffAnalysisSchema.parse({
      faceoffCount: 4,
      wins: 3,
      losses: 1,
      winPercentage: 75,
      detectedTechniques: ["stick_lift"],
      strengths: ["Timing"],
      improvements: ["Counter reads"],
      confidence: "moderate",
    });
    assert.equal(faceoffs.winPercentage, 75);
  });

  it("validates platform-specific control guidance", () => {
    const ok = controlGuidanceSchema.parse(xboxControlGuidance());
    assert.equal(ok.platform, "xbox_series");
    assert.throws(() =>
      controlGuidanceSchema.parse({
        ...xboxControlGuidance(),
        inputSequence: [{ order: 0, input: "R1 + Cross", behavior: "tap" }],
      }),
    );
  });

  it("bounds observations", () => {
    const many = Array.from({ length: 41 }, (_, i) => ({
      timestampSec: i,
      category: "other" as const,
      observedAction: "x",
      attributionExplanation: "y",
      coachingInterpretation: "z",
      confidence: "low" as const,
    }));
    assert.throws(() => scottyReportSchema.parse(minimalScottyReport({ playerSpecificObservations: many })));
  });

  it("bounds drills", () => {
    assert.equal(MAX_PRACTICE_DRILLS, 3);
    const drills = Array.from({ length: 4 }, (_, i) => ({
      ...minimalScottyReport().practiceDrills[0]!,
      drillId: `d-${i}`,
    }));
    assert.throws(() => practiceDrillListSchema.parse(drills));
  });

  it("builds a stable error response", () => {
    const err = scottyErrorResponseSchema.parse({
      contractVersion: SCOTTY_CONTRACT_VERSION,
      code: "UNSUPPORTED_CONTRACT_VERSION",
      message: scottyErrorMessage("UNSUPPORTED_CONTRACT_VERSION"),
      retryable: false,
      requestId: "req-9",
    });
    assert.equal(err.code, "UNSUPPORTED_CONTRACT_VERSION");
    assert.equal(err.retryable, false);
  });

  it("does not expose storage keys on public upload view", () => {
    const pub = toPublicUploadView(baseUpload(60));
    assert.equal("storageObjectKey" in pub, false);
    assert.equal(JSON.stringify(pub).includes("clips/"), false);
  });
});

describe("Scotty contracts — retention calculations", () => {
  it("calculates 24-hour expiration", () => {
    const expires = calculateExpiresAt(FIXED_NOW, DEFAULT_MEDIA_RETENTION_POLICY);
    assert.equal(expires.toISOString(), "2026-08-01T12:00:00.000Z");
  });

  it("supports configurable retention period", () => {
    const policy = mediaRetentionPolicySchema.parse({
      ...DEFAULT_MEDIA_RETENTION_POLICY,
      rawMediaRetentionHours: 12,
      maximumRetentionHours: 36,
    });
    const expires = calculateExpiresAt(FIXED_NOW, policy);
    assert.equal(expires.toISOString(), "2026-08-01T00:00:00.000Z");
    const abs = calculateAbsoluteDeleteAt(FIXED_NOW, policy);
    assert.equal(abs.toISOString(), "2026-08-02T00:00:00.000Z");
  });

  it("active processing lease defers deletion", () => {
    const decision = evaluateRetention({
      now: new Date("2026-08-01T13:00:00.000Z"),
      createdAt: FIXED_NOW,
      expiresAt: calculateExpiresAt(FIXED_NOW, DEFAULT_MEDIA_RETENTION_POLICY),
      absoluteDeleteAt: calculateAbsoluteDeleteAt(FIXED_NOW, DEFAULT_MEDIA_RETENTION_POLICY),
      uploadStatus: "ready",
      hasActiveLease: true,
      alreadyDeleted: false,
      jobTerminalStatus: "active",
      policy: DEFAULT_MEDIA_RETENTION_POLICY,
    });
    assert.equal(decision.defer, true);
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "active_processing_lease");
  });

  it("expired lease allows deletion", () => {
    const decision = evaluateRetention({
      now: new Date("2026-08-01T13:00:00.000Z"),
      createdAt: FIXED_NOW,
      expiresAt: calculateExpiresAt(FIXED_NOW, DEFAULT_MEDIA_RETENTION_POLICY),
      absoluteDeleteAt: calculateAbsoluteDeleteAt(FIXED_NOW, DEFAULT_MEDIA_RETENTION_POLICY),
      uploadStatus: "ready",
      hasActiveLease: false,
      alreadyDeleted: false,
      jobTerminalStatus: "completed",
      policy: DEFAULT_MEDIA_RETENTION_POLICY,
    });
    assert.equal(decision.eligible, true);
    assert.equal(decision.reason, "eligible");
  });

  it("completed / failed / cancelled job media become eligible after expiry", () => {
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      const decision = evaluateRetention({
        now: new Date("2026-08-01T13:00:00.000Z"),
        createdAt: FIXED_NOW,
        expiresAt: calculateExpiresAt(FIXED_NOW, DEFAULT_MEDIA_RETENTION_POLICY),
        absoluteDeleteAt: calculateAbsoluteDeleteAt(FIXED_NOW, DEFAULT_MEDIA_RETENTION_POLICY),
        uploadStatus: "ready",
        hasActiveLease: false,
        alreadyDeleted: false,
        jobTerminalStatus: terminal,
        policy: DEFAULT_MEDIA_RETENTION_POLICY,
      });
      assert.equal(decision.eligible, true, terminal);
    }
  });

  it("enforces absolute 48-hour retention limit even with active lease", () => {
    const decision = evaluateRetention({
      now: new Date("2026-08-02T12:00:00.000Z"),
      createdAt: FIXED_NOW,
      expiresAt: calculateExpiresAt(FIXED_NOW, DEFAULT_MEDIA_RETENTION_POLICY),
      absoluteDeleteAt: calculateAbsoluteDeleteAt(FIXED_NOW, DEFAULT_MEDIA_RETENTION_POLICY),
      uploadStatus: "processing",
      hasActiveLease: true,
      alreadyDeleted: false,
      jobTerminalStatus: "active",
      policy: DEFAULT_MEDIA_RETENTION_POLICY,
    });
    assert.equal(decision.maximumRetentionReached, true);
    assert.equal(decision.eligible, true);
    assert.equal(decision.reason, "force_expire_stuck_job");
  });
});

describe("Scotty contracts — Step 4 provider boundary", () => {
  it("validates media transfer, submission, callback, and safe result schemas", () => {
    assert.ok(
      mediaTransferDescriptorSchema.safeParse({
        type: "gateway_pull",
        uploadReference: "up-1",
      }).success,
    );
    assert.ok(
      mediaTransferDescriptorSchema.safeParse({
        type: "short_lived_url",
        urlReference: "https://example.invalid/tmp",
        expiresAt: FIXED_NOW.toISOString(),
      }).success,
    );
    const sub = scottyAnalysisSubmissionSchema.parse({
      requestId: "req-1",
      idempotencyKey: "idem-1",
      uploadId: "up-1",
      ownerReference: "own-1",
      gameContext: sampleGameContext(),
      playerContext: xboxPlayerContext(),
      effectivePlayer: {
        position: "C",
        jerseyNumber: 19,
        indicatorColor: "blue",
        teamSide: "home",
        confidence: 0.93,
        confidenceLabel: "very_high",
        source: "high_confidence_identification",
        identificationId: "id-1",
        userConfirmed: false,
      },
      mediaMetadata: trustedMedia(60),
      mediaClassification: "short_clip",
      mediaTransfer: { type: "multipart", mediaReference: "ref-1" },
      retentionExpiresAt: FIXED_NOW.toISOString(),
      createdAt: FIXED_NOW.toISOString(),
    });
    assert.equal(sub.capabilities.analyzeGameplay, true);
    assert.ok(
      scottyCallbackEventSchema.safeParse({
        eventId: "e1",
        eventType: "completed",
        externalJobId: "j1",
        applicationRequestId: "r1",
        status: "completed",
        occurredAt: FIXED_NOW.toISOString(),
        sequenceNumber: 1,
      }).success,
    );
    assert.ok(
      applicationAnalysisSubmissionResultSchema.safeParse({
        applicationRequestId: "r1",
        uploadId: "up-1",
        provider: "fake",
        status: "queued",
        acceptedAt: FIXED_NOW.toISOString(),
        reused: false,
        nextAction: "poll_later",
      }).success,
    );
  });
});

describe("Scotty contracts — Step 3 identification / candidates", () => {
  it("validates bounding boxes and public identification shapes", () => {
    assert.ok(boundingBoxSchema.safeParse({ x: 0, y: 0, width: 1, height: 1 }).success);
    assert.equal(boundingBoxSchema.safeParse({ x: 0.5, y: 0, width: 0.6, height: 0.5 }).success, false);
    assert.equal(MAX_PLAYER_CANDIDATES, 4);
    const pub = publicPlayerIdentificationSchema.parse({
      identificationId: "id-1",
      uploadId: "up-1",
      status: "confirmation_required",
      detected: true,
      confidence: 0.5,
      confidenceLabel: "moderate",
      uncertainties: ["Multiple players match the provided context"],
      userConfirmed: false,
      frames: [],
      candidates: [],
      additionalExtractionAvailable: true,
      sourceExpiresAt: FIXED_NOW.toISOString(),
      retentionNotice: "Complete player confirmation before the source video expires.",
    });
    assert.equal(pub.status, "confirmation_required");
  });
});

describe("Scotty contracts — Step 2 profile / games / classification", () => {
  it("classifies short, extended, and full-game durations", () => {
    assert.equal(classifyMediaDuration(60), "short_clip");
    assert.equal(classifyMediaDuration(120), "short_clip");
    assert.equal(classifyMediaDuration(121), "extended_clip");
    assert.equal(classifyMediaDuration(899), "extended_clip");
    assert.equal(classifyMediaDuration(900), "full_game");
    assert.equal(classifyMediaDuration(1800), "full_game");
    assert.throws(() => classifyMediaDuration(1801));
  });

  it("builds gameplay profile defaults and accepts partial updates", () => {
    const profile = defaultGameplayProfile("user-1", FIXED_NOW.toISOString());
    assert.equal(profile.preferredPlatform, "unknown");
    const patch = gameplayProfileUpdateSchema.parse({ preferredPlatform: "xbox_series" });
    assert.equal(patch.preferredPlatform, "xbox_series");
    assert.equal(Object.keys(patch).length, 1);
  });

  it("validates create-upload-session context and rejects unsupported game selection helpers", () => {
    const nhl25 = findGameById("nhl-25");
    assert.ok(nhl25);
    assert.equal(isGameAcceptableForUpload(nhl25.supportStatus), true);

    const nhl26 = findGameById("nhl-26");
    assert.ok(nhl26);
    assert.equal(isGameAcceptableForUpload(nhl26.supportStatus), false);
    assert.match(RELEASED_NOT_SUPPORTED_MESSAGE, /still being verified/);

    const ctx = buildGameContextFromSelection("nhl-26");
    assert.equal(ctx.supportStatus, "released_not_yet_supported");

    const req = createUploadSessionRequestSchema.parse({
      filename: "clip.mp4",
      contentType: "video/mp4",
      sizeBytes: 1000,
      saveAsDefaults: false,
      context: {
        gameContext: buildGameContextFromSelection("nhl-25"),
        playerContext: xboxPlayerContext(),
        singlePlayerControl: true,
      },
    });
    assert.equal(req.saveAsDefaults, false);
  });
});
