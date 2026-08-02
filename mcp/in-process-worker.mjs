import { parentPort, workerData } from "node:worker_threads";

import { evaluateInProcessTool } from "./in-process-tools.mjs";

const result = await evaluateInProcessTool(workerData.name, workerData.args, workerData.environment);
parentPort.postMessage(result);
