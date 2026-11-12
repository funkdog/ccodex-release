/**
 * Lossless edits of owned TOML settings. Unknown statements are kept verbatim,
 * including multiline strings/arrays and quoted table names.
 */
function statements(text) {
  const result = [];
  let start = 0;
  let quote = null;
  let triple = false;
  let depth = 0;
  let comment = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (comment) {
      if (char !== "\n") continue;
      comment = false;
    } else if (quote) {
      if (quote === '"' && char === "\\") { at += 1; continue; }
      if (char === quote && (!triple || text.slice(at, at + 3) === quote.repeat(3))) {
        at += triple ? 2 : 0;
        quote = null;
      }
      continue;
    } else if (char === "#") {
      comment = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      triple = text.slice(at, at + 3) === char.repeat(3);
      at += triple ? 2 : 0;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
    }
    if (char === "\n" && depth === 0) {
      result.push(text.slice(start, at + 1));
      start = at + 1;
    }
  }
  if (quote || depth !== 0) throw new Error("Unclosed TOML value; configuration was not changed.");
  if (start < text.length) result.push(text.slice(start));
  return result;
}

export function keyPath(value) {
  const parts = value.match(/"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+/g) || [];
  return parts.map(part => part[0] === '"' ? JSON.parse(part) : part[0] === "'" ? part.slice(1, -1) : part);
}

export function configEntries(text) {
  let table = [];
  return statements(text).map(raw => {
    const header = raw.trim().match(/^\[([^\n]+)\]\s*(?:#.*)?$/);
    if (header) {
      table = keyPath(header[1]);
      return { raw, table, header: true };
    }
    const assignment = raw.match(/^\s*((?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=\s*([\s\S]*)/);
    return { raw, table, key: assignment ? keyPath(assignment[1]) : null, value: assignment?.[2] };
  });
}

const samePath = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function readSetting(text, table, key) {
  const entry = configEntries(text).find(item =>
    item.key && samePath([...item.table, ...item.key], [...table, key]));
  if (!entry) return undefined;
  const literal = entry.value.trim();
  const single = literal.match(/^'([^']*)'\s*(?:#.*)?$/s);
  if (single) return single[1];
  const basic = literal.match(/^("(?:\\.|[^"\\])*")\s*(?:#.*)?$/s);
  if (basic) return JSON.parse(basic[1]);
  if (/^(?:true|false)\s*(?:#.*)?$/.test(literal)) return literal.startsWith("true");
  // Runtime env values are strings. Never execute or guess other TOML values.
  return undefined;
}

/** Parse only a TOML string array; never evaluate or discard unknown values. */
export function stringArray(value) {
  if (typeof value !== "string" || value.length > 1024 * 1024) {
    throw new Error("String array exceeds its safe size bound.");
  }
  let at = 0;
  const fail = () => { throw new Error("Expected a valid TOML string array."); };
  const space = () => {
    while (at < value.length) {
      if (/\s/.test(value[at])) at += 1;
      else if (value[at] === "#") {
        const end = value.indexOf("\n", at);
        at = end < 0 ? value.length : end + 1;
      } else break;
    }
  };
  const quoted = () => {
    const quote = value[at++];
    if (quote !== "'" && quote !== '"') return fail();
    const triple = value.slice(at, at + 2) === quote.repeat(2);
    if (triple) {
      at += 2;
      if (value[at] === "\r" && value[at + 1] === "\n") at += 2;
      else if (value[at] === "\n") at += 1;
    }
    let result = "";
    while (at < value.length) {
      const char = value[at++];
      if (char === quote) {
        if (!triple) return result;
        if (value.slice(at, at + 2) === quote.repeat(2)) {
          at += 2;
          let extraQuotes = 0;
          while (value[at] === quote && extraQuotes < 2) {
            result += value[at++];
            extraQuotes += 1;
          }
          return result;
        }
      }
      if ((!triple && /[\r\n]/.test(char)) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(char)) {
        return fail();
      }
      if (quote !== '"' || char !== "\\") {
        result += char;
        continue;
      }
      const escaped = value[at++];
      if (triple && /\s/.test(escaped || "")) {
        let newline = escaped === "\r" || escaped === "\n";
        while (at < value.length && /\s/.test(value[at])) {
          newline ||= value[at] === "\r" || value[at] === "\n";
          at += 1;
        }
        if (!newline) return fail();
        continue;
      }
      const escapes = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
      if (Object.hasOwn(escapes, escaped)) result += escapes[escaped];
      else if (escaped === "u" || escaped === "U") {
        const width = escaped === "u" ? 4 : 8;
        const hex = value.slice(at, at + width);
        const code = Number.parseInt(hex, 16);
        if (hex.length !== width || !/^[\da-f]+$/i.test(hex) || code > 0x10ffff ||
            (code >= 0xd800 && code <= 0xdfff)) return fail();
        at += width;
        result += String.fromCodePoint(code);
      } else return fail();
    }
    return fail();
  };
  space();
  if (value[at++] !== "[") return fail();
  space();
  const result = [];
  while (value[at] !== "]") {
    if (result.length >= 4096) return fail();
    result.push(quoted());
    space();
    if (value[at] === "]") break;
    if (value[at++] !== ",") return fail();
    space();
  }
  at += 1;
  space();
  if (at !== value.length) return fail();
  return result;
}

export function editSettings(text, table, values, { onlyMissing = false } = {}) {
  const entries = configEntries(text);
  const remaining = new Map(Object.entries(values));
  let lastInTable = -1;
  const result = [];
  for (const item of entries) {
    if (samePath(item.table, table)) lastInTable = result.length + 1;
    const key = item.key?.length === 1 && samePath(item.table, table) ? item.key[0] : null;
    // Also recognize equivalent dotted assignments at the document root.
    const fullKey = item.key && [...item.table, ...item.key];
    const matched = key ?? [...remaining.keys()].find(name => samePath(fullKey, [...table, name]));
    if (matched && remaining.has(matched)) {
      const replacement = remaining.get(matched);
      remaining.delete(matched);
      result.push(onlyMissing ? item.raw : replacement == null ? "" : `${item.raw.slice(0, item.raw.indexOf("=")).trimEnd()} = ${replacement}\n`);
    } else {
      result.push(item.raw);
    }
  }
  const additions = [...remaining].filter(([, value]) => value != null)
    .map(([key, value]) => `${/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(key) ? key : JSON.stringify(key)} = ${value}\n`).join("");
  if (additions) {
    if (lastInTable >= 0) {
      result.splice(lastInTable, 0, `${result[lastInTable - 1]?.endsWith("\n") ? "" : "\n"}${additions}`);
    } else if (table.length === 0) {
      result.unshift(additions);
    } else {
      result.push(`\n[${table.map(part => /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part)).join(".")}]\n${additions}`);
    }
  }
  return result.join("");
}

export function removeTables(text, prefix) {
  return configEntries(text).filter(item =>
    !(prefix.every((part, index) => item.table[index] === part) && (item.header || item.key)))
    .map(item => item.raw).join("");
}
