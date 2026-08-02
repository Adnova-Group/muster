import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

import { evaluateInProcessTool } from "./in-process-tools.mjs";

const bundledSchema = fileURLToPath(new URL("./verdict.schema.json", import.meta.url));
const runtime = existsSync(bundledSchema) ? { verdictSchemaPath: bundledSchema } : {};
const result = await evaluateInProcessTool(workerData.name, workerData.args, workerData.environment, runtime);
parentPort.postMessage(result);
