/** Stable public errors never retain untrusted candidates or key material. */
export class PlcError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlcError";
  }
}
