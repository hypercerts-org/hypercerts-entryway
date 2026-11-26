// Loaded only by the owned managed-winner process, separately from fault injection.
import { managedCreateBarrierFetch } from "./managed-create-barrier.mjs";

const directory = process.env.MANAGED_CREATE_BARRIER_DIRECTORY;
const origin = process.env.MANAGED_CREATE_BARRIER_ORIGIN;
if (!directory || !origin)
  throw new Error("Managed create barrier requires directory and origin");
globalThis.fetch = managedCreateBarrierFetch({
  fetch: globalThis.fetch,
  origin,
  directory,
});
