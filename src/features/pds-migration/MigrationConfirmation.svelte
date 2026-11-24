<script lang="ts">
  let {
    csrf,
    did,
    handle,
    pdsId,
    target,
    challengeId,
  }: {
    csrf: string;
    did: string;
    handle: string;
    pdsId: string;
    target: string;
    challengeId: string;
  } = $props();
</script>

<p>Selected account: <strong>{handle}</strong> (<code>{did}</code>)</p>
<p role="status">
  A migration code was sent to your primary email. Confirm to move your
  repository and blobs to {target}. Writes will pause and existing sessions and
  app passwords will end.
</p>
<form method="post" action="/account/migration-confirm">
  <input type="hidden" name="csrf" value={csrf} /><input
    type="hidden"
    name="did"
    value={did}
  /><input type="hidden" name="pdsId" value={pdsId} /><input
    type="hidden"
    name="challengeId"
    value={challengeId}
  /><label>
    Migration code<input
      name="token"
      type="text"
      autocomplete="one-time-code"
      maxlength="256"
      required
    />
  </label><button type="submit">Move to destination data server</button>
</form>
<a href={`/account?did=${encodeURIComponent(did)}`}>
  Return to account settings
</a>
