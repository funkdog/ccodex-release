"use strict";

const { localShellCommand } = require("./ccodex-local-command.cjs");

const SHIFT_ENTER_INPUT = process.platform === "win32"
  ? "\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;0;1_\x1b[16;42;0;0;0;1_"
  : "\n";

class CliInputRouter {
  constructor({ readUsageCommand = () => null, readLocalCommand = readUsageCommand,
    onSubmit = () => {}, onRoute = () => {} } = {}) {
    this.draft = "";
    this.cursor = 0;
    this.safe = true;
    this.pasting = false;
    this.pending = "";
    this.readLocalCommand = readLocalCommand;
    this.onSubmit = onSubmit;
    this.onRoute = onRoute;
  }

  reset() {
    this.draft = "";
    this.cursor = 0;
    this.safe = true;
  }

  insert(text) {
    this.draft = this.draft.slice(0, this.cursor) + text + this.draft.slice(this.cursor);
    this.cursor += text.length;
    if (this.draft.length > 4096) this.safe = false;
  }

  transform(chunk) {
    const value = this.pending + chunk;
    this.pending = "";
    let output = "";
    for (let at = 0; at < value.length;) {
      if (value[at] === "\x1b") {
        const remaining = value.slice(at);
        const sequence = remaining.match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0];
        if (!sequence && (remaining === "\x1b" || remaining.startsWith("\x1b["))) {
          this.pending = remaining;
          break;
        }
        if (sequence) {
          at += sequence.length;
          if (sequence === "\x1b[200~") this.pasting = true;
          else if (sequence === "\x1b[201~") this.pasting = false;
          else if (sequence === "\x1b[13;2u" || sequence === "\x1b[27;2;13~") {
            this.insert("\n");
            this.safe = false;
            output += SHIFT_ENTER_INPUT;
            continue;
          } else if (sequence === "\x1b[D") this.cursor = Math.max(0, this.cursor - 1);
          else if (sequence === "\x1b[C") this.cursor = Math.min(this.draft.length, this.cursor + 1);
          else if (sequence === "\x1b[H" || sequence === "\x1b[1~") this.cursor = 0;
          else if (sequence === "\x1b[F" || sequence === "\x1b[4~") this.cursor = this.draft.length;
          else if (sequence === "\x1b[3~") {
            this.draft = this.draft.slice(0, this.cursor) + this.draft.slice(this.cursor + 1);
          } else this.safe = false;
          output += sequence;
          continue;
        }
        this.safe = false;
      }
      const char = value[at++];
      if (char === "\r" && !this.pasting) {
        const tracked = this.draft.trim();
        this.onSubmit(tracked);
        const visible = this.readLocalCommand();
        // A frame may lag behind a single input chunk. Complete tracked input
        // wins only while editing is fully understood; otherwise use the screen.
        const command = this.safe && localShellCommand(tracked) ? tracked
          : visible || (this.safe ? tracked : null);
        const shell = command && localShellCommand(command);
        this.onRoute({ safe: this.safe, trackedLocal: !!localShellCommand(tracked),
          visibleLocal: !!visible, routed: !!(shell &&
            (this.safe || command === visible) && !this.draft.includes("\n")),
          draftLength: this.draft.length, cursor: this.cursor });
        if (shell &&
            (this.safe || command === visible) && !this.draft.includes("\n")) {
          // Run inside the native transcript, never through the model provider.
          output += "\x01\x7f" + shell + "\r";
        } else output += char;
        this.reset();
        continue;
      }
      if (char === "\x03") this.reset();
      else if (char === "\x15") {
        this.draft = this.draft.slice(this.cursor);
        this.cursor = 0;
      } else if (char === "\x01") this.cursor = 0;
      else if (char === "\x05") this.cursor = this.draft.length;
      else if (char === "\x7f" || char === "\b") {
        if (this.cursor > 0) {
          this.draft = this.draft.slice(0, this.cursor - 1) + this.draft.slice(this.cursor);
          this.cursor--;
        }
      } else if (char === "\n" || char === "\r") {
        this.insert(char);
        this.safe = false;
        if (char === "\n" && !this.pasting) {
          output += SHIFT_ENTER_INPUT;
          continue;
        }
      } else if (char >= " " && char !== "\x7f") this.insert(char);
      else this.safe = false;
      output += char;
    }
    return output;
  }

  flush() {
    const value = this.pending;
    if (value) this.safe = false;
    this.pending = "";
    return value;
  }

  needsComposerConfirmation() {
    if (this.safe || this.pasting || this.pending || this.draft.includes("\n") ||
        !localShellCommand(this.draft.trim())) return false;
    return !this.readLocalCommand();
  }

}

module.exports = { CliInputRouter, SHIFT_ENTER_INPUT };
