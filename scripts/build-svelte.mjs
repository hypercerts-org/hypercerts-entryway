import { copyFile, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const owners = await readdir("src/features", { withFileTypes: true });
const primitiveNames = new Set();
async function collectPrimitives(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collectPrimitives(path);
    else if (/\.(?:svelte|ts|mjs)$/.test(entry.name)) {
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(
        /import\s*\{([^}]+)\}\s*from\s*["']@hypercerts-org\/ui-svelte["']/g,
      )) {
        for (const part of match[1].split(","))
          primitiveNames.add(part.trim().split(/\s+as\s+/)[0]);
      }
    }
  }
}
await collectPrimitives("src");
const entries = { ui: resolve("src/ui/ssr.ts") };
for (const owner of owners) {
  if (!owner.isDirectory()) continue;
  const files = await readdir(`src/features/${owner.name}`);
  if (files.includes("ssr.ts"))
    entries[owner.name] = resolve(`src/features/${owner.name}/ssr.ts`);
}
await build({
  configFile: false,
  plugins: [
    {
      name: "ui-svelte-primitives",
      async load(id) {
        if (
          !id.endsWith("/node_modules/@hypercerts-org/ui-svelte/dist/index.js")
        )
          return null;
        const source = await readFile(id, "utf8");
        return source
          .split("\n")
          .filter((line) => {
            const match =
              /^export \{ default as (\w+) \} from "\.\/.*\.svelte";$/.exec(
                line,
              );
            return match && primitiveNames.has(match[1]);
          })
          .join("\n");
      },
    },
    svelte(),
  ],
  build: {
    ssr: true,
    outDir: "dist/ssr",
    emptyOutDir: false,
    rollupOptions: { input: entries, output: { entryFileNames: "[name].js" } },
  },
  ssr: { noExternal: ["@hypercerts-org/ui-svelte"] },
});

await copyFile(
  new URL(import.meta.resolve("@hypercerts-org/ui-svelte/styles.css")),
  "dist/ssr/hypercerts-ui.css",
);

await copyFile("src/ui/svelte-layout.css", "dist/ssr/svelte-layout.css");

await copyFile(
  "src/ui/assets/certified-brandmark.svg",
  "dist/ssr/certified-brandmark.svg",
);
await copyFile(
  "src/ui/assets/certified-text-monochrome.svg",
  "dist/ssr/certified-text-monochrome.svg",
);
