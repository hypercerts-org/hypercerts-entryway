<script lang="ts">
  let { csrf, did, handle }: { csrf: string; did: string; handle: string } =
    $props();
</script>

<p>Current handle: <strong>{handle}</strong></p>
<form method="post" action="/account/handle">
  <input type="hidden" name="csrf" value={csrf} />
  <input type="hidden" name="did" value={did} />
  <label>
    New handle<input
      name="handle"
      type="text"
      value={handle}
      maxlength="253"
      required
    />
  </label>
  <button type="submit">Update handle</button>
</form>
