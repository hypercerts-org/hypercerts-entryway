<script lang="ts">
  let {
    security,
    backupEmails,
    did,
  }: {
    security: boolean;
    backupEmails: { email: string; verified: boolean }[];
    did: string;
  } = $props();
</script>

<section id="recovery" aria-labelledby="recovery-title">
  <h2 id="recovery-title">Recovery email</h2>
  {#if security}
    <p>
      Add an email you can still access if your primary mailbox is lost. Each
      recovery address must be verified before it can restore access.
    </p>
    {#if backupEmails.length}<ul class="settings-list">
        {#each backupEmails as item (item.email)}<li>
            <strong>{item.email}</strong><span>
              {item.verified ? "Verified" : "Awaiting verification"}
            </span>
          </li>{/each}
      </ul>{:else}<p class="muted">No verified recovery email.</p>{/if}
    <p>
      <a
        class="button"
        href={`/account/manage/recovery?did=${encodeURIComponent(did)}`}
      >
        Manage recovery email
      </a>
    </p>
    <p>
      <a href="/recover">Recover an account using a verified recovery email</a>
    </p>
  {:else}<p>Recovery email setup is not available yet.</p>{/if}
</section>
