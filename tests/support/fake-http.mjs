/**
 * Minimal Express stand-ins for route unit tests.
 *
 * fakeApp records the final handler of each GET/POST route into `handlers`,
 * skipping middleware such as CSRF or body parsing.
 */
export function fakeApp(handlers = new Map()) {
  const register = (path, ...middleware) => {
    handlers.set(path, middleware.at(-1));
  };
  return { get: register, post: register };
}

/** A chainable response that records status, headers, body and redirect. */
export function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    set(headers) {
      Object.assign(this.headers, headers);
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    redirect(code, url) {
      this.statusCode = code;
      this.redirectUrl = url;
      return this;
    },
  };
}
