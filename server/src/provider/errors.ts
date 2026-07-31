/**
 * Provider-error abstraction — maps to Step 1 stable error codes.
 * Raw remote bodies stay server-side only.
 */
import type {
  AnalysisProvider,
  ProviderErrorCategory,
  ScottyErrorCode,
} from "../scottyContract";
import { classifyHttpStatus, isRetryableCategory } from "./retry";

export class ProviderError extends Error {
  constructor(
    public code: ScottyErrorCode,
    message: string,
    public category: ProviderErrorCategory,
    public opts: {
      provider: AnalysisProvider;
      retryable: boolean;
      httpStatus?: number;
      externalJobId?: string;
      requestId?: string;
      /** Internal only — never sent to the browser. */
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function mapCategoryToErrorCode(category: ProviderErrorCategory): ScottyErrorCode {
  switch (category) {
    case "authentication":
      return "UNAUTHORIZED";
    case "authorization":
      return "FORBIDDEN";
    case "rate_limit":
      return "RATE_LIMITED";
    case "timeout":
      return "ANALYSIS_TIMEOUT";
    case "provider_unavailable":
    case "network":
      return "PROVIDER_UNAVAILABLE";
    case "contract_mismatch":
      return "UNSUPPORTED_CONTRACT_VERSION";
    case "invalid_response":
      return "REPORT_VALIDATION_FAILED";
    case "configuration":
      return "PROVIDER_MISCONFIGURED";
    case "validation":
      return "INVALID_REQUEST";
    case "permanent_failure":
    default:
      return "ANALYSIS_FAILED";
  }
}

export function providerErrorFromHttp(input: {
  provider: AnalysisProvider;
  httpStatus: number;
  requestId?: string;
  externalJobId?: string;
  message?: string;
  cause?: unknown;
}): ProviderError {
  const category = classifyHttpStatus(input.httpStatus);
  const code = mapCategoryToErrorCode(category);
  return new ProviderError(code, input.message ?? `Provider HTTP ${input.httpStatus}`, category, {
    provider: input.provider,
    retryable: isRetryableCategory(category),
    httpStatus: input.httpStatus,
    requestId: input.requestId,
    externalJobId: input.externalJobId,
    cause: input.cause,
  });
}

export function toSafeProviderErrorBody(err: ProviderError): {
  error: ScottyErrorCode;
  message: string;
  retryable: boolean;
  requestId?: string;
} {
  return {
    error: err.code,
    message: err.message,
    retryable: err.opts.retryable,
    requestId: err.opts.requestId,
  };
}
