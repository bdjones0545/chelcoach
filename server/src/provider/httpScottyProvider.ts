/**
 * HTTP Scotty provider skeleton — validates config, maps contracts, does NOT network.
 *
 * Proposed transport endpoints (adaptable later):
 *   POST /v1/analysis/jobs
 *   GET  /v1/analysis/jobs/:jobId
 *   GET  /v1/analysis/jobs/:jobId/report
 *   POST /v1/analysis/jobs/:jobId/player-confirmation
 *   POST /v1/analysis/jobs/:jobId/cancel
 *   GET  /v1/health
 */
import type {
  ScottyAnalysisSubmission,
  ScottyCancelRequest,
  ScottyCancelResponse,
  ScottyJobLookup,
  ScottyJobStatusResponse,
  ScottyPlayerConfirmationSubmission,
  ScottyProviderHealth,
  ScottyProviderJobReceipt,
  ScottyReport,
  ScottyReportLookup,
} from "../scottyContract";
import { scottyProviderHealthSchema } from "../scottyContract";
import type { ScottyProviderConfig } from "./config";
import { ProviderError } from "./errors";
import type { ScottyRequestSigner } from "./signer";
import type { ScottyProvider } from "./types";

export class HttpScottyProvider implements ScottyProvider {
  readonly mode = "scotty" as const;
  // Step 4 skeleton: every method throws notNetworking() and no request ever leaves the
  // process. Flip to true only when the transport genuinely calls the Scotty VM.
  readonly canServeProductionTraffic = false;

  constructor(
    private config: ScottyProviderConfig,
    private signer: ScottyRequestSigner,
  ) {}

  buildEndpoint(path: string): string {
    const base = this.config.scottyBaseUrl.replace(/\/$/, "");
    return `${base}${path.startsWith("/") ? path : `/${path}`}`;
  }

  mapSubmissionToTransportBody(input: ScottyAnalysisSubmission): string {
    // Transport serialization — no secrets. Signed URL resolution happens later.
    return JSON.stringify({
      contractVersion: input.contractVersion,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      uploadId: input.uploadId,
      ownerReference: input.ownerReference,
      gameContext: input.gameContext,
      playerContext: input.playerContext,
      effectivePlayer: input.effectivePlayer,
      mediaMetadata: input.mediaMetadata,
      mediaClassification: input.mediaClassification,
      capabilities: input.capabilities,
      mediaTransfer: input.mediaTransfer.type === "short_lived_url"
        ? { type: "short_lived_url", expiresAt: input.mediaTransfer.expiresAt }
        : input.mediaTransfer,
      retentionExpiresAt: input.retentionExpiresAt,
      createdAt: input.createdAt,
    });
  }

  async buildSignedHeaders(input: {
    method: string;
    path: string;
    body: string;
    requestId: string;
    idempotencyKey?: string;
  }): Promise<Record<string, string>> {
    const timestamp = new Date().toISOString();
    const signed = await this.signer.sign({
      method: input.method,
      path: input.path,
      timestamp,
      body: input.body,
      requestId: input.requestId,
    });
    return {
      "Content-Type": "application/json",
      "X-Scotty-Timestamp": timestamp,
      "X-Scotty-Request-Id": input.requestId,
      "X-Scotty-Contract-Version": this.config.contractVersion,
      ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      ...signed,
    };
  }

  private notNetworking(method: string): never {
    throw new ProviderError(
      "PROVIDER_UNAVAILABLE",
      `HttpScottyProvider.${method} is a Step 4 skeleton and does not call the live Scotty VM.`,
      "configuration",
      { provider: "scotty", retryable: false },
    );
  }

  async submitAnalysis(input: ScottyAnalysisSubmission): Promise<ScottyProviderJobReceipt> {
    // Prove mappers compile; do not fetch.
    void this.buildEndpoint("/v1/analysis/jobs");
    void this.mapSubmissionToTransportBody(input);
    void this.config.requestTimeoutMs;
    return this.notNetworking("submitAnalysis");
  }

  async getJob(input: ScottyJobLookup): Promise<ScottyJobStatusResponse> {
    void this.buildEndpoint(`/v1/analysis/jobs/${input.externalJobId}`);
    void this.config.statusTimeoutMs;
    return this.notNetworking("getJob");
  }

  async getReport(input: ScottyReportLookup): Promise<ScottyReport> {
    void this.buildEndpoint(`/v1/analysis/jobs/${input.externalJobId}/report`);
    void this.config.reportTimeoutMs;
    return this.notNetworking("getReport");
  }

  async confirmPlayer(input: ScottyPlayerConfirmationSubmission): Promise<ScottyJobStatusResponse> {
    void this.buildEndpoint(`/v1/analysis/jobs/${input.externalJobId}/player-confirmation`);
    return this.notNetworking("confirmPlayer");
  }

  async cancelJob(input: ScottyCancelRequest): Promise<ScottyCancelResponse> {
    void this.buildEndpoint(`/v1/analysis/jobs/${input.externalJobId}/cancel`);
    return this.notNetworking("cancelJob");
  }

  async health(): Promise<ScottyProviderHealth> {
    void this.buildEndpoint("/v1/health");
    return scottyProviderHealthSchema.parse({
      provider: "scotty",
      configured: true,
      reachable: false,
      contractCompatible: true,
      status: "disabled",
      checkedAt: new Date().toISOString(),
      message: "HTTP Scotty provider skeleton — networking disabled in Step 4",
    });
  }
}
