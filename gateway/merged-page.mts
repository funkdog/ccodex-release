import "../tools/typescript-runtime.mjs";
import type { AppParams, Page } from "./contracts.mjs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const prefix = "mycodex-page:1:";
const maximumCursorBytes = 512 * 1024;
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable((value as Record<string, unknown>)[key])])) : value;
const hash = (method: string, params: AppParams) => createHash("sha256").update(JSON.stringify(stable({ method,
  params: Object.fromEntries(Object.entries(params).filter(([key]) => !["cursor", "limit"].includes(key))) }))).digest("hex");
interface Side<T> { data: T[]; cursor: string | null; done: boolean }
interface State<T> { hash: string; native: Side<T>; gateway: Side<T> }
const empty = <T,>(): Side<T> => ({ data: [], cursor: null, done: false });

/** The cursor carries only the two small unconsumed page tails. It is signed
 * with the instance connection secret, so another stdio frontend can resume
 * it without a new cache service or a second persistence writer. */
export class MergedPages {
  secret: string;
  constructor(secret: string) {
    if (typeof secret !== "string" || secret.length < 16) throw new Error("Pagination requires an instance secret.");
    this.secret = secret;
  }
  owns(cursor: unknown) { return typeof cursor === "string" && cursor.startsWith(prefix); }
  encode<T>(state: State<T>) {
    const body = Buffer.from(JSON.stringify(state)).toString("base64url");
    if (body.length > maximumCursorBytes) throw new Error("Merged history cursor exceeded its bounded size.");
    return prefix + body + "." + createHmac("sha256", this.secret).update(body).digest("hex");
  }
  decode<T>(cursor: unknown, expectedHash: string): State<T> {
    if (typeof cursor !== "string" || cursor.length > maximumCursorBytes + 128) throw new Error("Invalid merged cursor.");
    const [body, signature, extra] = cursor.slice(prefix.length).split(".");
    const expected = createHmac("sha256", this.secret).update(body).digest();
    if (extra || !/^[a-f0-9]{64}$/.test(signature || "") || !timingSafeEqual(Buffer.from(signature, "hex"), expected)) throw new Error("Invalid merged cursor signature.");
    const state = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as State<T>;
    if (state.hash !== expectedHash) throw new Error("Merged cursor does not match these filters.");
    for (const side of [state.native, state.gateway]) if (!side || !Array.isArray(side.data) || typeof side.done !== "boolean") throw new Error("Invalid merged cursor state.");
    return state;
  }
  async page<T>({ method, params, native, gateway, preferNative, initialNative, initialGateway }: { method: string; params: AppParams; native: (params: AppParams) => Promise<Page<T>>; gateway: (params: AppParams) => Promise<Page<T>>; preferNative: (native: T, gateway: T) => boolean; initialNative?: Page<T>; initialGateway?: Page<T> }) {
    const limit = params.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid merged page limit.");
    const fingerprint = hash(method, params);
    const state = this.owns(params.cursor) ? this.decode<T>(params.cursor, fingerprint)
      : { hash: fingerprint, native: empty<T>(), gateway: empty<T>() };
    function accept(side: Side<T>, result: Page<T> | undefined) {
      if (!result || !Array.isArray(result.data) || result.data.length > 1000 ||
          (result.nextCursor != null && typeof result.nextCursor !== "string")) throw new Error("Backend returned an invalid page.");
      if (result.nextCursor != null && result.nextCursor === side.cursor) throw new Error("Backend pagination did not advance.");
      side.data = structuredClone(result.data);
      side.cursor = result.nextCursor ?? null;
      side.done = result.nextCursor == null;
    }
    if (!params.cursor) {
      accept(state.native, initialNative);
      accept(state.gateway, initialGateway);
    }
    let fetches = 0;
    async function fill(side: Side<T>, fetch: (params: AppParams) => Promise<Page<T>>) {
      while (!side.data.length && !side.done) {
        if (++fetches > 100) throw new Error("Backend pagination exceeded the bounded scan limit.");
        accept(side, await fetch({ ...params, cursor: side.cursor, limit: Math.min(limit, 100) }));
      }
    }
    const data = [];
    while (data.length < limit) {
      await Promise.all([fill(state.native, native), fill(state.gateway, gateway)]);
      const n = state.native.data[0], g = state.gateway.data[0];
      if (n === undefined && g === undefined) break;
      const side = g === undefined || (n !== undefined && preferNative(n, g)) ? state.native : state.gateway;
      data.push(side.data.shift()!);
    }
    const complete = [state.native, state.gateway].every(side => side.done && !side.data.length);
    return { data, nextCursor: complete ? null : this.encode(state) };
  }
}
