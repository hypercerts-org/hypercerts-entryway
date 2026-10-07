import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { RequestHandler, Request, Response } from "express";
import { renderExperiencePage } from "../ui/experience.js";

export interface LifecycleConfiguration {
  probeTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export function loadLifecycleConfiguration(
  env: Record<string, string | undefined>,
): LifecycleConfiguration {
  const milliseconds = (name: string, fallback: number, maximum: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new Error("InvalidLifecycleConfiguration");
    return value;
  };
  return {
    probeTimeoutMs: milliseconds("DATABASE_PROBE_TIMEOUT_MS", 2_000, 10_000),
    shutdownTimeoutMs: milliseconds("SHUTDOWN_TIMEOUT_MS", 15_000, 60_000),
  };
}

/** Local process lifecycle only. Durable ownership remains in the authority DB. */
export function createLifecycle({
  probe,
  configuration,
  instanceId = randomUUID(),
}: {
  probe: (timeoutMs: number) => Promise<boolean>;
  configuration: LifecycleConfiguration;
  instanceId?: string;
}) {
  let initialized = false;
  let draining = false;
  let activeRequests = 0;
  let notifyIdle: (() => void) | undefined;
  let shutdown: Promise<"complete" | "deadline"> | undefined;
  const workers = new Map<string, Promise<void>>();
  const idle = () => activeRequests === 0 && workers.size === 0;
  const changed = () => {
    if (idle()) notifyIdle?.();
  };
  const ready = async () => {
    if (!initialized || draining) return false;
    const usable = await probe(configuration.probeTimeoutMs).catch(() => false);
    return usable && initialized && !draining;
  };
  const unavailable = (request: Request, response: Response) => {
    response.setHeader("Retry-After", "2");
    response.setHeader("Cache-Control", "no-store");
    if (request.get("accept")?.includes("text/html")) {
      const nonce = randomUUID();
      const rendered = renderExperiencePage({
        title: "Service temporarily unavailable",
        body: `<p role="alert">This request was not started.</p><p>Return to the previous page and review your details. Retry when service resumes. Details you have not submitted are not saved by this response.</p><button id="go-back" type="button">Return to previous page</button><script nonce="${nonce}">document.getElementById("go-back").addEventListener("click",()=>{if(history.length>1)history.back();else location.assign("/")})</script>`,
        policy: { scriptNonce: nonce },
      });
      response.setHeader(
        "Content-Security-Policy",
        rendered.contentSecurityPolicy,
      );
      response.setHeader("Referrer-Policy", "same-origin");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.status(503).type("html").send(rendered.html);
      return;
    }
    response.status(503).json({
      error: "ServiceUnavailable",
      message:
        "This request was not started because the service is temporarily unavailable. Retry when service resumes.",
    });
  };
  const readiness: RequestHandler = (_request, response, next) => {
    response.setHeader("x-entryway-instance", instanceId);
    void ready()
      .then((usable) => {
        usable = usable && !draining;
        response.status(usable ? 200 : 503).json({
          status: usable ? "ready" : draining ? "draining" : "unavailable",
          instanceId,
        });
      })
      .catch(next);
  };
  const admission: RequestHandler = (request, response, next) => {
    response.setHeader("x-entryway-instance", instanceId);
    void ready()
      .then((usable) => {
        // The asynchronous probe can outlive the incoming connection. This work
        // has not been admitted yet; normal completed request bodies still pass.
        if (request.aborted || response.destroyed) return;
        if (!usable || draining) return unavailable(request, response);
        activeRequests++;
        // An aborted connection is NOT proof its async authority work finished.
        // Without finish, drain reaches the explicit process deadline instead of
        // prematurely closing storage beneath a still-running request.
        response.once("finish", () => {
          activeRequests--;
          changed();
        });
        next();
      })
      .catch(next);
  };
  return {
    instanceId,
    readiness,
    admission,
    ready,
    initialize() {
      initialized = true;
    },
    beginDrain() {
      draining = true;
    },
    get draining() {
      return draining;
    },
    runWorker(name: string, work: () => Promise<unknown>): Promise<void> {
      if (draining || !initialized) return Promise.resolve();
      const existing = workers.get(name);
      if (existing) return existing;
      const task = Promise.resolve()
        .then(async () => {
          const usable = await ready();
          if (usable && !draining) await work();
        })
        .finally(() => {
          workers.delete(name);
          changed();
        });
      workers.set(name, task);
      return task;
    },
    stop(server: Server, closeStorage: () => Promise<void>) {
      if (shutdown) return shutdown;
      draining = true;
      shutdown = new Promise<"complete" | "deadline">((resolve, reject) => {
        let expired = false;
        const deadline = setTimeout(() => {
          expired = true;
          resolve("deadline");
        }, configuration.shutdownTimeoutMs);
        const closed = new Promise<void>((done, fail) => {
          server.close((error) => (error ? fail(error) : done()));
          server.closeIdleConnections();
        });
        const workDone = idle()
          ? Promise.resolve()
          : new Promise<void>((done) => {
              notifyIdle = done;
            });
        void Promise.all([closed, workDone])
          .then(async () => {
            if (expired) return;
            await closeStorage();
            if (expired) return;
            clearTimeout(deadline);
            resolve("complete");
          })
          .catch((error: unknown) => {
            clearTimeout(deadline);
            reject(error);
          });
      });
      return shutdown;
    },
  };
}
export type Lifecycle = ReturnType<typeof createLifecycle>;
