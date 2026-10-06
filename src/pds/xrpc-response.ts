import { HttpError } from "../http/http-error.mjs";
import type { PlcSubmissionRejection } from "../database/operation-ownership.port.js";

const submission = "com.atproto.identity.submitPlcOperation";
const completedErrors = new WeakMap<
  Error,
  {
    target: string;
    method: string;
    status: number;
    error: string;
    message: string;
  }
>();
const localRejections = new Map<string, PlcSubmissionRejection["reason"]>([
  ["Invalid operation", "invalid-operation"],
  [
    "Rotation keys do not include server's rotation key",
    "missing-rotation-key",
  ],
  ["Incorrect type on atproto_pds service", "incorrect-service-type"],
  ["Incorrect endpoint on atproto_pds service", "incorrect-service-endpoint"],
  ["Incorrect signing key", "incorrect-signing-key"],
  ["Incorrect handle in alsoKnownAs", "incorrect-handle"],
]);

/** Only this concrete transport can create a completed-response receipt. Body
 * failure still propagates the public upstream status, but grants no authority
 * to settle a durable dispatch. No raw response is persisted. */
export async function readXrpcResponse(
  response: Response,
  target: string,
  method: string,
): Promise<unknown> {
  let data: unknown = {};
  let decoded = false;
  let complete = false;
  let text = "";
  try {
    text = await response.text();
    complete = true;
    if (text) {
      data = JSON.parse(text) as unknown;
      decoded = true;
    }
  } catch {
    // Empty successful replies are supported; malformed or interrupted replies
    // never count as successful acknowledgement or as a completed rejection.
  }
  if (response.ok) {
    if (!complete || (text !== "" && !decoded))
      throw new HttpError(
        502,
        "InvalidUpstreamResponse",
        "The PDS response was incomplete or invalid",
      );
    return data;
  }
  const body =
    data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const error =
    "error" in body && typeof body.error === "string"
      ? body.error
      : "UpstreamError";
  const message =
    "message" in body && typeof body.message === "string"
      ? body.message
      : `Upstream ${method} failed`;
  const failure = new HttpError(response.status, error, message);
  if (
    decoded &&
    "error" in body &&
    typeof body.error === "string" &&
    "message" in body &&
    typeof body.message === "string"
  )
    completedErrors.set(failure, {
      target,
      method,
      status: response.status,
      error,
      message,
    });
  throw failure;
}

/** PDS 0.5.36 validates these invariants before PLC publication. Its PLC client
 * also returns this exact signature error before the directory transaction.
 * Unknown 4xx/5xx and errors after publication are deliberately not classified. */
export function rejectedPlcSubmission(
  error: unknown,
  target: string,
  operation: unknown,
): PlcSubmissionRejection | null {
  const receipt =
    error instanceof Error ? completedErrors.get(error) : undefined;
  if (
    !receipt ||
    receipt.target !== target ||
    receipt.method !== submission ||
    receipt.status !== 400 ||
    receipt.error !== "InvalidRequest"
  )
    return null;
  let reason = localRejections.get(receipt.message);
  if (
    !reason &&
    operation &&
    typeof operation === "object" &&
    !Array.isArray(operation) &&
    receipt.message === `Invalid signature on op: ${JSON.stringify(operation)}`
  )
    reason = "invalid-signature";
  return reason ? { status: 400, error: "InvalidRequest", reason } : null;
}
