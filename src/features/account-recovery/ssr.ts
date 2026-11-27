import { render } from "svelte/server";
import type { ComponentProps } from "svelte";
import Recovery from "./Recovery.svelte";
export const renderRecovery = (props: ComponentProps<typeof Recovery>) =>
  render(Recovery, { props });
