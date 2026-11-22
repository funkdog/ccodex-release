function sourceManager(token) {
  const $ = selector => document.querySelector(selector);
  let state, selected = null, dirty = false, hiding;
  const status = text => { $("#status").textContent = text; };
  const clearKey = () => { clearTimeout(hiding); $("#key").value = ""; $("#key").type = "password"; $("#reveal").textContent = "查看密钥"; dirty = false; };
  const hideKey = () => { clearTimeout(hiding); $("#key").type = "password"; if (!dirty) $("#key").value = ""; $("#reveal").textContent = "查看密钥"; };
  const api = async (operation, params = {}) => {
    const response = await fetch(`/sources/api/${operation}`, { method: "POST", credentials: "omit",
      headers: { "content-type": "application/json", "x-mycodex-sources": token }, body: JSON.stringify(params) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `操作失败（HTTP ${response.status}）。`);
    return result;
  };
  const action = async run => {
    const buttons = [...document.querySelectorAll("button")]; buttons.forEach(button => { button.disabled = true; });
    try { await run(); } catch (error) { status(error.message); }
    finally { buttons.forEach(button => { button.disabled = false; }); render(); }
  };
  function render() {
    if (!state) return;
    const preferred = state.sources.find(source => source.id === state.preferred);
    $("#preferred").textContent = `新聊天优先：${preferred?.label ?? "未选择"}${state.preferredModel ? " · " + state.preferredModel : ""}`;
    $("#recent").textContent = state.lastRequest ? `最近请求：${state.lastRequest.source} · ${state.lastRequest.model}` : "尚无请求记录";
    $("#activation").hidden = !state.runtimePending;
    const list = $("#sources"); list.replaceChildren();
    for (const source of state.sources) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = source.label + (source.managedLogin ? "" : ` · ${source.maskedKey}`) + (source.id === state.preferred ? " · 优先" : "");
      button.className = source.id === selected ? "chosen" : ""; button.onclick = () => choose(source.id); list.append(button);
    }
    const source = state.sources.find(value => value.id === selected), builtin = source?.managedLogin;
    $("#credentials").hidden = !!builtin; $("#builtin").hidden = !builtin;
    $("#base").readOnly = !!source; $("#protocol").disabled = !!source;
    $("#save").hidden = !!builtin; $("#discover").hidden = !source || !!builtin;
    $("#reveal").hidden = !source || !!builtin;
    $("#prefer").disabled = !source || !builtin && !source.models.length;
    $("#model").hidden = !source || !!builtin;
  }
  function choose(id) {
    clearKey(); selected = id; const source = state.sources.find(value => value.id === id);
    $("#title").textContent = source?.label ?? "添加模型来源";
    $("#label").value = source?.label ?? ""; $("#base").value = source?.baseUrl ?? "https://";
    $("#protocol").value = source?.protocol ?? "responses"; $("#masked").textContent = source ? `已保存：${source.maskedKey}` : "密钥只保存在本机，不进入聊天记录。";
    const models = $("#model"); models.replaceChildren();
    for (const model of source?.models ?? []) { const option = document.createElement("option"); option.value = model.id; option.textContent = model.id; models.append(option); }
    if (source?.id === state.preferred && state.preferredModel) models.value = state.preferredModel;
    status(""); render();
  }
  $("#add").onclick = () => choose(null);
  $("#key").oninput = () => { dirty = true; };
  $("#reveal").onclick = () => action(async () => {
    if ($("#key").type === "text") { hideKey(); return; }
    if (!dirty) { const result = await api("reveal", { id: selected, revision: state.revision }); $("#key").value = result.apiKey; }
    $("#key").type = "text"; $("#reveal").textContent = "隐藏密钥";
    hiding = setTimeout(hideKey, 30000); status("密钥仅在当前页面显示，30 秒后隐藏。");
  });
  $("#form").onsubmit = event => { event.preventDefault(); void action(async () => {
    state = await api("save", { ...(selected ? { id: selected } : {}), label: $("#label").value,
      baseUrl: $("#base").value, protocol: $("#protocol").value, ...(dirty && $("#key").value ? { apiKey: $("#key").value } : {}), revision: state.revision });
    const id = state.savedId; choose(id); status("已保存。可读取模型目录，再设为优先。");
  }); };
  $("#discover").onclick = () => action(async () => { state = await api("discover", { id: selected, revision: state.revision }); choose(selected); status("模型目录已更新；模型可见不等于已验证所有模型的额度和能力。"); });
  $("#prefer").onclick = () => action(async () => { state = await api("prefer", { id: selected, model: $("#model").value || null, revision: state.revision }); status("已设为新聊天优先来源。已有聊天继续使用原来源。"); });
  $("#reload").onclick = () => action(async () => { state = await api("list"); choose(state.preferred); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) hideKey(); });
  window.addEventListener("pagehide", clearKey);
  void action(async () => { state = await api("list"); choose(state.preferred); });
}

export function modelSourcesPage(token, nonce) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MyCodex · 模型来源与密钥</title>
<style>
:root{font:15px/1.6 system-ui;color:#172125;background:#f4f6f5;color-scheme:light}*{box-sizing:border-box}body{margin:0}main{max-width:980px;margin:48px auto;padding:0 24px}h1{font-size:28px;letter-spacing:-.7px;margin:8px 0}.eyebrow{font-size:12px;letter-spacing:1.6px;color:#527065}p{color:#5d6e68;margin:6px 0}header{margin-bottom:28px}.layout{display:grid;grid-template-columns:230px 1fr;gap:20px}aside,article{background:white;border:1px solid #dfe6e2;border-radius:16px;padding:20px}aside button{display:block;width:100%;text-align:left;margin-bottom:8px}button{font:inherit;background:#f5f8f6;border:1px solid #d9e3dd;border-radius:9px;padding:9px 13px;color:inherit;cursor:pointer}button.chosen{background:#e8f4ec;border-color:#76a68a}button.primary{background:#176244;color:white;border-color:#176244}button:disabled{opacity:.45;cursor:default}h2{font-size:19px;margin:0 0 16px}label{display:block;margin:15px 0 5px}input,select{width:100%;font:inherit;border:1px solid #ccd8d1;background:white;border-radius:8px;padding:10px;color:inherit}input[readonly]{background:#f6f8f7}input[type=password],#key{font-family:ui-monospace,monospace}.row{display:flex;gap:8px;align-items:center}.row input{min-width:0}.row button{flex-shrink:0}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:22px}small{color:#667c71}#preferred{font-weight:600;color:#176244}#status{min-height:26px;margin-top:18px;color:#234e3d;overflow-wrap:anywhere}#recent{font-size:12px}[hidden]{display:none!important}.note{font-size:12px;margin-top:24px}@media(max-width:680px){main{margin:24px auto}.layout{grid-template-columns:1fr}#sources{display:flex;gap:8px;flex-wrap:wrap}aside button{width:auto}.row{flex-wrap:wrap}}
</style><main><header><div class="eyebrow">MYCODEX / MODEL SOURCES</div><h1>模型来源与密钥</h1><p id="preferred">正在读取本机配置…</p><p id="recent"></p><p id="activation" hidden>配置已保存。当前推理服务仍有任务；任务结束后正常重开 MyCodex，才会载入新来源和聊天内切换入口。</p></header>
<div class="layout"><aside><div id="sources"></div><button id="add">＋ 添加来源</button><button id="reload">刷新</button></aside>
<article><h2 id="title">模型来源</h2><form id="form" autocomplete="off"><div id="credentials"><label for="label">来源名称</label><input id="label" maxlength="80" placeholder="例如：工作 API、备用 API">
<label for="base">API 地址</label><input id="base" type="url" placeholder="https://服务地址/v1"><small>已有来源的地址固定；更换服务请添加新来源。</small>
<label for="protocol">接口协议</label><select id="protocol"><option value="responses">Responses API</option><option value="chat">Chat Completions</option></select>
<label for="key">API 密钥</label><div class="row"><input id="key" type="password" autocomplete="new-password" placeholder="填写新密钥；留空保留现有密钥"><button id="reveal" type="button">查看密钥</button></div><small id="masked"></small></div>
<p id="builtin" hidden>GitHub Copilot 使用已有 GitHub 登录。切回它不会修改你保存的 API 密钥。</p>
<label for="model">优先模型</label><select id="model" aria-label="优先模型"></select>
<div class="actions"><button id="save" type="submit">保存来源</button><button id="discover" type="button">读取模型</button><button id="prefer" type="button" class="primary">设为优先</button></div></form>
<p id="status" role="status" aria-live="polite"></p><p class="note">新聊天使用优先来源；已有聊天保留原来源。密钥保存在本机私有文件中，默认脱敏，查看时只在当前页面显示。</p></article></div></main>
<script nonce="${nonce}">(${sourceManager.toString()})(${JSON.stringify(token)});</script></html>`;
}
