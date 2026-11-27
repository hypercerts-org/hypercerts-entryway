import { readFileSync } from "node:fs";
import { openControllerGate } from "./controller-gate-store.mjs";
const [path] = process.argv.slice(2);
const request = JSON.parse(readFileSync(0, "utf8"));
const gate = openControllerGate(path);
if (gate.admit(request).state !== "admitted") process.exit(1);
process.kill(process.pid, "SIGKILL");
