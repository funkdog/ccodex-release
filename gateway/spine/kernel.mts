import type { StoredThread } from "../contracts.mjs";
import type { SpineRuntimeOptions } from "./contracts.mjs";
import type { SpineRegistry } from "./registry.mjs";
import { validateSpineOptions } from "../spine-config.mjs";

/** Module imports, constructors and configuration all belong to an optional
 * boundary. Publish handlers only after initialization succeeds. */
export async function installSpineModules(registry: SpineRegistry, home: string, threads: () => StoredThread[], options: SpineRuntimeOptions = {}, changed: (kind: string) => void = () => {}) {
  const { radar: radarOptions, daily: dailyOptions, knowledge: knowledgeOptions, ...shared } = options;
  const configured = await registry.installModule("configuration", () => { validateSpineOptions(shared); return true; });
  if (!configured) return {};
  const trace = await registry.installModule("trace", async scope => {
    const { TraceStore } = await import("./trace.mjs");
    const service = new TraceStore(home);
    scope.register("diy/trace/record", "trace:write", p => service.record(p));
    return service;
  });
  const knowledge = await registry.installModule("knowledge", async () => {
    validateSpineOptions({ knowledge: knowledgeOptions });
    const { KnowledgeService } = await import("./knowledge.mjs");
    return new KnowledgeService(home, knowledgeOptions);
  });
  const radar = await registry.installModule("radar", async scope => {
    validateSpineOptions({ radar: radarOptions });
    if (!knowledge) throw new Error("Knowledge module is unavailable.");
    const { RadarService } = await import("./radar.mjs");
    const service = new RadarService(home, registry, knowledge, radarOptions, () => changed("radar"));
    scope.register("diy/radar/list", "radar:read", p => service.list(p));
    scope.register("diy/radar/feedback", "radar:write", p => service.feedback(p));
    scope.register("diy/radar/seen", "radar:write", p => service.seen(p));
    scope.register("diy/radar/save_card", "vault:write", p => service.saveCard(p));
    scope.register("diy/radar/refresh", "radar:write", p => { if (Object.keys(p).length) throw new Error("Refresh takes no parameters."); return service.refresh(); });
    return service;
  });
  const daily = await registry.installModule("daily", async scope => {
    validateSpineOptions({ daily: dailyOptions });
    if (!trace || !knowledge) throw new Error("Daily dependencies are unavailable.");
    const { DailyService } = await import("./daily.mjs");
    const service = new DailyService(home, registry, threads, trace, knowledge, dailyOptions, undefined, () => changed("daily"));
    scope.register("diy/daily/digest", "daily:read", p => service.digest(p));
    scope.register("diy/daily/save_card", "vault:write", p => service.saveCard(p));
    scope.register("diy/daily/refresh", "daily:read", p => { if (Object.keys(p).length) throw new Error("Refresh takes no parameters."); return service.refresh(); });
    return service;
  });
  return { trace, knowledge, radar, daily };
}
