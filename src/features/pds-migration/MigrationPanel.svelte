<script lang="ts">
  type Server = { id: string; url: string };
  type Migration = {
    phase: string;
    targetPdsId: string;
    updatedAt: string | number | Date;
  };
  let {
    servers,
    pdsId,
    csrf,
    did,
    migrationState,
    recoveryRequired,
  }: {
    servers: Server[];
    pdsId: string;
    csrf: string;
    did: string;
    migrationState: Migration | null;
    recoveryRequired: boolean;
  } = $props();
  let destinations = $derived(servers.filter((server) => server.id !== pdsId));
  let pending = $derived(migrationState && migrationState.phase !== "complete");
  let target = $derived(
    migrationState &&
      (servers.find((server) => server.id === migrationState?.targetPdsId)
        ?.url ??
        migrationState.targetPdsId),
  );
  function stamp(value: string | number | Date) {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`
      : "Unknown";
  }
</script>

<section id="migration" aria-labelledby="migration-title">
  <h2 id="migration-title">Move your data server</h2>
  <p>
    Move this account's repository and blobs to another enrolled data server
    while keeping its DID and handle. Writes pause during the transfer, and all
    browser and application sessions and app passwords are revoked. The old
    server retains a deactivated copy.
  </p>
  {#if migrationState}
    <p role="status">
      {#if pending}Your migration to {target} is unfinished. {recoveryRequired
          ? "Contact the service operator; retrying alone cannot settle the uncertain server request."
          : "Continue the saved migration."} Keep repository writes paused until it
        completes.{:else}Last migration completed to {target}.{/if} Last updated {stamp(
        migrationState.updatedAt,
      )}.
    </p>
  {/if}
  {#if pending && migrationState}
    <form method="post" action="/account/migration-confirm">
      <input type="hidden" name="csrf" value={csrf} /><input
        type="hidden"
        name="did"
        value={did}
      /><input
        type="hidden"
        name="pdsId"
        value={migrationState.targetPdsId}
      /><button type="submit" disabled={recoveryRequired}>
        {recoveryRequired
          ? "Waiting for operator recovery"
          : "Resume data server migration"}
      </button>
    </form>
  {:else if destinations.length}
    <form method="post" action="/account/migration-request">
      <input type="hidden" name="csrf" value={csrf} /><input
        type="hidden"
        name="did"
        value={did}
      /><label>
        Destination data server<select name="pdsId" required>
          {#each destinations as server (server.id)}<option value={server.id}>
              {server.id} — {server.url}
            </option>{/each}
        </select>
      </label><button type="submit">Start data server migration</button>
    </form>
  {:else}<p>No other data server is enrolled.</p>{/if}
</section>
