import { sql } from "drizzle-orm";
/** Deliberate low-level fault injection/inspection for real schema contracts.
 * Production persistence uses schema-backed Drizzle operations. These fixtures
 * accept only fixed query literals; every value is a Drizzle parameter. */
export async function query(db, text, parameters = [], mode = "all") {
  const chunks = [];
  let literal = "",
    quote = null,
    parameter = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      literal += char;
      if (char === quote) {
        if (text[i + 1] === quote) literal += text[++i];
        else quote = null;
      }
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
      literal += char;
    } else if (char === "?") {
      chunks.push(sql.raw(literal), sql`${parameters[parameter++]}`);
      literal = "";
    } else literal += char;
  }
  if (parameter !== parameters.length || quote)
    throw Error("InvalidContractQuery");
  chunks.push(sql.raw(literal));
  const result = await db.execute(
    sql.join(chunks, sql.raw("")),
    mode === "run" ? "run" : "all",
  );
  return mode === "get"
    ? result.rows[0]
    : mode === "run"
      ? result
      : result.rows;
}
export async function failureTrigger(db, name, table, message) {
  if (
    !/^[a-z_]+$/.test(name) ||
    !/^[a-z_]+$/.test(table) ||
    !/^[a-zA-Z -]+$/.test(message)
  )
    throw Error("InvalidFailureFixture");
  if (db.backend === "sqlite")
    await query(
      db,
      `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, '${message}'); END`,
      [],
      "run",
    );
  else {
    await query(
      db,
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${message}'; END $$`,
      [],
      "run",
    );
    await query(
      db,
      `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      [],
      "run",
    );
  }
}
export async function removeFailureTrigger(db, name, table) {
  await query(
    db,
    db.backend === "sqlite"
      ? `DROP TRIGGER ${name}`
      : `DROP TRIGGER ${name} ON ${table}`,
    [],
    "run",
  );
  if (db.backend === "postgresql")
    await query(db, `DROP FUNCTION ${name}()`, [], "run");
}
export function hasFailure(message) {
  return (error) => {
    for (let current = error; current; current = current.cause)
      if (current.message?.toLowerCase().includes(message.toLowerCase()))
        return true;
    return false;
  };
}
export async function verifiedUser(db, id, email) {
  const now = new Date();
  await db.insert("user", {
    id,
    email,
    name: id,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
}
export async function browserSession(db, id, userId, createdAt, expiresAt) {
  await db.insert("session", {
    id,
    userId,
    token: id,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    expiresAt: new Date(expiresAt),
  });
}
