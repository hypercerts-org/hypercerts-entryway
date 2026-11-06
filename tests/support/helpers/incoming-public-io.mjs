const defaultCarLimitBytes = 4 * 1024 * 1024;
const defaultSettleTimeoutMs = 5_000;

const assertTimeout = (timeoutMs) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError("Invalid request timeout");
};

const assertSignal = (signal, label) => {
  if (
    signal !== undefined &&
    !(
      signal instanceof AbortSignal ||
      (typeof signal === "object" &&
        signal !== null &&
        typeof signal.aborted === "boolean" &&
        typeof signal.addEventListener === "function" &&
        typeof signal.removeEventListener === "function")
    )
  )
    throw new TypeError(`Invalid ${label} signal`);
};

const assertExternalSignal = (signal) => {
  if (signal === undefined) return;
  assertSignal(signal, "external abort");
  if (signal.aborted) throw new Error("Test aborted");
};

export class ResponseStatusError extends Error {
  constructor(status, body) {
    super("Unexpected response status");
    this.name = "ResponseStatusError";
    this.status = status;
    this.body = body;
  }
}

export class ResponseBodyError extends Error {
  constructor(code) {
    super(code);
    this.name = "ResponseBodyError";
    this.code = code;
  }
}

const abortReason = (signal) =>
  signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

const withSignal = (promise, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });

const discard = (promise) => {
  promise.catch(() => {});
};

const isReadableStream = (body) =>
  typeof ReadableStream !== "undefined" && body instanceof ReadableStream;

const disposeResponseBody = (response, signal) => {
  if (!response.body) return Promise.resolve();
  return withSignal(
    Promise.resolve(response.body.cancel(abortReason(signal))),
    signal,
  );
};

const decodeError = (bytes) => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
};

const decodeText = async (bytes) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Malformed response body");
  }
};

export const createIncomingPublicIo = ({
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  carLimitBytes = defaultCarLimitBytes,
  signal: factorySignal,
} = {}) => {
  if (typeof fetchImpl !== "function") throw new TypeError("Invalid fetch");
  assertTimeout(timeoutMs);
  assertExternalSignal(factorySignal);
  if (!Number.isSafeInteger(carLimitBytes) || carLimitBytes < 1)
    throw new RangeError("Invalid CAR limit");
  const inflight = new Set();
  const deadlines = new Map();
  const requests = new Set();
  let closed = false;

  const later = (fn, ms) => {
    if (closed) throw new Error("Incoming public I/O is closed");
    const handle = setTimeout(() => {
      deadlines.delete(handle);
      fn();
    }, ms);
    deadlines.set(handle, fn);
    return handle;
  };

  const clearDeadline = (handle) => {
    clearTimeout(handle);
    deadlines.delete(handle);
  };

  const clearDeadlines = () => {
    for (const handle of deadlines.keys()) clearTimeout(handle);
    deadlines.clear();
  };

  const closeRequest = ({ controller, deadline }) => {
    requests.delete(controller);
    clearDeadline(deadline);
  };

  const openRequest = async (
    url,
    { method = "GET", headers = {}, body, signal } = {},
  ) => {
    assertExternalSignal(signal);
    const controller = new AbortController();
    const external = [factorySignal, signal].filter(Boolean);
    const composed = external.length
      ? AbortSignal.any([...external, controller.signal])
      : controller.signal;
    const entry = {
      controller,
      deadline: later(() => controller.abort(), timeoutMs),
      composed,
    };
    requests.add(controller);
    const fetched = fetchImpl(url, {
      method,
      headers,
      ...(body === undefined
        ? {}
        : { body, ...(isReadableStream(body) ? { duplex: "half" } : {}) }),
      signal: composed,
    });
    try {
      const response = await withSignal(fetched, composed);
      return { ...entry, response };
    } catch (error) {
      discard(
        Promise.resolve(fetched)
          .then((response) => disposeResponseBody(response, composed))
          .catch(() => {}),
      );
      closeRequest(entry);
      throw error;
    }
  };

  const disposeBody = (entry) => {
    const { body } = entry.response;
    if (!body || body.locked) return Promise.resolve();
    return withSignal(
      Promise.resolve(body.cancel(abortReason(entry.composed))),
      entry.composed,
    );
  };

  const consumeBody = async (entry, { read, dispose = true }) => {
    try {
      const value = await withSignal(
        Promise.resolve(read(entry.response, entry.composed)),
        entry.composed,
      );
      if (dispose) await disposeBody(entry);
      return value;
    } catch (error) {
      discard(disposeBody(entry).catch(() => {}));
      throw error;
    } finally {
      closeRequest(entry);
    }
  };

  const readStatus = async (options) => {
    const entry = await openRequest(options.url, options);
    return consumeBody(entry, {
      read: (response) => response.status,
      dispose: entry.response.body !== null,
    });
  };

  const readJson = async (options) => {
    const entry = await openRequest(options.url, options);
    return consumeBody(entry, {
      read: async (response) => {
        const bytes = await response.arrayBuffer();
        if (!response.ok)
          throw new ResponseStatusError(response.status, decodeError(bytes));
        const type = response.headers.get("content-type") ?? "";
        if (!bytes.byteLength) return undefined;
        if (!/^application\/json\b/i.test(type))
          throw new Error("Unexpected response content type");
        return JSON.parse(await decodeText(bytes));
      },
    });
  };

  const readText = async (options) => {
    const entry = await openRequest(options.url, options);
    return consumeBody(entry, {
      read: async (response) => {
        const bytes = await response.arrayBuffer();
        if (!response.ok)
          throw new ResponseStatusError(response.status, decodeError(bytes));
        return decodeText(bytes);
      },
    });
  };

  const assertCarReadiness = (response, composed) => {
    if (!response.ok) {
      discard(disposeResponseBody(response, composed));
      throw new ResponseStatusError(response.status);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      if (!/^\d+$/.test(declared.trim())) {
        discard(disposeResponseBody(response, composed));
        throw new ResponseBodyError("Malformed response content length");
      }
      if (Number(declared) > carLimitBytes) {
        discard(disposeResponseBody(response, composed));
        throw new ResponseBodyError("Response exceeds CAR limit");
      }
    }
    if (!response.body) throw new ResponseBodyError("Response omitted body");
  };

  const streamCar = async (response, composed) => {
    assertCarReadiness(response, composed);
    const reader = response.body.getReader();
    const onAbort = () => {
      discard(reader.cancel(abortReason(composed)));
    };
    composed.addEventListener("abort", onAbort, { once: true });
    const chunks = [];
    let size = 0;
    let failure;
    try {
      for (;;) {
        const { done, value } = await withSignal(reader.read(), composed);
        if (done) break;
        size += value.byteLength;
        if (size > carLimitBytes) {
          discard(reader.cancel(abortReason(composed)));
          throw new ResponseBodyError("Response exceeds CAR limit");
        }
        chunks.push(value);
      }
    } catch (error) {
      failure = error;
      discard(reader.cancel(abortReason(composed)));
    } finally {
      composed.removeEventListener("abort", onAbort);
    }
    if (failure) throw failure;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  };

  const readCar = async (options) => {
    const entry = await openRequest(options.url, options);
    return consumeBody(entry, {
      read: (response, composed) => streamCar(response, composed),
      dispose: false,
    });
  };

  const consumers = {
    status: readStatus,
    json: readJson,
    text: readText,
    car: readCar,
  };

  const call = async (
    url,
    {
      token,
      json,
      bytes,
      verb = "POST",
      headers: extra = {},
      signal,
      expect = "json",
    } = {},
  ) => {
    if (closed) throw new Error("Incoming public I/O is closed");
    const readResponse = consumers[expect];
    if (!readResponse) throw new TypeError("Invalid response consumption");
    const headers = {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...(bytes !== undefined
        ? { "content-type": "application/vnd.ipld.car" }
        : {}),
      ...extra,
    };
    const body = json !== undefined ? JSON.stringify(json) : bytes;
    return await track(
      readResponse({ url, method: verb, headers, body, signal }),
    );
  };

  const track = (promise) => {
    inflight.add(promise);
    promise.then(
      () => inflight.delete(promise),
      () => inflight.delete(promise),
    );
    return promise;
  };

  const close = async ({ settleTimeoutMs = defaultSettleTimeoutMs } = {}) => {
    if (closed) return;
    assertTimeout(settleTimeoutMs);
    closed = true;
    for (const abort of deadlines.values()) abort();
    clearDeadlines();
    const pending = [...inflight];
    for (const controller of requests) controller.abort();
    if (!pending.length) return;
    let settleTimer;
    const bounded = new Promise((resolve) => {
      settleTimer = setTimeout(() => resolve("unsettled"), settleTimeoutMs);
    });
    const outcome = await Promise.race([
      Promise.allSettled(pending).then(() => "settled"),
      bounded,
    ]);
    clearTimeout(settleTimer);
    if (outcome === "unsettled") throw new Error("Requests did not settle");
  };

  return { call, close, inflight };
};

const defaultHeldDeadlineMs = 15_000;

const assertHeldDeadline = (deadlineMs) => {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)
    throw new RangeError("Invalid held stream deadline");
};

export const runHeldStreamedCall = (io, url, options = {}) => {
  const {
    deadlineMs = defaultHeldDeadlineMs,
    signal,
    ...callOptions
  } = options;
  assertHeldDeadline(deadlineMs);
  if (typeof io?.call !== "function") throw new TypeError("Invalid client");
  const controller = new AbortController();
  const composed = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(
    () => controller.abort(new Error("Held stream deadline exhausted")),
    deadlineMs,
  );
  const retire = () => {
    clearTimeout(timer);
    if (!controller.signal.aborted)
      controller.abort(new Error("Held stream retired"));
  };
  const settlement = withSignal(
    io.call(url, { ...callOptions, signal: composed }),
    composed,
  );
  const tagged = settlement.then(
    (body) => ({ outcome: "success", body }),
    (error) => ({ outcome: "failure", error }),
  );
  return {
    tagged,
    async consume({ expect } = {}) {
      const result = await tagged;
      if (result.outcome === "failure") throw result.error;
      if (expect === "text" && result.body !== "")
        throw new Error("Held stream settlement is not an empty body");
      return result.body;
    },
    async retireNow({ settleTimeoutMs = defaultSettleTimeoutMs } = {}) {
      assertTimeout(settleTimeoutMs);
      retire();
      return await withSignal(tagged, AbortSignal.timeout(settleTimeoutMs));
    },
  };
};
