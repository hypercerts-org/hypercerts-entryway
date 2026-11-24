<script lang="ts">
  let {
    csrf,
    did,
    handle,
    challengeId,
    passwordEnabled,
  }: {
    csrf: string;
    did: string;
    handle: string;
    challengeId: string;
    passwordEnabled: boolean;
  } = $props();
</script>

<p>Selected account: <strong>{handle}</strong> (<code>{did}</code>)</p>
<p role="status">
  A deletion code was sent to your primary email. This deletes your repository
  and blobs.
</p>
<form method="post" action="/account/delete-confirm">
  <input type="hidden" name="csrf" value={csrf} /><input
    type="hidden"
    name="did"
    value={did}
  /><input type="hidden" name="confirm" value={handle} /><input
    type="hidden"
    name="challengeId"
    value={challengeId}
  />
  <label>
    Deletion code<input
      name="token"
      type="text"
      autocomplete="one-time-code"
      maxlength="256"
      required
    />
  </label>
  {#if passwordEnabled}<label>
      Current password<input
        name="password"
        type="password"
        autocomplete="current-password"
        maxlength="256"
        required
      />
    </label>{/if}
  <button type="submit">Permanently delete account</button>
</form>
<a href={`/account?did=${encodeURIComponent(did)}`}>
  Return to account settings
</a>
