import { parentPort, workerData } from "node:worker_threads";
import { openControllerGate } from "./controller-gate-store.mjs";
const gate = openControllerGate(workerData.path);
const barrier = new Int32Array(workerData.barrier);
Atomics.add(barrier, 0, 1);
Atomics.notify(barrier, 0);
while (Atomics.load(barrier, 1) === 0) Atomics.wait(barrier, 1, 0);
try {
  const result = gate.admit(workerData.request);
  if (result.state === "admitted") Atomics.add(barrier, 2, 1);
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error.message });
} finally {
  gate.close();
}
