import { readFileSync } from "node:fs";

export function loadConfig() {
  const config = JSON.parse(
    readFileSync(process.env.SPIKE_CONFIG ?? "./.runtime/config.json", "utf8"),
  );
  if (process.env.SPIKE_BROWSER_CLIENT_METADATA_URL) {
    config.browserClientMetadataUrl =
      process.env.SPIKE_BROWSER_CLIENT_METADATA_URL;
  }
  return config;
}
