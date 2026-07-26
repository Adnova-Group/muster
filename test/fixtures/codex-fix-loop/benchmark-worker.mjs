import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

function complete(request) {
  let digest = "";
  for (let pass = 0; pass < 40; pass += 1) {
    digest = createHash("sha256").update(request.prompt).update(digest).digest("hex");
  }
  return {
    type: "turn.completed",
    usage: { input_tokens: Math.ceil(Buffer.byteLength(request.prompt, "utf8") / 4) },
    digest
  };
}

if (process.argv.includes("--oneshot")) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(JSON.stringify(complete(JSON.parse(input))) + "\n");
} else {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    process.stdout.write(JSON.stringify(complete(JSON.parse(line))) + "\n");
  }
}
