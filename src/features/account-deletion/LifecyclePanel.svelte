<script lang="ts">
  let { csrf, did, status }: { csrf: string; did: string; status: string } =
    $props();
</script>

<section id="lifecycle" aria-labelledby="lifecycle-title">
  <h2 id="lifecycle-title">Account lifecycle</h2>
  <p>Status: {status}</p>
  <p>
    Deactivation pauses repository writes. Reactivation restores them. Deleting
    the account removes the repository and blobs; the DID history remains.
  </p>
  <p>
    <a
      class="button"
      href={`/account/manage/status?did=${encodeURIComponent(did)}`}
    >
      {status === "active" ? "Deactivate account" : "Reactivate account"}
    </a>
  </p>
  <form method="post" action="/account/delete">
    <input type="hidden" name="csrf" value={csrf} /><input
      type="hidden"
      name="did"
      value={did}
    /><label>
      Type your handle to delete this test account<input
        name="confirm"
        type="text"
        autocomplete="off"
        required
      />
    </label><button type="submit">Delete test account</button>
  </form>
</section>
