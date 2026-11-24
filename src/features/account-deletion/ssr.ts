import { render } from "svelte/server";
import type { ComponentProps } from "svelte";
import LifecyclePanel from "./LifecyclePanel.svelte";
export const renderLifecyclePanel = (
  props: ComponentProps<typeof LifecyclePanel>,
) => render(LifecyclePanel, { props });
