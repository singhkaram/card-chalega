// Starts `next dev` on synthetic SAMPLE data (DATA_SOURCE=sample) — cross-platform,
// no extra dependencies. Sample mode is refused in production builds.
import { spawn } from "node:child_process";

const port = process.env.PORT ?? "3123";
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", port], {
  stdio: "inherit",
  env: { ...process.env, DATA_SOURCE: "sample" },
});
child.on("exit", (code) => process.exit(code ?? 0));
