export function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg !== "--wpm" && arg !== "--lessons") {
      throw new Error("unknown argument: " + arg);
    }
    const raw = args[++i];
    const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    if (!Number.isFinite(value) || value <= 0 ||
        (arg === "--lessons" && !Number.isSafeInteger(value))) {
      throw new Error(arg + " requires a positive " +
        (arg === "--lessons" ? "integer" : "number"));
    }
    opts[arg === "--wpm" ? "wpm" : "lessons"] = value;
  }
  return opts;
}
