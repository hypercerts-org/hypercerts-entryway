type Timestamp = Date | string | number;
type BrowserSession = {
  id: string;
  userAgent?: string | null;
  createdAt: Timestamp;
};
type AppPassword = { name: string; createdAt: Timestamp; privileged?: boolean };
type LegacySession = {
  id: string;
  appPasswordName?: string | null;
  createdAt: Timestamp;
  expiresAt: Timestamp;
};
type Token = { id: string; data: { clientId: string; createdAt: Timestamp } };
type Device = { deviceId: string; updatedAt: Timestamp };
type Grant = [string, { authorizedScopes?: string[] }];

export interface ConnectedAppsDependencies<Request> {
  oauth: {
    listBrowserSessions(req: Request): Promise<BrowserSession[]>;
    revokeBrowserSession(req: Request, sessionId: string): Promise<void>;
    stores: {
      listAccountTokens(did: string): Promise<Token[]>;
      deleteToken(id: string): Promise<void>;
      listAccountGrants(did: string): Promise<Grant[]>;
      listDeviceAccounts(filter: { did: string }): Promise<Device[]>;
      revokeClientGrant(did: string, clientId: string): Promise<boolean>;
      revokeAllGrants(did: string): Promise<void>;
      removeDeviceAccount(deviceId: string, did: string): Promise<boolean>;
    };
  };
  legacy?: {
    listAppPasswords(did: string): Promise<{ passwords: AppPassword[] }>;
    listSessions(did: string): Promise<LegacySession[]>;
    revokeAllSessions(did: string): Promise<void>;
  } | null;
}

export async function queryConnectedApps<Request>(
  { oauth, legacy }: ConnectedAppsDependencies<Request>,
  req: Request,
  did: string,
  view?: "apps" | "devices",
) {
  const [sessions, passwords, legacySessions, tokens, grants, devices] =
    await Promise.all([
      view === "apps" ? [] : oauth.listBrowserSessions(req),
      legacy && view !== "devices"
        ? legacy.listAppPasswords(did)
        : { passwords: [] },
      legacy && view !== "devices" ? legacy.listSessions(did) : [],
      view === "devices" ? [] : oauth.stores.listAccountTokens(did),
      view === "devices" ? [] : oauth.stores.listAccountGrants(did),
      view === "apps" ? [] : oauth.stores.listDeviceAccounts({ did }),
    ]);
  return {
    baSessions: sessions.map(({ id, userAgent, createdAt }) => ({
      id,
      userAgent,
      createdAt,
    })),
    appPasswords: {
      passwords: passwords.passwords.map(({ name, createdAt, privileged }) => ({
        name,
        createdAt,
        privileged,
      })),
    },
    legacySessions: legacySessions.map(
      ({ id, appPasswordName, createdAt, expiresAt }) => ({
        id,
        appPasswordName,
        createdAt,
        expiresAt,
      }),
    ),
    tokens: tokens.map(({ id, data }) => ({
      id,
      data: { clientId: data.clientId, createdAt: data.createdAt },
    })),
    grants: grants.map(
      ([clientId, grant]) =>
        [
          clientId,
          { authorizedScopes: grant.authorizedScopes?.slice() ?? [] },
        ] as const,
    ),
    devices: devices.map(({ deviceId, updatedAt }) => ({
      deviceId,
      updatedAt,
    })),
  };
}

export async function endBrowserSession<Request>(
  oauth: ConnectedAppsDependencies<Request>["oauth"],
  req: Request,
  sessionId: string,
): Promise<boolean> {
  if (
    !(await oauth.listBrowserSessions(req)).some(
      (session) => session.id === sessionId,
    )
  )
    return false;
  await oauth.revokeBrowserSession(req, sessionId);
  return true;
}

export function forgetDevice<Request>(
  oauth: ConnectedAppsDependencies<Request>["oauth"],
  did: string,
  deviceId: string,
): Promise<boolean> {
  return oauth.stores.removeDeviceAccount(deviceId, did);
}

export async function revokeOAuthSession<Request>(
  db: { transact<T>(operation: () => Promise<T>): Promise<T> },
  oauth: ConnectedAppsDependencies<Request>["oauth"],
  did: string,
  sessionId: string,
): Promise<boolean> {
  return db.transact(async () => {
    const token = (await oauth.stores.listAccountTokens(did)).find(
      (item) => item.id === sessionId,
    );
    if (!token) return false;
    await oauth.stores.deleteToken(token.id);
    return true;
  });
}

export function revokeGrant<Request>(
  oauth: ConnectedAppsDependencies<Request>["oauth"],
  did: string,
  clientId: string,
): Promise<boolean> {
  return oauth.stores.revokeClientGrant(did, clientId);
}

export async function revokeAppAccess<Request>(
  { oauth, legacy }: ConnectedAppsDependencies<Request>,
  did: string,
): Promise<void> {
  await oauth.stores.revokeAllGrants(did);
  await legacy?.revokeAllSessions(did);
}

export async function forgetOAuthDevices<Request>(
  oauth: ConnectedAppsDependencies<Request>["oauth"],
  did: string,
): Promise<void> {
  for (const device of await oauth.stores.listDeviceAccounts({ did }))
    await oauth.stores.removeDeviceAccount(device.deviceId, did);
}
