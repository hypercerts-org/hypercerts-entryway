import { render } from "svelte/server";
import AccountChooser from "./AccountChooser.svelte";
import type { ComponentProps } from "svelte";

export function renderAccountChooser(
  props: ComponentProps<typeof AccountChooser>,
) {
  const { body, head } = render(AccountChooser, { props });
  return { body, head };
}
