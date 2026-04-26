/**
 * Tiny argv parser — no external deps. Recognizes:
 *   - positional args (anything not starting with `--`)
 *   - `--flag value`
 *   - `--flag=value`
 *   - `--bool` (boolean true if present)
 */

export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok.startsWith("--")) {
      const eqIdx = tok.indexOf("=");
      if (eqIdx >= 0) {
        const name = tok.slice(2, eqIdx);
        flags[name] = tok.slice(eqIdx + 1);
        continue;
      }
      const name = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }
    positional.push(tok);
  }
  return { positional, flags };
}

export function requireString(args: ParsedArgs, name: string): string {
  const v = args.flags[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required --${name}`);
  }
  return v;
}

export function optionalString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}
