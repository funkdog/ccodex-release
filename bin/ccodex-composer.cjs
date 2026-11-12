"use strict";

const { Terminal } = require("./xterm-headless");

class ComposerScreen {
  constructor(columns, rows) {
    this.terminal = new Terminal({
      cols: columns, rows, allowProposedApi: true, scrollback: 0,
    });
  }

  write(data) {
    this.terminal.write(data);
  }

  resize(columns, rows) {
    this.terminal.resize(columns, rows);
  }

  readLocalCommand() {
    const buffer = this.terminal.buffer.active;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    const text = line?.translateToString(true) || "";
    const match = /^\s*[\u203a\u276f]\s+(\/(?:usage(?: --json)?|sessions(?: [^\r\n]+)?))\s*$/.exec(text);
    if (!match) return null;
    const prefix = text.indexOf(match[1]);
    if (buffer.cursorX < prefix || buffer.cursorX > prefix + match[1].length) return null;
    // The docked composer separates its editable rows from the status footer
    // with blank rows. Do not treat a visible line of a multiline draft as a command.
    const next = buffer.getLine(buffer.baseY + buffer.cursorY + 1)?.translateToString(true) || "";
    if (next.trim()) return null;
    return match[1].trimEnd();
  }

  readUsageCommand() {
    const command = this.readLocalCommand();
    return command?.startsWith("/usage") ? command : null;
  }

  inspectLocalCommandFrame() {
    const buffer = this.terminal.buffer.active;
    const at = buffer.baseY + buffer.cursorY;
    const current = buffer.getLine(at)?.translateToString(true) || "";
    return { cursorX: buffer.cursorX, cursorY: buffer.cursorY,
      composerLike: /^\s*[\u203a\u276f]/.test(current),
      lineLocal: /^\s*[\u203a\u276f]\s+\/(?:usage|sessions)(?:\s|$)/.test(current),
      nextBlank: !(buffer.getLine(at + 1)?.translateToString(true) || "").trim() };
  }

  flush() {
    return new Promise(resolve => this.terminal.write("", resolve));
  }

  dispose() {
    this.terminal.dispose();
  }
}

module.exports = { ComposerScreen };
