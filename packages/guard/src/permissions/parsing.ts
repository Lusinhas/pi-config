export class BashParser {
  static split(command: string): string[] {
    const segments: string[] = [];
    let current = "";
    let single = false;
    let double = false;
    let i = 0;

    while (i < command.length) {
      const ch = command[i];

      if (single) {
        current += ch;

        if (ch === "'") {
          single = false;
        }

        i += 1;
        continue;
      }

      if (double) {
        if (ch === "\\" && i + 1 < command.length) {
          current += ch + command[i + 1];
          i += 2;
          continue;
        }

        current += ch;

        if (ch === '"') {
          double = false;
        }

        i += 1;
        continue;
      }

      if (ch === "\\" && i + 1 < command.length) {
        current += ch + command[i + 1];
        i += 2;
        continue;
      }

      if (ch === "'") {
        single = true;
        current += ch;
        i += 1;
        continue;
      }

      if (ch === '"') {
        double = true;
        current += ch;
        i += 1;
        continue;
      }

      if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
        segments.push(current);
        current = "";
        i += 2;
        continue;
      }

      if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
        segments.push(current);
        current = "";
        i += 1;
        continue;
      }

      current += ch;
      i += 1;
    }

    segments.push(current);

    const trimmed = segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);

    return trimmed.length > 0 ? trimmed : [command.trim()];
  }

  static program(segment: string): string {
    const tokens = segment.split(/\s+/).filter((token) => token.length > 0);

    for (const token of tokens) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        continue;
      }

      return token;
    }

    return tokens.length > 0 ? tokens[0] : "";
  }
}
