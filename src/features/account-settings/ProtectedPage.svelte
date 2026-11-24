<script lang="ts">
  import { Button, Input } from "@hypercerts-org/ui-svelte";
  type BackupEmail = { email: string; verified: boolean };
  type Props = {
    kind: "password" | "recovery" | "status";
    csrf: string;
    did: string;
    handle: string;
    passwordEnabled?: boolean;
    backupEmails?: BackupEmail[];
    active?: boolean;
  };
  let {
    kind,
    csrf,
    did,
    handle,
    passwordEnabled = false,
    backupEmails = [],
    active = false,
  }: Props = $props();
</script>

<p>Selected account: <strong>{handle}</strong> (<code>{did}</code>)</p>
{#if kind === "password"}
  <p>
    Changing or removing the password ends all sessions and removes existing app
    passwords.
  </p>
  <form method="post" action="/account/password-set">
    <input type="hidden" name="csrf" value={csrf} /><input
      type="hidden"
      name="did"
      value={did}
    /><label>
      New account password<Input
        name="password"
        type="password"
        autocomplete="new-password"
        minlength="12"
        maxlength="256"
        required
      />
    </label><Button type="submit">
      {passwordEnabled ? "Change account password" : "Set account password"}
    </Button>
  </form>
  {#if passwordEnabled}
    <h2>Remove account password</h2>
    <p>Email sign-in remains available after the password is removed.</p>
    <form method="post" action="/account/password-remove">
      <input type="hidden" name="csrf" value={csrf} /><input
        type="hidden"
        name="did"
        value={did}
      /><Button type="submit">Remove account password</Button>
    </form>
  {/if}
{:else if kind === "recovery"}
  <p>
    Add an email you can still access if your primary mailbox is lost. Each
    recovery address must be verified before it can restore access.
  </p>
  {#if backupEmails.length}<ul class="settings-list">
      {#each backupEmails as item (item.email)}<li>
          <strong>{item.email}</strong><span>
            {item.verified ? "Verified" : "Awaiting verification"}
          </span>
          <form method="post" action="/account/backup-remove">
            <input type="hidden" name="csrf" value={csrf} /><input
              type="hidden"
              name="did"
              value={did}
            /><input type="hidden" name="email" value={item.email} /><Button
              type="submit"
            >
              Remove recovery email
            </Button>
          </form>
        </li>{/each}
    </ul>{:else}<p class="muted">No verified recovery email.</p>{/if}
  <form method="post" action="/account/backup-request">
    <input type="hidden" name="csrf" value={csrf} /><input
      type="hidden"
      name="did"
      value={did}
    /><label>
      Recovery email address<Input
        name="email"
        type="email"
        autocomplete="email"
        maxlength="320"
        required
      />
    </label><Button type="submit">Send recovery verification</Button>
  </form>
{:else}
  <p>
    {active
      ? "Deactivation pauses repository writes and signs out connected apps. You can reactivate the account later."
      : "Reactivation restores repository writes."}
  </p>
  <form method="post" action="/account/status">
    <input type="hidden" name="csrf" value={csrf} /><input
      type="hidden"
      name="did"
      value={did}
    /><input
      type="hidden"
      name="status"
      value={active ? "deactivated" : "active"}
    /><Button type="submit">
      {active ? "Deactivate account" : "Reactivate account"}
    </Button>
  </form>
{/if}
<p>
  <a href={`/account?did=${encodeURIComponent(did)}`}>
    Return to account settings
  </a>
</p>
