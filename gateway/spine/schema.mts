import { readJson } from "./io.mjs";
type Schema = { [key: string]: unknown };
/** Bounded validator for the actual configured report/card schemas. Unsupported
 * validation constructs fail closed instead of silently accepting future drift. */
export function validateSchema(value: unknown, schema: unknown, depth = 0): void {
  if (depth > 32 || !schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Invalid or unsupported JSON schema.");
  const s = schema as Schema;
  const known = ["$schema", "$id", "title", "description", "type", "properties", "additionalProperties", "required", "items", "minItems", "maxItems", "uniqueItems", "enum", "const", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "allOf", "oneOf", "anyOf", "if", "then", "else", "default"];
  if (Object.keys(s).some(key => !known.includes(key))) throw new Error("Unsupported schema keyword; revalidate the source contract.");
  const check = (condition: boolean, field: string) => { if (!condition) throw new Error(`Source schema validation failed: ${field}.`); };
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (s.const !== undefined) check(equal(value, s.const), "const");
  if (Array.isArray(s.enum)) check(s.enum.some(entry => equal(entry, value)), "enum");
  if (typeof s.type === "string") check(s.type === "object" ? !!value && typeof value === "object" && !Array.isArray(value) : s.type === "array" ? Array.isArray(value) : s.type === "integer" ? Number.isSafeInteger(value) : s.type === "null" ? value === null : typeof value === s.type, "type");
  if (typeof value === "string") {
    if (typeof s.minLength === "number") check(value.length >= s.minLength, "minLength");
    if (typeof s.maxLength === "number") check(value.length <= s.maxLength, "maxLength");
    if (typeof s.pattern === "string") check(new RegExp(s.pattern).test(value), "pattern");
    if (s.format === "uri") { try { new URL(value); } catch { check(false, "uri"); } }
  }
  if (typeof value === "number") { if (typeof s.minimum === "number") check(value >= s.minimum, "minimum"); if (typeof s.maximum === "number") check(value <= s.maximum, "maximum"); }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number") check(value.length >= s.minItems, "minItems");
    if (typeof s.maxItems === "number") check(value.length <= s.maxItems, "maxItems");
    if (s.uniqueItems) check(new Set(value.map(entry => JSON.stringify(entry))).size === value.length, "uniqueItems");
    if (s.items) for (const entry of value) validateSchema(entry, s.items, depth + 1);
  } else if (value && typeof value === "object") {
    const p = value as Record<string, unknown>, properties = (s.properties ?? {}) as Record<string, unknown>;
    if (Array.isArray(s.required)) check(s.required.every(key => typeof key === "string" && Object.hasOwn(p, key)), "required");
    for (const [key, entry] of Object.entries(p)) { if (properties[key]) validateSchema(entry, properties[key], depth + 1); else if (s.additionalProperties === false) check(false, "additionalProperties"); }
  }
  if (Array.isArray(s.allOf)) for (const child of s.allOf) validateSchema(value, child, depth + 1);
  for (const key of ["oneOf", "anyOf"]) if (Array.isArray(s[key])) {
    const count = s[key].filter(child => { try { validateSchema(value, child, depth + 1); return true; } catch { return false; } }).length;
    check(key === "oneOf" ? count === 1 : count > 0, key);
  }
  if (s.if) { let matches = true; try { validateSchema(value, s.if, depth + 1); } catch { matches = false; } const child = matches ? s.then : s.else; if (child) validateSchema(value, child, depth + 1); }
}
export function validateSource(value: unknown, schemaFile: string) { validateSchema(value, readJson(schemaFile)); }
