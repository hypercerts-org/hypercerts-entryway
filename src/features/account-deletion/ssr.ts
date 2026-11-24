import DeleteConfirmation from "./DeleteConfirmation.svelte";
import { render } from "svelte/server";
import type { ComponentProps } from "svelte";
import LifecyclePanel from "./LifecyclePanel.svelte";
export const renderLifecyclePanel = (
  props: ComponentProps<typeof LifecyclePanel>,
) => render(LifecyclePanel, { props });

export const renderDeleteConfirmation = (
  props: ComponentProps<typeof DeleteConfirmation>,
) => render(DeleteConfirmation, { props });
