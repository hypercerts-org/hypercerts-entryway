import MigrationResult from "./MigrationResult.svelte";
import MigrationConfirmation from "./MigrationConfirmation.svelte";
import { render } from "svelte/server";
import type { ComponentProps } from "svelte";
import MigrationPanel from "./MigrationPanel.svelte";
export const renderMigrationPanel = (
  props: ComponentProps<typeof MigrationPanel>,
) => render(MigrationPanel, { props });

export const renderMigrationConfirmation = (
  props: ComponentProps<typeof MigrationConfirmation>,
) => render(MigrationConfirmation, { props });

export const renderMigrationResult = (
  props: ComponentProps<typeof MigrationResult>,
) => render(MigrationResult, { props });
