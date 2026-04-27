/**
 * Tiny argv parser — no external deps. Recognizes:
 *   - positional args (anything not starting with `--`)
 *   - `--flag value`
 *   - `--flag=value`
 *   - `--bool` (boolean true if present)
 *
 * Callers can declare a set of `booleanFlags` whose presence MUST be parsed as
 * a boolean true rather than greedily consuming the next argv token. Without
 * this, `--strict --host=grove` would consume `--host=grove` as the strict
 * value (next-token isn't `--`-prefixed only because we already special-case
 * that — but a plain bareword like `--strict somethingelse` would be eaten).
 * Declaring `--strict` boolean closes that gap.
 */

export type ParseOptions = {
  /** Flag names (without leading `--`) that MUST parse as boolean. */
  booleanFlags?: ReadonlyArray<string>;
};

export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[], opts: ParseOptions = {}): ParsedArgs {
  const booleans = new Set(opts.booleanFlags ?? []);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok.startsWith("--")) {
      const eqIdx = tok.indexOf("=");
      if (eqIdx >= 0) {
        const name = tok.slice(2, eqIdx);
        const rawValue = tok.slice(eqIdx + 1);
        // Boolean flags accept --flag=true / --flag=false explicitly; everything
        // else for a declared boolean is a hard error so typos surface fast.
        if (booleans.has(name)) {
          if (rawValue === "true") flags[name] = true;
          else if (rawValue === "false") flags[name] = false;
          else throw new Error(`flag --${name} is boolean; got --${name}=${rawValue}`);
        } else {
          flags[name] = rawValue;
        }
        continue;
      }
      const name = tok.slice(2);
      // Declared boolean: never consume next token, just mark true.
      if (booleans.has(name)) {
        flags[name] = true;
        continue;
      }
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
