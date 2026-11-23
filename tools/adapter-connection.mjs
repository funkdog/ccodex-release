import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createEngines } from "../gateway/engines/index.mjs";

export async function connectedAdapter(config, factory = createEngines) {
  const { enabledModels, ...connection } = config;
  const engines = await factory([connection]);
  const engine = engines.get(config.id);
  if (!engine) throw new Error("所选 CLI 尚未连接。");
  return engine;
}

export async function connectionModels(config, { factory } = {}) {
  const engine = await connectedAdapter(config, factory);
  try {
    await engine.start?.({ token: randomUUID() });
    const models = await engine.models();
    if (!Array.isArray(models) || !models.length || models.length > 1000) throw new Error("CLI 没有返回有效的候选模型。");
    const seen = new Set();
    return models.filter(model => {
      if (typeof model.id !== "string" || !model.id || model.id.length > 256 || /\s|\0/.test(model.id)) throw new Error("CLI 返回了无效模型标识。");
      if (seen.has(model.id)) return false;
      seen.add(model.id); return true;
    });
  } finally { await engine.close?.(); }
}

/** Only one explicitly selected model is probed. Discovery grants no inference. */
export async function checkAdapterModel(config, modelId, { approved = false, factory, timeoutMs = 45000 } = {}) {
  if (!approved) throw new Error("需要用户明确同意发送这一条短请求；尚未调用模型。");
  if (typeof modelId !== "string" || !modelId || modelId.length > 256 || /\s|\0/.test(modelId)) throw new Error("请选择一个明确模型。");
  const engine = await connectedAdapter(config, factory);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-connection-check-"));
  fs.chmodSync(workspace, 0o700);
  const controller = new AbortController();
  const expected = `MYCODEX_CONNECTION_${randomUUID().replaceAll("-", "")}`;
  let text = "", tools = 0;
  let rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectTimeout(new Error("Connection check timed out.")); }, timeoutMs);
  try {
    await Promise.race([timeout, (async () => {
      await engine.start?.({ token: randomUUID() });
      if (controller.signal.aborted) return;
      const models = await engine.models();
      if (controller.signal.aborted) return;
      if (!models.some(model => model.id === modelId)) throw new Error("所选模型不在该 CLI 的候选目录中，请先在 CLI 中完成模型配置。");
      await engine.run({ model: modelId, cwd: workspace, prompt: `Reply with exactly ${expected}. Do not use tools, files, commands, search, or agents.`,
        verification: true, signal: controller.signal, getApprovalMode: () => "deny", ask: async () => null,
        onSession() {}, onText: chunk => { text += chunk; if (text.length > 16384) controller.abort(); },
        onTool() { tools++; controller.abort(); } });
    })()]);
    if (controller.signal.aborted || tools || text.trim() !== expected) throw new Error("短请求未通过校验；该模型没有被启用。");
    return { modelId, verifiedAt: new Date().toISOString(), inferenceVerified: true, toolsObserved: 0 };
  } catch (error) {
    // CLI and provider diagnostics can contain credentials. Return only a fixed
    // classification from this setup boundary, never the original error text.
    const detail = String(error?.message ?? "");
    const message = controller.signal.aborted ? "连接检测超时或出现工具调用；该模型没有被启用。"
      : /401|403|auth|credential|login|登录|认证/i.test(detail) ? "所选 CLI 的认证未通过。请先在该 CLI 中登录或配置自己的凭据。"
        : /候选目录/.test(detail) ? detail : "所选模型未完成短请求验证；该模型没有被启用。请检查 CLI、模型权限与服务连接。";
    throw new Error(message);
  } finally {
    clearTimeout(timer); controller.abort();
    try { await engine.close?.(); } catch {} finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  }
}
