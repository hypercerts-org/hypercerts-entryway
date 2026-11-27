<script lang="ts">
  import type { queryConnectedApps } from "./operations.js";

  type Timestamp = string | number | Date;
  type ConnectedApps = Awaited<ReturnType<typeof queryConnectedApps>>;
  type Props = Pick<
    ConnectedApps,
    "grants" | "tokens" | "legacySessions" | "baSessions" | "devices"
  > & {
    csrf: string;
    did: string;
    sessionId: string;
    deviceId: string;
    view?: "apps" | "devices";
  };
  let {
    csrf,
    did,
    grants,
    tokens,
    legacySessions,
    baSessions,
    devices,
    sessionId,
    deviceId,
    view = "apps",
  }: Props = $props();
  const stamp = (value: Timestamp) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`
      : "Unknown";
  };
</script>

{#snippet revoke(action: string, label: string, name?: string, value?: string)}
  <form method="post" action={`/account/${action}`}>
    <input type="hidden" name="csrf" value={csrf} />
    <input type="hidden" name="did" value={did} />
    {#if name}<input type="hidden" {name} {value} />{/if}
    <button type="submit">{label}</button>
  </form>
{/snippet}

{#if view === "apps"}
  <section id="applications" aria-labelledby="applications-title">
    <h2 id="applications-title">Applications and sessions</h2>
    <p>
      OAuth grants: {grants.length}. Revocation prevents new refreshes; existing
      signed access tokens can remain valid until they expire, up to five
      minutes.
    </p>
    <h3>Application permissions</h3>
    {#if grants.length}
      <ul class="settings-list">
        {#each grants as [clientId, grant] (clientId)}
          <li>
            <strong>{clientId}</strong><span>
              {(grant.authorizedScopes ?? []).join(" ")}
            </span>{@render revoke(
              "grant-revoke",
              "Revoke application access",
              "clientId",
              clientId,
            )}
          </li>
        {/each}
      </ul>
    {:else}<p class="muted">No remembered application permissions.</p>{/if}
    <h3>OAuth sessions</h3>
    {#if tokens.length}
      <ul class="settings-list">
        {#each tokens as token (token.id)}
          <li>
            <strong>{token.data.clientId}</strong><span>
              Created {stamp(token.data.createdAt)}
            </span>{@render revoke(
              "oauth-session-revoke",
              "Revoke OAuth session",
              "sessionId",
              token.id,
            )}
          </li>
        {/each}
      </ul>
    {:else}<p class="muted">No active OAuth refresh sessions.</p>{/if}
    <h3>Legacy application sessions</h3>
    {#if legacySessions.length}
      <ul class="settings-list">
        {#each legacySessions as item (item.id)}
          <li>
            <strong>{item.appPasswordName ?? "Account password"}</strong><span>
              Created {stamp(item.createdAt)} · Expires {stamp(item.expiresAt)}
            </span>{@render revoke(
              "legacy-session-revoke",
              "Revoke legacy session",
              "sessionId",
              item.id,
            )}
          </li>
        {/each}
      </ul>
    {:else}<p class="muted">No legacy application sessions.</p>{/if}
    {@render revoke("revoke", "Revoke all app sessions")}
  </section>
{:else}
  <section id="sessions" aria-labelledby="sessions-title">
    <h2 id="sessions-title">Devices and browser sessions</h2>
    <h3>Account-settings sessions</h3>
    <p>
      These sessions permit access to this console. OAuth device sign-ins and
      app permissions are listed separately.
    </p>
    {#if baSessions.length}
      <ul class="settings-list">
        {#each baSessions as item (item.id)}
          <li>
            <strong>
              {item.id === sessionId ? "This browser" : "Another browser"}
            </strong><span>
              {item.userAgent ?? "Browser details unavailable"} · Created {stamp(
                item.createdAt,
              )}
            </span>{@render revoke(
              "browser-session-revoke",
              "End account-settings session",
              "sessionId",
              item.id,
            )}
          </li>
        {/each}
      </ul>
    {:else}<p class="muted">No browser sessions.</p>{/if}
    <h3>Remembered OAuth devices</h3>
    {#if devices.length}
      <ul class="settings-list">
        {#each devices as item (item.deviceId)}
          <li>
            <strong>
              {item.deviceId === deviceId ? "This device" : "Another device"}
            </strong><span>
              Last used {stamp(item.updatedAt)}
            </span>{@render revoke(
              "device-revoke",
              "Forget OAuth device",
              "deviceId",
              item.deviceId,
            )}
          </li>
        {/each}
      </ul>
    {:else}<p class="muted">No remembered OAuth devices.</p>{/if}
    {@render revoke("browsers-revoke", "Sign out all browsers")}
  </section>
{/if}
