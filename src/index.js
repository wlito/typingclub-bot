#!/usr/bin/env node
import { parseArgs } from "./cli.js";

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("usage: node src/index.js [--wpm N] [--lessons N]");
  } else {
    const { runSession } = await import("./session.js");
    await runSession(opts);
  }
} catch (err) {
  console.error("fatal:", err.message || err);
  process.exitCode = 1;
}
