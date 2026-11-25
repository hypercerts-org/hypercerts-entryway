import https from "node:https";
import { isIP } from "node:net";
import { Readable, Transform } from "node:stream";

/** Registry operation transport: exact approved origin and dial address, verified
 * TLS hostname, no proxy, connection reuse or redirects. The caller supplies the
 * response bound appropriate to the operation. */
export function registryPdsFetch(input, options, verifier, maxBytes) {
  const url = new URL(input);
  const approved = verifier?.targets?.get(url.origin);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const address = isIP(hostname) ? hostname : approved?.[0];
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !verifier?.ca ||
    !address ||
    !approved?.includes(address) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    return Promise.reject(new Error("PdsTargetNotAllowed"));
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        signal: options.signal,
        rejectUnauthorized: true,
        ca: verifier.ca,
        agent: false,
        autoSelectFamily: false,
        lookup: (_hostname, _options, callback) =>
          callback(null, address, isIP(address)),
      },
      (response) => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.statusCode !== 304
        ) {
          response.destroy();
          reject(new Error("PdsRedirectRejected"));
          return;
        }
        if (
          options.method === "HEAD" ||
          [204, 205, 304].includes(response.statusCode)
        ) {
          response.resume();
          try {
            resolve(
              new Response(null, {
                status: response.statusCode,
                headers: response.headers,
              }),
            );
          } catch (error) {
            reject(error);
          }
          return;
        }
        let size = 0;
        const bounded = new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length;
            callback(
              size > maxBytes ? new Error("PdsResponseTooLarge") : null,
              chunk,
            );
          },
        });
        response.on("error", (error) => bounded.destroy(error));
        response.pipe(bounded);
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value))
            for (const part of value) headers.append(name, part);
          else if (value !== undefined) headers.set(name, value);
        }
        try {
          resolve(
            new Response(Readable.toWeb(bounded), {
              status: response.statusCode,
              headers,
            }),
          );
        } catch (error) {
          bounded.destroy();
          reject(error);
        }
      },
    );
    request.on("error", reject);
    if (options.body !== undefined && options.body !== null)
      request.write(options.body);
    request.end();
  });
}
