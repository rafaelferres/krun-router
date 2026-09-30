import readline from "node:readline";

export const MARK = { ok: "✓", warn: "!", error: "✗" };

/** Two or three aligned columns, no colors: readable in any terminal and in pipes. */
export function table(rows, widths = [17, 28]) {
  return rows.map((r) => r.map((c, i) => (i < r.length - 1 ? String(c).padEnd(widths[i] ?? 0) : String(c))).join("").trimEnd()).join("\n");
}

/**
 * Line prompts over any stream pair. Lines are consumed through readline's async iterator,
 * which buffers, so piped input (tests, scripts) is never lost between questions. Secrets are
 * read in raw mode on a TTY and echoed as `*`.
 */
export function createPrompter(input, output) {
  let rl = null;
  let lines = null;
  const next = async () => {
    if (!rl) {
      rl = readline.createInterface({ input, output: input.isTTY ? output : undefined, terminal: Boolean(input.isTTY) });
      lines = rl[Symbol.asyncIterator]();
    }
    const { value, done } = await lines.next();
    return done ? null : value.trim();
  };

  const secret = (question) =>
    new Promise((resolve) => {
      output.write(question);
      let value = "";
      input.setRawMode(true);
      input.resume();
      const finish = () => {
        input.off("data", onData);
        input.setRawMode(false);
        input.pause();
        output.write("\n");
      };
      const onData = (buf) => {
        for (const ch of buf.toString("utf8")) {
          if (ch === "\r" || ch === "\n") return finish(), resolve(value.trim());
          if (ch === "\u0003") return finish(), resolve(null); // Ctrl+C
          if (ch === "\u007f" || ch === "\b") {
            if (value) (value = value.slice(0, -1)), output.write("\b \b");
          } else if (ch >= " ") (value += ch), output.write("*");
        }
      };
      input.on("data", onData);
    });

  return {
    /** Resolves to the trimmed answer, or null at end of input. */
    ask(question) {
      output.write(question);
      return next();
    },
    askSecret(question) {
      // Raw mode needs the TTY to ourselves, i.e. before readline has attached to it.
      if (input.isTTY && typeof input.setRawMode === "function" && !rl) return secret(question);
      return this.ask(question);
    },
    close() {
      rl?.close();
    },
  };
}
