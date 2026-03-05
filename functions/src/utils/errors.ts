/**
 * Thrown when a user's OAuth tokens are missing, expired, or revoked.
 * Callers in background functions should catch this, set hasValidTokens=false,
 * and skip the user rather than failing the entire batch.
 */
export class TokenExpiredError extends Error {
  readonly uid: string;
  constructor(uid: string, detail?: string) {
    super(
      `OAuth tokens expired or revoked for user ${uid}` +
      (detail ? `: ${detail}` : "")
    );
    this.name = "TokenExpiredError";
    this.uid = uid;
  }
}

/**
 * Thrown when a Google API returns a quota-exceeded (429) response.
 */
export class APIQuotaError extends Error {
  readonly service: string;
  constructor(service: string, detail?: string) {
    super(
      `API quota exceeded for ${service}` +
      (detail ? `: ${detail}` : "")
    );
    this.name = "APIQuotaError";
    this.service = service;
  }
}

/**
 * Thrown when a transcript file cannot be found or exported from Drive.
 * Distinguishes a missing/deleted file from a transient network failure.
 */
export class TranscriptNotFoundError extends Error {
  readonly fileId: string;
  constructor(fileId: string, detail?: string) {
    super(
      `Transcript not found or inaccessible: ${fileId}` +
      (detail ? `: ${detail}` : "")
    );
    this.name = "TranscriptNotFoundError";
    this.fileId = fileId;
  }
}

/**
 * Thrown when the AI provider fails to produce valid output after all retry attempts.
 */
export class AIExtractionError extends Error {
  readonly provider: string;
  constructor(provider: string, detail?: string) {
    super(
      `AI extraction failed (${provider})` +
      (detail ? `: ${detail}` : "")
    );
    this.name = "AIExtractionError";
    this.provider = provider;
  }
}
