import { createHmac } from "node:crypto";

// Transport identities belong to the gateway, outside optional module loads.
export const nativeTraceToken = (token: string, generation: string) => createHmac("sha256", token).update(`mycodex/native-trace/${generation}`).digest("hex");
export const nativeHostToken = (token: string, generation: string) => createHmac("sha256", token).update(`mycodex/native-host/${generation}`).digest("hex");
