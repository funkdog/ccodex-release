import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const sourceId = /^[a-f0-9]{12}$/;
const modelId = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;
const fail = message => { throw new Error(message); };
export const sourceModelId = (id, model) => `api-${id}--${model}`;

export function sourceBaseUrl(value, { allowHttp = false } = {}) {
  let url;
  try { url = new URL(value); } catch { fail("请输入有效的 API 地址。"); }
  if ((url.protocol !== "https:" && !(allowHttp && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash) fail("API 地址须为 HTTPS，且不能包含凭据、查询参数或片段。");
  return url.href.replace(/\/+$/, "");
}

/** Local private credentials. Public catalogues and ordinary reads contain no key.
 * Source identity binds an origin/protocol; a different endpoint is a new source.
 * Updating a key is an explicit rotation for the same service and identity. */
export class ModelSources {
  constructor(home, { fetchImpl = fetch, allowHttp = false } = {}) {
    this.directory = path.join(home, "model-sources");
    this.file = path.join(this.directory, "sources.json");
    this.fetchImpl = fetchImpl; this.allowHttp = allowHttp;
  }
  check(file, directory = false) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) ||
        !directory && (stat.size > 2 * 1024 * 1024 || stat.nlink !== 1) ||
        process.platform !== "win32" && (stat.uid !== process.getuid() || (stat.mode & 0o077)))
      fail("模型来源存储须为本机私有目录和文件，不能使用链接。");
  }
  read() {
    if (!fs.lstatSync(this.directory, { throwIfNoEntry: false })) return { schemaVersion: 1, revision: 0, preferred: "copilot", preferredModel: null, sources: [] };
    this.check(this.directory, true);
    if (!fs.lstatSync(this.file, { throwIfNoEntry: false })) return { schemaVersion: 1, revision: 0, preferred: "copilot", preferredModel: null, sources: [] };
    this.check(this.file);
    let value;
    try { value = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { fail("模型来源文件损坏，原文件已保留。"); }
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.sources) || value.sources.length > 32)
      fail("模型来源文件版本或结构无效，原文件已保留。");
    const ids = new Set();
    for (const source of value.sources) {
      if (!sourceId.test(source.id) || ids.has(source.id) || typeof source.label !== "string" || !source.label.trim() || source.label.length > 80 ||
          typeof source.apiKey !== "string" || source.apiKey.length < 8 || source.apiKey.length > 4096 || /\s/.test(source.apiKey) ||
          !["responses", "chat"].includes(source.protocol) || sourceBaseUrl(source.baseUrl, this) !== source.baseUrl ||
          !Array.isArray(source.models) || source.models.length > 1000 || source.models.some(model => !modelId.test(model.id)))
        fail("模型来源记录无效，原文件已保留。");
      for (const model of source.models) {
        if (model.input_modalities !== undefined && (!Array.isArray(model.input_modalities) || !model.input_modalities.includes("text") ||
            model.input_modalities.length > 2 || model.input_modalities.some(value => !["text", "image"].includes(value))) ||
            model.supports_parallel_tool_calls !== undefined && typeof model.supports_parallel_tool_calls !== "boolean")
          fail("模型能力记录无效，原文件已保留。");
      }
      ids.add(source.id);
    }
    if (value.preferred !== "copilot" && !ids.has(value.preferred)) fail("优先模型来源不存在。");
    return value;
  }
  commit(value, revision) {
    if (this.read().revision !== revision) fail("模型来源已在另一窗口更新，请刷新后重试。");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); this.check(this.directory, true);
    const pending = path.join(this.directory, `${randomUUID()}.pending`);
    const lock = path.join(this.directory, "writer.lock"), marker = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    let owner;
    try {
      try { owner = fs.openSync(lock, "wx", 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        this.check(lock);
        let previous; try { previous = JSON.parse(fs.readFileSync(lock, "utf8")); } catch { fail("来源写入锁无效，请保留文件并检查。"); }
        if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) fail("来源写入锁无效。");
        let alive = true; try { process.kill(previous.pid, 0); } catch (cause) { if (cause.code === "ESRCH") alive = false; }
        if (alive) fail("另一窗口正在保存模型来源，请稍后重试。");
        fs.unlinkSync(lock); owner = fs.openSync(lock, "wx", 0o600);
      }
      fs.writeFileSync(owner, marker);
      if (this.read().revision !== revision) fail("模型来源已在另一窗口更新，请刷新后重试。");
      const fd = fs.openSync(pending, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ ...value, revision: revision + 1 }, null, 2) + "\n"); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(pending, this.file);
    } finally {
      fs.rmSync(pending, { force: true });
      if (owner !== undefined) {
        const owned = fs.fstatSync(owner); fs.closeSync(owner);
        const current = fs.lstatSync(lock, { throwIfNoEntry: false });
        if (current?.ino === owned.ino && current.dev === owned.dev) fs.unlinkSync(lock);
      }
    }
  }
  snapshot() {
    const value = this.read();
    return { revision: value.revision, preferred: value.preferred, preferredModel: value.preferredModel,
      sources: [{ id: "copilot", label: "GitHub Copilot", managedLogin: true, maskedKey: "由 GitHub 登录管理", models: [] },
        ...value.sources.map(({ apiKey, ...source }) => ({ ...source, maskedKey: `••••••••${apiKey.slice(-4)}` }))] };
  }
  source(id) {
    const value = this.read().sources.find(source => source.id === id);
    if (!value) fail("该模型来源不存在；没有改用其他密钥。");
    return value;
  }
  save({ id, label, baseUrl, apiKey, protocol = "responses", revision }) {
    const value = this.read();
    if (value.revision !== revision) fail("模型来源已在另一窗口更新，请刷新后重试。");
    const existing = id ? value.sources.find(source => source.id === id) : null;
    if (id && !existing) fail("模型来源不存在。");
    const normalized = sourceBaseUrl(baseUrl, this);
    if (existing && (existing.baseUrl !== normalized || existing.protocol !== protocol)) fail("更换服务地址或协议请新增来源，以保留旧聊天的来源绑定。");
    const key = apiKey || existing?.apiKey;
    if (typeof key !== "string" || key.length < 8 || key.length > 4096 || /\s/.test(key)) fail("请输入有效的 API 密钥。");
    if (typeof label !== "string" || !label.trim() || label.length > 80 || /[\r\n\0]/.test(label) || !["responses", "chat"].includes(protocol)) fail("请输入来源名称和支持的协议。");
    if (!existing && value.sources.length >= 32) fail("最多保存 32 个模型来源。");
    const record = { ...(existing ?? { id: randomUUID().replaceAll("-", "").slice(0, 12), models: [], checkedAt: null }),
      label: label.trim(), baseUrl: normalized, apiKey: key, protocol };
    value.sources = existing ? value.sources.map(source => source.id === id ? record : source) : [...value.sources, record];
    this.commit(value, revision);
    return { ...this.snapshot(), savedId: record.id };
  }
  async discover(id, revision) {
    const value = this.read(), source = this.source(id);
    if (value.revision !== revision) fail("模型来源已在另一窗口更新，请刷新后重试。");
    let response;
    try { response = await this.fetchImpl(source.baseUrl + "/models", { headers: { authorization: `Bearer ${source.apiKey}` }, redirect: "error", signal: AbortSignal.timeout(20000) }); }
    catch { fail("读取模型目录失败，请检查服务地址和网络。"); }
    if (!response.ok) fail(`读取模型目录失败（HTTP ${response.status}），请检查该来源的密钥和权限。`);
    const raw = await response.text();
    if (raw.length > 1024 * 1024) fail("模型目录过大。");
    let body;
    try { body = JSON.parse(raw); } catch { fail("服务未返回有效的模型目录 JSON。"); }
    if (!Array.isArray(body.data) || body.data.length > 1000 || body.has_more) fail("模型目录格式不受支持或需要分页。");
    const models = [];
    for (const row of body.data) {
      if (typeof row?.id !== "string" || !modelId.test(row.id) || row.id.includes(source.apiKey)) fail("服务返回了无效的模型标识。");
      // Image-only endpoints cannot execute a native Codex conversation.
      if (/^(?:gpt-image|imagen|imagegeneration)/i.test(row.id)) continue;
      if (!models.some(model => model.id === row.id)) {
        const model = { id: row.id };
        // Only retain explicit service metadata. A model name or an API's
        // protocol is not evidence that screenshots can be processed.
        if (Array.isArray(row.input_modalities)) model.input_modalities = row.input_modalities.includes("image") ? ["text", "image"] : ["text"];
        else if (typeof row.capabilities?.supports?.vision === "boolean") model.input_modalities = row.capabilities.supports.vision ? ["text", "image"] : ["text"];
        const parallel = row.supports_parallel_tool_calls ?? row.capabilities?.supports?.parallel_tool_calls;
        if (typeof parallel === "boolean") model.supports_parallel_tool_calls = parallel;
        models.push(model);
      }
    }
    if (!models.length) fail("该来源未声明可用于聊天的模型。");
    value.sources = value.sources.map(item => item.id === id ? { ...source, models, checkedAt: new Date().toISOString() } : item);
    this.commit(value, revision); return this.snapshot();
  }
  prefer({ id, model = null, revision }) {
    const value = this.read();
    if (id !== "copilot" && !value.sources.some(source => source.id === id && source.models.some(row => row.id === model))) fail("请选择该来源目录中的模型。");
    value.preferred = id; value.preferredModel = id === "copilot" ? null : model;
    this.commit(value, revision); return this.snapshot();
  }
  preferredModel() {
    const value = this.read();
    return value.preferred === "copilot" ? null : sourceModelId(value.preferred, value.preferredModel);
  }
  models() {
    const value = this.read();
    return value.sources.flatMap(source => source.models.map(model => ({ id: sourceModelId(source.id, model.id),
      name: `${source.label} · ${model.id}`, vendor: "API", model_picker_enabled: true,
      is_chat_default: value.preferred === source.id && value.preferredModel === model.id,
      api_source: { id: source.id, label: source.label, model: model.id, baseUrl: source.baseUrl,
        priority: value.preferred === source.id,
        preferred: value.preferred === source.id && value.preferredModel === model.id },
      supported_endpoints: [source.protocol === "chat" ? "/chat/completions" : "/responses"],
      capabilities: { type: "chat", supports: { vision: model.input_modalities?.includes("image") === true,
        parallel_tool_calls: model.supports_parallel_tool_calls === true }, limits: { max_prompt_tokens: 128000, max_output_tokens: 8192 } },
    })));
  }
  merge(copilot) {
    const extra = this.models(), preferred = this.preferredModel();
    return [...extra, ...copilot.filter(model => !model.api_source).map(model => preferred ? { ...model, is_chat_default: false } : model)];
  }
}
