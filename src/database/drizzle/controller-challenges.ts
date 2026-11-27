import { randomBytes } from "node:crypto";
import { and, eq, gt, gte, isNull, lte, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../executor.js";
import {
  CONTROLLER_MAX_STATEMENT_AGE_MS,
  ControllerContractError,
  controllerBindingExpectationSchema,
  type ControllerBinding,
  type ControllerBindingExpectation,
} from "../../pds/deployment-controller-contract.js";

const MAX_OUTSTANDING_CHALLENGES = 10_000;
type ChallengeContext = Omit<ControllerBindingExpectation, "nonce">;
function context(value: ControllerBindingExpectation): string {
  return JSON.stringify([
    value.issuer,
    value.audience,
    value.controllerEpoch,
    value.deploymentId,
    value.hostId,
    value.revision,
    value.serviceDid,
    value.publicEndpoint,
  ]);
}

/** Shared authority storage. Issuance is internal and does not authenticate a caller. */
export function createControllerChallenges(db: DatabaseExecutor) {
  const table = db.tables.controller_challenges;
  return {
    async issue(
      input: ChallengeContext,
      lifetimeMs: number,
    ): Promise<{ expected: ControllerBindingExpectation; expiresAt: number }> {
      const nonce = randomBytes(32).toString("base64url");
      const parsed = controllerBindingExpectationSchema.safeParse({
        ...input,
        nonce,
      });
      if (
        !parsed.success ||
        !Number.isSafeInteger(lifetimeMs) ||
        lifetimeMs <= 0 ||
        lifetimeMs > CONTROLLER_MAX_STATEMENT_AGE_MS
      )
        throw new ControllerContractError("ControllerInvalidResponse");
      return db.transact(async () => {
        const now = await db.databaseTime();
        const expiresAt = now + lifetimeMs;
        if (!Number.isSafeInteger(expiresAt))
          throw new ControllerContractError("ControllerUnavailable");
        await db.remove("controller_challenges", lte(table.expires_at, now));
        if (
          (
            await db.read("controller_challenges", {
              limit: MAX_OUTSTANDING_CHALLENGES,
            })
          ).length >= MAX_OUTSTANDING_CHALLENGES
        )
          throw new ControllerContractError("ControllerUnavailable");
        await db.insert("controller_challenges", {
          nonce,
          context: context(parsed.data),
          expires_at: expiresAt,
          consumed_at: null,
        });
        return { expected: parsed.data, expiresAt };
      });
    },
    async consume(
      binding: ControllerBinding,
      expected: ControllerBindingExpectation,
    ): Promise<boolean> {
      const parsed = controllerBindingExpectationSchema.safeParse(expected);
      if (
        !parsed.success ||
        binding.nonce !== parsed.data.nonce ||
        context(binding) !== context(parsed.data)
      )
        return false;
      return db.transact(async () => {
        const now = await db.databaseTime();
        const databaseNow =
          db.backend === "sqlite"
            ? sql`CAST(unixepoch('subsec') * 1000 AS INTEGER)`
            : sql`CAST(extract(epoch FROM clock_timestamp()) * 1000 AS BIGINT)`;
        const changed = await db.update(
          "controller_challenges",
          { consumed_at: now },
          and(
            eq(table.nonce, parsed.data.nonce),
            eq(table.context, context(parsed.data)),
            isNull(table.consumed_at),
            gt(table.expires_at, databaseNow),
            sql`${binding.expiresAt} > ${databaseNow}`,
            gte(table.expires_at, binding.expiresAt),
          )!,
        );
        return changed === 1;
      });
    },
  };
}
