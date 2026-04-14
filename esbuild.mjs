import { build } from "esbuild";

const handlers = [
  { entry: "src/webhook-publisher/handler.ts", out: "dist/webhook-publisher.js" },
  { entry: "src/dynamo-subscriber/handler.ts", out: "dist/dynamo-subscriber.js" },
  { entry: "src/firehose-transform/handler.ts", out: "dist/firehose-transform.js" },
  { entry: "src/orchestrator/handler.ts", out: "dist/orchestrator.js" },
  { entry: "src/metabase-stop/handler.ts", out: "dist/metabase-stop.js" },
];

for (const { entry, out } of handlers) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node20",
    outfile: out,
    // AWS SDK v3 is available in the Lambda Node.js 20 runtime
    external: ["@aws-sdk/*"],
  });
  console.log(`Built ${entry} → ${out}`);
}
