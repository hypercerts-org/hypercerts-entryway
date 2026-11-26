import https from "node:https";
import { createPrivateKey, X509Certificate, type KeyObject } from "node:crypto";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import {
  CONTROLLER_MAX_JSON_BYTES,
  ControllerBindingVerifier,
  ControllerContractError,
  controllerBindingExpectationSchema,
  controllerDescribeRequestSchema,
  type ControllerBinding,
  type ControllerBindingExpectation,
  type ConsumeControllerChallenge,
} from "./deployment-controller-contract.js";

type ChallengeIssuer = (
  context: Omit<ControllerBindingExpectation, "nonce">,
  lifetimeMs: number,
) => Promise<{ expected: ControllerBindingExpectation; expiresAt: number }>;
interface ControllerClientConfiguration {
  endpoint: string;
  dialAddress: string;
  ca: Buffer;
  clientCertificate: Buffer;
  clientPrivateKey: Buffer;
  issuer: string;
  authorityId: string;
  callerId: string;
  signingKeys: ReadonlyMap<string, string | Buffer | KeyObject>;
  allowedHosts: readonly { deploymentId: string; hostId: string }[];
  timeoutMs: number;
}
function invalid(): never {
  throw new ControllerContractError("ControllerInvalidResponse");
}
function pemCertificates(bytes: Buffer): void {
  const text = bytes.toString("utf8");
  const expression =
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  const certificates = text.match(expression);
  if (!certificates?.length || text.replace(expression, "").trim()) invalid();
  for (const certificate of certificates) new X509Certificate(certificate);
}

/** Fixed-route control-plane client. It never forwards PDS traffic or grants admission. */
export function createDeploymentControllerClient(
  input: ControllerClientConfiguration,
  issueChallenge: ChallengeIssuer,
  consumeChallenge: ConsumeControllerChallenge,
) {
  let endpoint: URL;
  let key: KeyObject;
  try {
    endpoint = new URL(input.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.origin !== input.endpoint ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash ||
      !isIP(input.dialAddress) ||
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > 10_000 ||
      !input.allowedHosts.length ||
      input.allowedHosts.length > 256
    )
      invalid();
    const literal = endpoint.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && literal !== input.dialAddress) invalid();
    pemCertificates(input.ca);
    pemCertificates(input.clientCertificate);
    key = createPrivateKey(input.clientPrivateKey);
    if (!new X509Certificate(input.clientCertificate).checkPrivateKey(key))
      invalid();
  } catch {
    return invalid();
  }
  const config = {
    endpoint: endpoint.origin,
    dialAddress: input.dialAddress,
    ca: Buffer.from(input.ca),
    certificate: Buffer.from(input.clientCertificate),
    privateKey: Buffer.from(input.clientPrivateKey),
    issuer: input.issuer,
    authorityId: input.authorityId,
    callerId: input.callerId,
    timeoutMs: input.timeoutMs,
    allowedHosts: new Set(
      input.allowedHosts.map(({ deploymentId, hostId }) =>
        JSON.stringify([deploymentId, hostId]),
      ),
    ),
  };
  let verifier: ControllerBindingVerifier;
  try {
    verifier = new ControllerBindingVerifier(
      new Map([[config.issuer, new Map(input.signingKeys)]]),
      consumeChallenge,
    );
  } catch {
    return invalid();
  }
  async function post(body: object, timeoutMs: number): Promise<string> {
    const bytes = Buffer.from(JSON.stringify(body));
    if (bytes.length > CONTROLLER_MAX_JSON_BYTES) return invalid();
    const url = new URL("/v1/bindings/describe", config.endpoint);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: ControllerContractError, result?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result!);
      };
      try {
        const request = https.request(
          url,
          {
            method: "POST",
            rejectUnauthorized: true,
            ca: config.ca,
            cert: config.certificate,
            key: config.privateKey,
            agent: false,
            ...({ autoSelectFamily: false } as Record<string, unknown>),
            lookup: (_hostname, _options, callback) =>
              callback(null, config.dialAddress, isIP(config.dialAddress)),
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "content-length": String(bytes.length),
            },
          },
          (response) => {
            if (response.statusCode !== 200) {
              response.destroy();
              finish(new ControllerContractError("ControllerUnavailable"));
              return;
            }
            const contentType = response.headers["content-type"]
              ?.split(";", 1)[0]
              ?.trim()
              .toLowerCase();
            if (contentType !== "application/json") {
              response.destroy();
              finish(new ControllerContractError("ControllerInvalidResponse"));
              return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > CONTROLLER_MAX_JSON_BYTES) {
                response.destroy();
                finish(
                  new ControllerContractError("ControllerInvalidResponse"),
                );
                return;
              }
              chunks.push(chunk);
            });
            response.on("error", () =>
              finish(new ControllerContractError("ControllerUnavailable")),
            );
            response.on("end", () => {
              try {
                finish(
                  undefined,
                  new TextDecoder("utf-8", { fatal: true }).decode(
                    Buffer.concat(chunks),
                  ),
                );
              } catch {
                finish(
                  new ControllerContractError("ControllerInvalidResponse"),
                );
              }
            });
          },
        );
        request.on("error", () =>
          finish(new ControllerContractError("ControllerUnavailable")),
        );
        timer = setTimeout(() => {
          request.destroy();
          finish(new ControllerContractError("ControllerUnavailable"));
        }, timeoutMs);
        request.end(bytes);
      } catch {
        finish(new ControllerContractError("ControllerUnavailable"));
      }
    });
  }
  return {
    async describe(
      context: Omit<
        ControllerBindingExpectation,
        "nonce" | "issuer" | "audience"
      >,
    ): Promise<ControllerBinding> {
      if (
        !config.allowedHosts.has(
          JSON.stringify([context.deploymentId, context.hostId]),
        )
      )
        throw new ControllerContractError("ControllerIdentityMismatch");
      const deadline = performance.now() + config.timeoutMs;
      const bounded = async <T>(operation: Promise<T>): Promise<T> => {
        const remaining = deadline - performance.now();
        if (remaining <= 0)
          throw new ControllerContractError("ControllerUnavailable");
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new ControllerContractError("ControllerUnavailable")),
                remaining,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const template = {
        ...context,
        issuer: config.issuer,
        audience: config.authorityId,
        nonce: "A".repeat(43),
      };
      if (!controllerBindingExpectationSchema.safeParse(template).success)
        return invalid();
      const { nonce: _nonce, ...challengeContext } = template;
      const issued = await bounded(
        issueChallenge(challengeContext, 30_000),
      ).catch(() => {
        throw new ControllerContractError("ControllerUnavailable");
      });
      const expected = controllerBindingExpectationSchema.safeParse(
        issued.expected,
      );
      if (
        !expected.success ||
        Object.keys(challengeContext).some(
          (field) =>
            expected.data[field as keyof ControllerBindingExpectation] !==
            challengeContext[field as keyof typeof challengeContext],
        )
      )
        throw new ControllerContractError("ControllerIdentityMismatch");
      const request = controllerDescribeRequestSchema.safeParse({
        version: 1,
        authorityId: config.authorityId,
        callerId: config.callerId,
        deploymentId: context.deploymentId,
        hostId: context.hostId,
        revision: context.revision,
        controllerEpoch: context.controllerEpoch,
        purpose: "describe-binding",
        nonce: expected.data.nonce,
      });
      if (!request.success) return invalid();
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new ControllerContractError("ControllerUnavailable");
      const raw = await post(request.data, remaining);
      return bounded(verifier.verify(raw, expected.data, Date.now));
    },
  };
}
