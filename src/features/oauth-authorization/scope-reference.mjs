import { cidForLex } from "@atproto/lex-cbor";
import { fail } from "../../accounts/input.mjs";

export async function createScopeReferences({ db }) {
  const registerScope = async (scope) => {
    if (
      typeof scope !== "string" ||
      !scope.split(" ").includes("atproto") ||
      scope.length > 8192 ||
      scope.startsWith("ref:")
    )
      fail("InvalidScope", "Provide an inline AT Protocol scope");
    const ref = `ref:${await cidForLex(scope)}`;
    await db.set("entryway:scopes", ref, { scope });
    return { ref };
  };
  const dereferenceScope = async (scope) => {
    const row =
      typeof scope === "string" &&
      scope.startsWith("ref:") &&
      (await db.get("entryway:scopes", scope));
    if (!row) fail("InvalidScopeReference", "Scope reference was not found");
    return row;
  };
  return { registerScope, dereferenceScope };
}
