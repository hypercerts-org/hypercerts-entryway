import type {
  BrowserAuthentication,
  BrowserRequest,
} from "../../authentication/port.js";
import { HttpError } from "../../http/http-error.mjs";

/** One fresh destination proof for every saved-user arrival operation. The
 * browser origin/CSRF check precedes any session or code work, the existing
 * challenge budget is spent before the code is verified, and the verified
 * identity must be exactly the saved browser principal. */
export function createFreshArrivalProof({
  authentication,
  checkCsrf,
  loadBrowser,
  rateLimit,
}: {
  authentication: BrowserAuthentication;
  checkCsrf: (request: BrowserRequest, browser: unknown) => void;
  loadBrowser: (request: BrowserRequest) => Promise<unknown>;
  rateLimit: (subject: string) => Promise<void>;
}) {
  return async function requireFreshProof(
    request: BrowserRequest,
    otp: string,
    purpose: string,
    /** Input-only validation. It runs before the OTP budget or code is spent and
     * reveals nothing about any saved operation. */
    beforeProof?: () => void,
  ) {
    const browser = await loadBrowser(request);
    checkCsrf(request, browser);
    const principal = await authentication.requireSession(request);
    const proofRequired = () =>
      new HttpError(
        403,
        "ArrivalProofRequired",
        "Verify the destination email again",
      );
    if (!principal?.emailVerified || !otp) throw proofRequired();
    beforeProof?.();
    await rateLimit(`${purpose}:${principal.userId}`);
    const proof = await authentication.verifySignInCode({
      email: principal.email,
      otp,
    });
    const identity = proof.ok ? proof.principal : null;
    if (
      !identity?.emailVerified ||
      identity.userId !== principal.userId ||
      identity.email !== principal.email
    )
      throw proofRequired();
    return identity;
  };
}
