// The controller supplies this origin only after validating its owned sandbox access.
const sandboxOrigin = "https://entryway.atmosbox.test";
const routes = [
  [
    "GET",
    /^\/(?:_health|_readyz|admin\/pds-registry\/(?:status|phase)|admin\/pds-registry\/hosts\/(?:pds-monitor(?:\/policy)?|pds-serving|qualified-[a-f0-9]{16}))$/,
  ],
  [
    "GET",
    /^\/(?:|login|xrpc\/com\.atproto\.server\.createAccount|\.well-known\/(?:did\.json|oauth-authorization-server))$/,
  ],
  [
    "POST",
    /^\/(?:admin\/pds-registry\/(?:hosts|activate)|ADMIN\/PDS-REGISTRY\/HOSTS|AdMiN\/PdS-ReGiStRy\/HoStS|_operations\/status|xrpc\/com\.atproto\.server\.createAccount)$/,
  ],
  [
    "POST",
    /^\/admin\/pds-registry\/hosts\/(?:pds-monitor\/(?:check|policy|attest|associate|callback\/revoke)|pds-second\/(?:check|attest|associate|lifecycle)|pds-serving\/(?:check|attest|associate|lifecycle)|qualified-[a-f0-9]{16}\/callback\/revoke)$/,
  ],
];

export function validateRegistryOrigin(
  configuredIssuer,
  trustedOrigin = process.env.REGISTRY_TEST_ENTRYWAY_ORIGIN,
) {
  if (trustedOrigin !== sandboxOrigin || configuredIssuer !== sandboxOrigin)
    throw new Error("InvalidRegistryTestOrigin");
}

export function registryRequest(
  configuredIssuer,
  path,
  options = {},
  trustedOrigin = process.env.REGISTRY_TEST_ENTRYWAY_ORIGIN,
) {
  validateRegistryOrigin(configuredIssuer, trustedOrigin);
  const method = options.method ?? "GET";
  if (
    !routes.some(
      ([allowedMethod, route]) => allowedMethod === method && route.test(path),
    )
  )
    throw new Error("InvalidRegistryTestRoute");
  return fetch(new URL(path, sandboxOrigin), {
    ...options,
    method,
    redirect: "error",
  });
}
