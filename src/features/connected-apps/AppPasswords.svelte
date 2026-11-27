<script lang="ts">
  import type { queryConnectedApps } from "./operations.js";

  type Passwords = Awaited<
    ReturnType<typeof queryConnectedApps>
  >["appPasswords"]["passwords"];
  let {
    passwords,
    csrf,
    did,
  }: { passwords: Passwords; csrf: string; did: string } = $props();
  const stamp = (value: string | number | Date) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`
      : "Unknown";
  };
</script>

<h3>App passwords</h3>
<p>
  Give each legacy application its own password. The generated password is shown
  once; removing it also ends its legacy sessions.
</p>
{#if passwords.length}
  <ul class="settings-list">
    {#each passwords as item (item.name)}
      <li>
        <strong>{item.name}</strong><span>
          Created {stamp(item.createdAt)}{item.privileged
            ? " · Direct-message access"
            : ""}
        </span>
        <form method="post" action="/account/app-password-revoke">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="did" value={did} />
          <input type="hidden" name="name" value={item.name} />
          <button type="submit">Revoke app password</button>
        </form>
      </li>
    {/each}
  </ul>
{:else}
  <p class="muted">No app passwords.</p>
{/if}
<p>
  <a
    class="button"
    href={`/account/manage/app-password?did=${encodeURIComponent(did)}`}
  >
    Create app password
  </a>
</p>
