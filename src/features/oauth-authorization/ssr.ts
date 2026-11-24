import { render } from "svelte/server";
import type { ComponentProps } from "svelte";
import Consent from "./Consent.svelte";
import RememberedAccount from "./RememberedAccount.svelte";

export function renderConsent(props: ComponentProps<typeof Consent>) {
  const { body, head } = render(Consent, { props });
  return { body, head };
}

export function renderRememberedAccount(
  props: ComponentProps<typeof RememberedAccount>,
) {
  const { body, head } = render(RememberedAccount, { props });
  return { body, head };
}
