import { render } from "svelte/server";
import AccountChooser from "./AccountChooser.svelte";
import FlowError from "./FlowError.svelte";
import type { ComponentProps } from "svelte";

export function renderAccountChooser(
  props: ComponentProps<typeof AccountChooser>,
) {
  const { body, head } = render(AccountChooser, { props });
  return { body, head };
}

export function renderFlowError(props: ComponentProps<typeof FlowError>) {
  const { body, head } = render(FlowError, { props });
  return { body, head };
}
