import test from "node:test";
import { qualifyIncomingArrival } from "../support/helpers/incoming-arrival-live.mjs";

test(
  "stock source reaches composed inactive pending arrival without fixture authority",
  {
    skip: !process.env.INCOMING_PUBLIC_MECHANISMS,
    timeout: 120_000,
  },
  (t) => qualifyIncomingArrival(t),
);

for (const fault of ["creation-lost", "pause-lost"]) {
  test(
    `stock applied ${fault} remains unbound and rejects unsafe retry`,
    {
      skip: !process.env.INCOMING_PUBLIC_MECHANISMS,
      timeout: 120_000,
    },
    (t) => qualifyIncomingArrival(t, fault),
  );
}
