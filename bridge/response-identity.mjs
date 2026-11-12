import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const PREFIX = "ccodex_item_";
const RESPONSE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCAL_ID = /^ccodex_item_v1_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(0|[1-9][0-9]*)$/;
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isIndex = value => Number.isSafeInteger(value) && value >= 0;

export function isMaterializedResponseItem(item) {
  if (!isObject(item) || typeof item.type !== "string" || item.type === "item_reference") return false;
  if (item.type === "message") {
    return typeof item.role === "string" && Array.isArray(item.content);
  }
  if (item.type === "reasoning") {
    return Array.isArray(item.summary) || typeof item.encrypted_content === "string";
  }
  if (typeof item.call_id === "string" && item.call_id) {
    return typeof item.arguments === "string" || isObject(item.arguments)
      || typeof item.input === "string" || Object.hasOwn(item, "output");
  }
  return isObject(item.action) || isObject(item.arguments);
}

export class ResponseIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResponseIdentityError";
  }
}

export class ResponseIdentityStore {
  constructor({ home, provider, account }) {
    const scope = createHash("sha256").update(JSON.stringify([provider, account])).digest("hex");
    this.directory = path.join(home, "response-identities", "v1", scope);
  }

  createSession() {
    return new ResponseIdentitySession(this);
  }

  async save(responseId, items) {
    if (!RESPONSE_KEY.test(responseId)) throw new ResponseIdentityError("Invalid bridge response identity key.");
    await fs.mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${responseId}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, responseId, items }));
      // Commit the reversible mapping before publishing an ID to the client.
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, target);
    } finally {
      await handle?.close();
      await fs.rm(temporary, { force: true });
    }
  }

  async restoreRequest(request, { allowMaterializedRecovery = false, onRecovery } = {}) {
    if (!Array.isArray(request.input)) return request;
    const records = new Map();
    const missing = new Set();
    let recoveredItems = 0;
    let changed = false;
    const input = [];
    for (const item of request.input) {
      if (!isObject(item) || typeof item.id !== "string" || !item.id.startsWith(PREFIX)) {
        input.push(item);
        continue;
      }
      const match = LOCAL_ID.exec(item.id);
      if (!match || !isIndex(Number(match[2]))) {
        throw new ResponseIdentityError("Unsupported or invalid bridge response item identity.");
      }
      const [, responseId, index] = match;
      let record = records.get(responseId);
      if (!record && !missing.has(responseId)) {
        let serialized;
        try {
          serialized = await fs.readFile(path.join(this.directory, `${responseId}.json`), "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw new ResponseIdentityError("Response item identity storage could not be read; it was not sent upstream.");
          }
          missing.add(responseId);
        }
        if (serialized !== undefined) {
          try {
            record = JSON.parse(serialized);
          } catch {
            throw new ResponseIdentityError("Stored response item identity is invalid; it was not sent upstream.");
          }
          records.set(responseId, record);
        }
      }
      if (missing.has(responseId)) {
        if (!allowMaterializedRecovery || !isMaterializedResponseItem(item)) {
          throw new ResponseIdentityError(
            "Response item identity is unavailable in this account/profile. Restore its response-identities data before resuming.",
          );
        }
        // The caller already supplied the complete item. Never import an opaque
        // identifier or cached content from another account to replay it.
        const materialized = { ...item };
        delete materialized.id;
        input.push(materialized);
        recoveredItems += 1;
        changed = true;
        continue;
      }
      const entry = record?.items?.[index];
      if (record?.version !== 1 || record.responseId !== responseId || !isObject(entry)
        || typeof entry.hasId !== "boolean"
        || (entry.hasId && entry.id !== null && typeof entry.id !== "string")) {
        throw new ResponseIdentityError("Stored response item identity is invalid; it was not sent upstream.");
      }
      const restored = { ...item };
      if (entry.hasId) restored.id = entry.id;
      else delete restored.id;
      if (item.type === "item_reference" && !restored.id) {
        throw new ResponseIdentityError("The provider did not supply an ID for this item reference.");
      }
      input.push(restored);
      changed = true;
    }
    if (recoveredItems) {
      onRecovery?.({
        kind: "materialized_history",
        items: recoveredItems,
        responseGroups: missing.size,
        importedForeignIdentities: false,
      });
    }
    return changed ? { ...request, input } : request;
  }
}

export class ResponseIdentitySession {
  constructor(store) {
    this.store = store;
    this.responseId = randomUUID();
    this.providerResponseId = null;
    this.slots = new Map();
    this.rawIndexes = new Map();
  }

  async normalize(event) {
    if (!isObject(event) || typeof event.type !== "string" || !event.type.startsWith("response.")) return event;
    let changed = false;
    let dirty = false;
    const rememberRaw = (id, index) => {
      if (typeof id !== "string") return;
      const previous = this.rawIndexes.get(id);
      this.rawIndexes.set(id, previous === undefined || previous === index ? index : null);
    };
    const resolveIndex = (index, id) => {
      if (isIndex(index)) return index;
      const known = this.rawIndexes.get(id);
      if (isIndex(known)) return known;
      throw new ResponseIdentityError(`Cannot correlate ${event.type}: missing or ambiguous output_index.`);
    };
    const slotFor = index => {
      let slot = this.slots.get(index);
      if (!slot) {
        slot = { localId: `${PREFIX}v1_${this.responseId}_${index}`, entry: { hasId: false }, type: null };
        this.slots.set(index, slot);
        dirty = true;
      }
      return slot;
    };
    const normalizeItem = (item, index) => {
      if (!isObject(item)) return item;
      const slot = slotFor(index);
      if (slot.type && item.type && slot.type !== item.type) {
        throw new ResponseIdentityError(`Provider changed the item type at output_index ${index}.`);
      }
      if (item.type) slot.type = item.type;
      if (Object.hasOwn(item, "id") && item.id !== null && typeof item.id !== "string") {
        throw new ResponseIdentityError("Provider returned a non-string response item ID.");
      }
      const entry = { hasId: Object.hasOwn(item, "id"), ...(Object.hasOwn(item, "id") ? { id: item.id } : {}) };
      if (entry.hasId !== slot.entry.hasId || entry.id !== slot.entry.id) {
        slot.entry = entry;
        dirty = true;
      }
      rememberRaw(item.id, index);
      changed = true;
      return { ...item, id: slot.localId };
    };
    let result = event;
    if (typeof event.response?.id === "string") {
      this.providerResponseId ??= event.response.id || `resp_ccodex_${this.responseId.replaceAll("-", "")}`;
      if (event.response.id !== this.providerResponseId) {
        result = { ...result, response: { ...event.response, id: this.providerResponseId } };
        changed = true;
      }
    }
    const isItemLifecycle = event.type === "response.output_item.added" || event.type === "response.output_item.done";
    const knownIndex = id => isIndex(event.output_index) || isIndex(this.rawIndexes.get(id));
    if (isObject(event.item) && (isItemLifecycle || knownIndex(event.item.id))) {
      const index = resolveIndex(event.output_index, event.item.id);
      result = { ...result, item: normalizeItem(event.item, index) };
    }
    if (Object.hasOwn(event, "item_id") && (knownIndex(event.item_id)
      || /\.(?:delta|done|added)$/.test(event.type))) {
      const index = resolveIndex(event.output_index, event.item_id);
      const slot = slotFor(index);
      rememberRaw(event.item_id, index);
      result = { ...result, item_id: slot.localId };
      changed = true;
    }
    if (Array.isArray(event.response?.output) && event.response.output.length) {
      const output = event.response.output.map((item, index) => normalizeItem(item, index));
      result = { ...result, response: { ...result.response, output } };
    }
    if (dirty) {
      await this.store.save(this.responseId,
        Object.fromEntries([...this.slots].map(([index, slot]) => [index, slot.entry])));
    }
    return changed ? result : event;
  }
}
