import { readFileSync } from "node:fs";

export function loadConfig() {
  const config = JSON.parse(
    readFileSync(process.env.SERVICE_CONFIG_PATH ?? "./.runtime/config.json", "utf8"),
  );
  if (process.env.BROWSER_CLIENT_METADATA_URL) {
    config.browserClientMetadataUrl =
      process.env.BROWSER_CLIENT_METADATA_URL;
  }
  return config;
}
