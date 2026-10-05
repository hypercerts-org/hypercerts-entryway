/** Browser proof is separate from an AT Protocol DID and its authority. */
export interface VerifiedBrowserIdentity {
  userId: string;
  email: string;
  emailVerified: boolean;
}

export interface BrowserPrincipal extends VerifiedBrowserIdentity {
  sessionId: string;
  authenticatedAt: Date;
  kind: "better-auth";
}

export interface BrowserRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface CookieResponse {
  append(name: string, value: string): unknown;
}

export interface BrowserSessionSummary {
  id: string;
  userAgent?: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export type EmailSignInProof =
  | { ok: false; status: number }
  | {
      ok: true;
      status: number;
      principal: VerifiedBrowserIdentity | null;
      /** Commit only after the feature validates account ownership. */
      commitCookies(response: CookieResponse): void;
    };

export interface BrowserAuthentication {
  requireSession(request: BrowserRequest): Promise<BrowserPrincipal | null>;
  sendSignInCode(email: string): Promise<void>;
  verifySignInCode(input: {
    email: string;
    otp: string;
  }): Promise<EmailSignInProof>;
  endSession(request: BrowserRequest, response: CookieResponse): Promise<void>;
  listBrowserSessions(
    request: BrowserRequest,
  ): Promise<BrowserSessionSummary[]>;
  revokeBrowserSession(
    request: BrowserRequest,
    sessionId: string,
  ): Promise<void>;
  revokeBrowserSessions(request: BrowserRequest): Promise<void>;
}
