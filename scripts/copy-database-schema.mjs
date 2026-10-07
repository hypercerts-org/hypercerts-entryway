import { copyFile, mkdir } from "node:fs/promises";
await mkdir("dist/src/database/schema", { recursive: true });
for (const backend of ["sqlite", "postgresql"])
  await copyFile(
    `src/database/schema/${backend}.sql`,
    `dist/src/database/schema/${backend}.sql`,
  );
