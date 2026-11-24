<script lang="ts">
  let { csrf, did }: { csrf: string; did: string } = $props();
</script>

<p>
  Give each legacy application its own password. The generated password is shown
  once.
</p>
<form method="post" action="/account/app-password-create">
  <input type="hidden" name="csrf" value={csrf} />
  <input type="hidden" name="did" value={did} />
  <label>
    App password name<input name="name" type="text" maxlength="64" required />
  </label>
  <label class="check">
    <input type="checkbox" name="privileged" value="true" />Allow direct-message
    access
  </label>
  <button type="submit">Create app password</button>
</form>
