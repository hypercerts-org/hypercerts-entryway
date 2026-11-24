<script lang="ts">
  type Props = {
    pending: boolean;
    required: boolean;
    did: string;
    handle: string;
    target: string;
    pdsId: string;
    csrf: string;
  };
  let { pending, required, did, handle, target, pdsId, csrf }: Props = $props();
</script>

{#if pending}
  <p role="alert">
    {required
      ? "An earlier server request has an uncertain outcome. Contact the service operator; retrying alone cannot resolve it."
      : "Your saved migration is unfinished. Continue it after the operator authorizes any required recovery."}
  </p>
  <p>
    Your DID <code>{did}</code> and handle <strong>{handle}</strong> are
    retained. The saved destination is {target}.
  </p>
  {#if required}<p>Waiting for operator recovery.</p>{:else}<form
      method="post"
      action="/account/migration-confirm"
    >
      <input type="hidden" name="csrf" value={csrf} /><input
        type="hidden"
        name="did"
        value={did}
      /><input type="hidden" name="pdsId" value={pdsId} /><button type="submit">
        Continue saved migration
      </button>
    </form>{/if}
  <p>
    <a href={`/account?did=${encodeURIComponent(did)}`}>
      Return to account settings
    </a>
  </p>
{:else}
  <p>
    Your DID and handle are unchanged. Your repository is now on {target}; the
    old server retains a deactivated copy. Existing sessions and app passwords
    were revoked.
  </p>
  <a href="/login">Sign in again to your moved account</a>
{/if}
