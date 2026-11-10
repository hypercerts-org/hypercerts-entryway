import { cidForCbor } from "@atproto/common";
import { Secp256k1Keypair } from "@atproto/crypto";
import * as plc from "@did-plc/lib";
import { PlcError } from "./errors.js";
import { publicUpdateCandidate, validateUnsignedOperation } from "./policy.js";

/** The private rotation key is received only at composition. */
export class Secp256k1MigrationPlcSigner {
  public readonly keyReference: string;
  readonly #key: Secp256k1Keypair;
  private constructor(key: Secp256k1Keypair, keyReference: string) {
    this.#key = key;
    this.keyReference = keyReference;
  }
  public static async fromHex(
    hex: string,
    keyReference = "entryway-plc-rotation",
  ): Promise<Secp256k1MigrationPlcSigner> {
    const key = await Secp256k1Keypair.import(Buffer.from(hex, "hex"));
    return new Secp256k1MigrationPlcSigner(key, keyReference);
  }
  #previous(value: unknown): plc.CompatibleOp {
    const parsed = plc.def.compatibleOp.safeParse(value);
    if (!parsed.success)
      throw new PlcError(
        "InvalidPlcOperation",
        "The current identity operation is invalid",
      );
    return parsed.data;
  }
  public publicKey(): string {
    return this.#key.did();
  }
  public async signPublicUpdate(
    current: unknown,
    replacement: unknown,
    authorize: (
      facts: Readonly<plc.UnsignedOperation>,
      cid: string,
    ) => Promise<void>,
  ): Promise<plc.Operation> {
    const { facts, candidate } = await this.#updateCandidate(
      current,
      replacement,
    );
    // Only public unsigned facts cross this boundary. The signature stays here
    // until release authorization has committed its physical transaction.
    await authorize(
      structuredClone(facts),
      String(await cidForCbor(candidate)),
    );
    return candidate;
  }
  async #updateCandidate(current: unknown, replacement: unknown) {
    const previous = this.#previous(current);
    const authority = plc.normalizeOp(previous).rotationKeys;
    if (!authority.includes(this.#key.did()))
      throw new PlcError(
        "AuthorityNotDelegated",
        "Entryway signing authority is absent",
      );
    const facts = await publicUpdateCandidate(previous, replacement);
    const candidate = await plc.signOperation(facts, this.#key);
    await plc.assureValidSig(authority, candidate);
    return { facts, candidate };
  }
  /** Internal callers already own durable admission. Persist exact signed bytes
   * and unsigned custody evidence in one fenced transaction before dispatch.
   * This capability is not the public proof-gated release method.
   */
  async #signAuthorizedUpdate(
    current: unknown,
    replacement: unknown,
    persist: (
      operation: Readonly<plc.Operation>,
      facts: Readonly<plc.UnsignedOperation>,
      cid: string,
    ) => Promise<void>,
  ): Promise<plc.Operation> {
    const { facts, candidate } = await this.#updateCandidate(
      current,
      replacement,
    );
    await persist(
      structuredClone(candidate),
      structuredClone(facts),
      String(await cidForCbor(candidate)),
    );
    return candidate;
  }
  public async signGenesis(input: {
    signingKey: string;
    rotationKeys: string[];
    handle: string;
    pds: string;
  }): Promise<{ did: string; op: plc.Operation }> {
    const facts = validateUnsignedOperation(
      plc.formatAtprotoOp({ ...input, prev: null }),
    );
    if (new Set(facts.rotationKeys).size !== facts.rotationKeys.length)
      throw new PlcError(
        "InvalidPlcOperation",
        "Genesis rotation keys must be distinct",
      );
    if (!facts.rotationKeys.includes(this.#key.did()))
      throw new PlcError(
        "AuthorityNotDelegated",
        "The selected genesis signer is unavailable",
      );
    const op = await plc.signOperation(facts, this.#key);
    await plc.assureValidSig(facts.rotationKeys, op);
    return { did: await plc.didForCreateOp(op), op };
  }
  public async signHandleUpdate(
    current: unknown,
    handle: string,
    persist: (
      operation: Readonly<plc.Operation>,
      facts: Readonly<plc.UnsignedOperation>,
      cid: string,
    ) => Promise<void>,
  ): Promise<plc.Operation> {
    const previous = this.#previous(current);
    const aliases = [...plc.normalizeOp(previous).alsoKnownAs];
    const index = aliases.findIndex((alias) => alias.startsWith("at://"));
    if (index < 0) aliases.unshift(`at://${handle}`);
    else aliases[index] = `at://${handle}`;
    return this.#signAuthorizedUpdate(
      previous,
      { alsoKnownAs: aliases },
      persist,
    );
  }
  public async signManagedMove(
    current: unknown,
    repositoryKey: string,
    pdsUrl: string,
    persist: (
      operation: Readonly<plc.Operation>,
      facts: Readonly<plc.UnsignedOperation>,
      cid: string,
    ) => Promise<void>,
  ): Promise<plc.Operation> {
    const previous = this.#previous(current);
    const facts = plc.normalizeOp(previous);
    return this.#signAuthorizedUpdate(
      previous,
      {
        verificationMethods: {
          ...facts.verificationMethods,
          atproto: repositoryKey,
        },
        services: {
          ...facts.services,
          atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: pdsUrl },
        },
      },
      persist,
    );
  }
  public async signManagedRepair(
    current: unknown,
    repositoryKey: string,
    persist: (
      operation: Readonly<plc.Operation>,
      facts: Readonly<plc.UnsignedOperation>,
      cid: string,
    ) => Promise<void>,
  ): Promise<plc.Operation> {
    const previous = this.#previous(current);
    return this.#signAuthorizedUpdate(
      previous,
      {
        verificationMethods: {
          ...plc.normalizeOp(previous).verificationMethods,
          atproto: repositoryKey,
        },
      },
      persist,
    );
  }
  public async signMigrationMove(
    input: {
      workflowId: string;
      did: string;
      handoffOperation: unknown;
      targetPdsUrl: string;
      targetRepositoryKey: string;
      handle: string;
    },
    persist: (
      operation: Readonly<plc.Operation>,
      facts: Readonly<plc.UnsignedOperation>,
      cid: string,
    ) => Promise<void>,
  ): Promise<{ operation: unknown; cid: string }> {
    void input.workflowId;
    const previous = this.#previous(input.handoffOperation);
    const normalized = plc.normalizeOp(previous);
    const operation = await this.#signAuthorizedUpdate(
      previous,
      {
        alsoKnownAs: [`at://${input.handle}`],
        verificationMethods: {
          ...normalized.verificationMethods,
          atproto: input.targetRepositoryKey,
        },
        services: {
          ...normalized.services,
          atproto_pds: {
            type: "AtprotoPersonalDataServer",
            endpoint: input.targetPdsUrl,
          },
        },
      },
      persist,
    );
    return { operation, cid: String(await cidForCbor(operation)) };
  }
}
