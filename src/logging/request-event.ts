export interface RequestFailureEvent {
  event: "request.failed";
  status: number;
  code: string;
  operationId: string;
}

// Only known application codes may enter logs. Transport error bodies can
// contain a syntactically plausible value copied from a credential.
const safeCodes = new Set([
  "AccountExists",
  "AccountMismatch",
  "AccountNotFound",
  "AccountUnavailable",
  "AuthRequired",
  "AuthenticationRequired",
  "AuthorityNotManaged",
  "BlobIntegrityError",
  "BackupLimitExceeded",
  "EmailNotAvailable",
  "EmailReserved",
  "ExpiredToken",
  "Forbidden",
  "HandleNotAvailable",
  "HandleNotFound",
  "IdentityChanged",
  "IdentityConflict",
  "IncompleteImport",
  "InsufficientScope",
  "InvalidAccount",
  "InvalidEmail",
  "InvalidHandle",
  "InvalidInviteCode",
  "InvalidPassword",
  "InvalidPds",
  "InvalidPhoneNumber",
  "InvalidPlcOperation",
  "InvalidRecoveryKey",
  "InvalidRequest",
  "InvalidScope",
  "InvalidScopeReference",
  "InvalidStatus",
  "InvalidToken",
  "ManualRecoveryRequired",
  "MigrationLimitExceeded",
  "MigrationPending",
  "MigrationUpstreamError",
  "MissingSnapshot",
  "NotFound",
  "OperationPending",
  "OwnerBindingChanged",
  "RateLimitExceeded",
  "ReauthenticationRequired",
  "RepoNotFound",
  "SchemaConflict",
  "SourceChanged",
  "TargetAccountExists",
  "TargetNotReady",
  "TokenRequired",
  "UnexpectedPlcHead",
  "UpstreamError",
]);

export function requestFailureEvent(
  status: number,
  error: unknown,
  operationId: string,
): RequestFailureEvent {
  const candidate =
    error && typeof error === "object" && "error" in error
      ? error.error
      : undefined;
  return {
    event: "request.failed",
    operationId,
    status:
      Number.isInteger(status) && status >= 400 && status < 600 ? status : 500,
    code:
      typeof candidate === "string" && safeCodes.has(candidate)
        ? candidate
        : "RequestFailed",
  };
}
