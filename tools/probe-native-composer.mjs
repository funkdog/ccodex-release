// Owned browser fixture. No Desktop connection, user profile or model calls.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createNativeSessionController, installNativeSessionHooks } from "../bridge/desktop-native-session.mjs";
import { mountNativeEnginePicker, mountCurrentNativeSessions, buildNativeSessionsPatch, readNativeComposerRoute, selectHostDraftModel } from "../bridge/desktop-native-composer.mjs";
import { desktopPickerBinding } from "../bridge/desktop-model-controls.mjs";
import { currentHostContracts } from "../bridge/desktop-current-host-contract.mjs";

export async function probeNativeComposer(playwright, executablePath, version = currentHostContracts.at(-1).version) {
  const contract = currentHostContracts.find(item => item.version === version);
  if (!contract) throw new Error("The browser fixture requires a verified host version.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-native-ui-"));
  const { chromium } = await import(pathToFileURL(playwright).href);
  const browser = await chromium.launch({ executablePath, headless: true });
  const report = { recordedAt: new Date().toISOString(), hostVersion: version, environment: "owned-browser-native-contract-fixture", desktopTouched: false, checks: {} };
  const id = "00000000-0000-0000-0000-000000000001";
  const isShared = url => url.endsWith(contract.sharedModule.split("/").at(-1));
  const moduleSource = (shared, lazy = false) => {
    const manager = contract.managerExport ?? "VUn", bus = contract.busExport ?? "eLt";
    if (contract.moduleFormat !== "rspack-cache") return lazy
      ? shared ? `export let ${bus};globalThis.fixtureInitializeBus=()=>{${bus}=globalThis.fixtureBus;};`
        : `export let ${manager};globalThis.fixtureInitializeManager=()=>{${manager}=globalThis.fixtureManager;};`
      : `export const ${shared ? bus : manager}=globalThis.${shared ? "fixtureBus" : "fixtureManager"};`;
    const managerEntry = `${JSON.stringify(contract.managerModuleId)}:{exports:{${manager}:globalThis.fixtureManager}}`;
    const busEntry = `${JSON.stringify(contract.busModuleId)}:{exports:{${bus}:globalThis.fixtureBus}}`;
    if (shared) return `export const __webpack_require__=globalThis.fixtureCachedRuntime=Object.assign(()=>{throw Error('Cache observation cannot execute factories')},{c:{${lazy ? "" : `${managerEntry},${busEntry}`}}});${lazy ? `globalThis.fixtureInitializeBus=()=>{fixtureCachedRuntime.c[${JSON.stringify(contract.busModuleId)}]={exports:{${bus}:fixtureBus}};};` : ""}`;
    return `export const __webpack_modules__={${JSON.stringify(contract.managerModuleId)}(){throw Error('Do not initialize vendor modules')}};${lazy ? `globalThis.fixtureInitializeManager=()=>{fixtureCachedRuntime.c[${JSON.stringify(contract.managerModuleId)}]={exports:{${manager}:fixtureManager}};};` : ""}`;
  };
  try {
    const page = await browser.newPage(); const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("http://127.0.0.1/**", route => route.fulfill({ contentType: "text/html", body: '<main><button data-new>新建会话</button><section data-composer-surface-variant="default"><div data-composer-input><div role="textbox" contenteditable="true"></div><button data-composer-navigation-target="workspace-project">项目</button></div><footer><button data-codex-intelligence-trigger data-composer-navigation-target="reasoning">原生模型</button></footer></section></main>' }));
    await page.goto("http://127.0.0.1/");
    // Load the actual compiled ESM graph as well as serializing its functions.
    // Pure UI modules must retain ordinary-browser compatibility after TS emit.
    const moduleFiles = new Set(["bridge/desktop-native-session.mjs", "bridge/desktop-native-composer.mjs",
      "bridge/desktop-cli-selector.mjs", "bridge/desktop-model-controls.mjs", "bridge/desktop-native-context.mjs",
      "bridge/desktop-current-host-contract.mjs",
      "tools/typescript-runtime.mjs"]);
    await page.route("http://127.0.0.1/__compiled/**", route => {
      const relative = new URL(route.request().url()).pathname.slice("/__compiled/".length);
      if (!moduleFiles.has(relative)) return route.abort();
      return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(path.resolve(import.meta.dirname, "..", relative), "utf8") });
    });
    const esm = await page.evaluate(async () => {
      const session = await import("/__compiled/bridge/desktop-native-session.mjs");
      const composer = await import("/__compiled/bridge/desktop-native-composer.mjs");
      const selector = await import("/__compiled/bridge/desktop-cli-selector.mjs");
      return session.createNativeSessionController().selection() === null &&
        typeof composer.mountNativeEnginePicker === "function" && typeof selector.mountCliSelector === "function";
    });
    assert.equal(esm, true); report.checks.compiledEsmGraphLoadsInOrdinaryBrowser = true;
    await page.evaluate(`(async()=>{
      const currentHostContracts=${JSON.stringify(currentHostContracts)};
      const createNativeSessionController=${createNativeSessionController.toString()};
      const installNativeSessionHooks=${installNativeSessionHooks.toString()};
      const desktopPickerBinding=${desktopPickerBinding.toString()};
      const readNativeComposerRoute=${readNativeComposerRoute.toString()};
      const selectHostDraftModel=${selectHostDraftModel.toString()};
      const mountNativeEnginePicker=${mountNativeEnginePicker.toString()};
      const mountCurrentNativeSessions=${mountCurrentNativeSessions.toString()};
      const handlers=new Map();
      globalThis.fixtureBus={dispatchMessage(){},dispatchHostMessage(){},subscribe(type,handler){const set=handlers.get(type)||new Set();set.add(handler);handlers.set(type,set);return()=>set.delete(handler);}};
      globalThis.fixtureConfigWrites=[];
      globalThis.fixtureManager=class {hostId='local';requestClient={getThreadPrewarmPolicy:async()=>'legacy'};
        async setDefaultModelConfig(...args){fixtureConfigWrites.push(args);return {status:'ok'};}
        async startConversation(options){globalThis.fixtureStartOptions=options;return 'fixture-created';}};
      globalThis.codexWindowType='electron';
      globalThis.electronBridge={getSentryInitOptions:()=>({appVersion:${JSON.stringify(version)}})};
      globalThis.fixtureModuleUrls=[];
      const fixtureContract=${JSON.stringify(contract)};
      globalThis.fixtureModulesFor=(manager,bus)=>url=>{fixtureModuleUrls.push(url);
        if(fixtureContract.moduleFormat==='rspack-cache')return Promise.resolve(url===fixtureContract.sharedModule
          ?{__webpack_require__:Object.assign(()=>{throw Error('Do not execute factories')},{c:{[fixtureContract.managerModuleId]:{exports:{[fixtureContract.managerExport]:manager}},[fixtureContract.busModuleId]:{exports:{[fixtureContract.busExport]:bus}}}})}
          :{__webpack_modules__:{[fixtureContract.managerModuleId]:()=>{throw Error('Do not initialize manager')}}});
        return Promise.resolve(url===fixtureContract.sharedModule?{[fixtureContract.busExport??'eLt']:bus}:{[fixtureContract.managerExport??'VUn']:manager});};
      globalThis.fixtureModules=fixtureModulesFor(fixtureManager,fixtureBus);
      globalThis.fixtureModelCalls=0;
      globalThis.fixtureComposerMouseDowns=0;globalThis.fixtureComposerSubmits=0;
      // Model the shared composer's focus retention: a composed shadow event
      // is retargeted to a span and would cancel a native select's mouse-down.
      document.querySelector('main').addEventListener('mousedown',event=>{
        if(event.target.matches('input,select,button,[contenteditable]'))return;
        fixtureComposerMouseDowns++;event.preventDefault();document.querySelector('[contenteditable]').focus();
      });
      document.querySelector('main').addEventListener('keydown',event=>{
        if(event.key==='Enter'){fixtureComposerSubmits++;event.preventDefault();}
      });
      globalThis.fixtureSettings={model:'copilot/account-model',reasoningEffort:'medium',cliApprovalMode:'ask'};
      globalThis.fixtureModelCatalog=[
        {id:'copilot/account-model',label:'Copilot · 账户模型',canSwitchModel:true,efforts:['low','medium','high'],defaultEffort:'medium',approvalModes:['ask','read-only','auto','deny']},
        {id:'copilot/second',label:'Copilot · 第二模型',canSwitchModel:true,efforts:['low','high'],defaultEffort:'low',approvalModes:['ask','read-only','auto','deny']},
        {id:'copilot/limited',label:'Copilot · 受限推理模型',canSwitchModel:true,efforts:['medium','high'],defaultEffort:'medium',approvalModes:['ask','read-only','auto','deny']},
        {id:'copilot/rejected',label:'Copilot · 拒绝切换测试',canSwitchModel:true},
        {id:'copilot/auto',label:'Copilot · Auto',canSwitchModel:true,efforts:['none'],defaultEffort:'none',approvalModes:['ask','read-only','auto','deny']},
        {id:'antigravity/gemini',label:'Antigravity · Gemini',canSwitchModel:true,efforts:['low','high'],defaultEffort:'low'},
        {id:'codex-copilot/sol',label:'Codex + Copilot · Sol',nativeCopilot:true}];
      globalThis.fixtureServices={listModels:async()=>{fixtureModelCalls++;return fixtureModelCatalog;},
        listThreads:async()=>({data:[{id:'${id}',cwd:'/project',...fixtureSettings}],nextCursor:null}),
        setApprovalDefault:async({cliApprovalMode})=>({cliApprovalMode}),
        updateSettings:async({threadId,...settings})=>{
          if(settings.model?.endsWith('/rejected'))throw new Error('Synthetic model switch rejected');
          if(settings.model)settings.model=settings.model.replace(/^mycodex\\//,'');
          if(settings.model==='copilot/limited')settings.reasoningEffort='medium';
          if(settings.model==='copilot/auto')settings.reasoningEffort='none';
          Object.assign(fixtureSettings,settings);return {id:threadId,...fixtureSettings};}};
      // The native router changes its committed context, not document URL.
      const container=document.querySelector('[data-composer-input]');
      const hostFiber={stateNode:container,memoizedProps:{}};
      const control=document.querySelector('[data-composer-navigation-target="reasoning"]');
      const controlFiber={stateNode:control,memoizedProps:{}};
      globalThis.fixtureDraftSelections=[];
      const selectionFiber={child:hostFiber,memoizedProps:{model:'gpt-native',reasoningEffort:'medium',
        modelOptions:[{model:{model:'gpt-native',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}},
          ...fixtureModelCatalog.map(row=>({model:{model:'mycodex/'+row.id,defaultReasoningEffort:row.defaultEffort,
            supportedReasoningEfforts:(row.efforts??[]).map(reasoningEffort=>({reasoningEffort}))}}))],
        onSelectModel(model,reasoningEffort){fixtureDraftSelections.push({model,reasoningEffort});selectionFiber.memoizedProps={...selectionFiber.memoizedProps,model,reasoningEffort};return true;}}};
      globalThis.fixtureUpdateNativeModels=rows=>{selectionFiber.memoizedProps={...selectionFiber.memoizedProps,
        modelOptions:[{model:{model:'gpt-native',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}},
          ...rows.map(row=>({model:{model:'mycodex/'+row.id,defaultReasoningEffort:row.defaultEffort,supportedReasoningEfforts:(row.efforts??[]).map(reasoningEffort=>({reasoningEffort}))}}))]};};
      const provider={memoizedProps:{value:{location:{pathname:'/',key:'home'}}},child:selectionFiber};
      const routerRoot={tag:3,child:provider,stateNode:{}};routerRoot.stateNode.current=routerRoot;
      hostFiber.return=selectionFiber;hostFiber.sibling=controlFiber;controlFiber.return=selectionFiber;selectionFiber.return=provider;
      provider.return=routerRoot;container.__reactFiber$nativeFixture=hostFiber;control.__reactFiber$nativeFixture=controlFiber;
      globalThis.fixtureNavigate=(pathname,key=pathname)=>{if(pathname==='/'&&provider.memoizedProps.value.location.pathname!=='/')selectionFiber.memoizedProps={...selectionFiber.memoizedProps,model:'gpt-native',reasoningEffort:'medium'};provider.memoizedProps={value:{location:{pathname,key}}};};
      globalThis.mount=()=>mountCurrentNativeSessions({window:globalThis,services:fixtureServices,importModule:fixtureModules});
      globalThis.fixtureUi=await mount();
    })()`);
    assert.deepEqual(await page.evaluate(() => fixtureModuleUrls), [contract.sharedModule, contract.initialModule]);
    report.checks.selectedVersionUsesItsOwnNativeModules = true;
    const picker = page.getByRole("combobox", { name: "会话执行引擎" });
    await page.getByRole("option", { name: "Copilot CLI · 账户模型" }).waitFor({ state: "attached" });
    const nativeDraft = await page.evaluate(async () => {
      const result = await new fixtureManager().setDefaultModelConfig('mycodex/antigravity/gemini','high');
      let rejected = false;
      try { await new fixtureManager().setDefaultModelConfig('mycodex/antigravity/gemini','ultra'); } catch { rejected = true; }
      await new fixtureManager().startConversation({clientUserMessageId:'native-menu-draft',input:[{type:'text',text:'fixture'}]});
      return {result,rejected,model:fixtureStartOptions.collaborationMode.settings.model,
        effort:fixtureStartOptions.collaborationMode.settings.reasoning_effort,writes:fixtureConfigWrites.length};
    });
    assert.deepEqual(nativeDraft,{result:{status:'okOverridden'},rejected:true,model:'mycodex/antigravity/gemini',effort:'high',writes:0});
    report.checks.nativeAntigravityDraftEffortNeverWritesNativeConfig = true;
    await page.evaluate(async () => { await new fixtureManager().setDefaultModelConfig('gpt-native','medium'); });
    assert.equal(await page.evaluate(() => fixtureUi.controller.selection()),null);
    assert.equal(await page.evaluate(() => fixtureConfigWrites.length),1);
    report.checks.nativeDefaultSettingsStillUseOriginalWrite = true;
    // Use browser input instead of selectOption, which bypasses opening the
    // dropdown and missed the real Desktop interaction failure.
    await picker.click();
    assert.equal(await picker.evaluate(select => select.getRootNode().activeElement === select), true);
    // Headless macOS Chrome doesn't drive the platform menu with ArrowDown.
    // Close it, then use the focused select's browser type-ahead path.
    await page.keyboard.press("Escape"); await picker.press("c");
    await picker.press("Enter");
    report.pointerSelection = await page.evaluate(() => ({ selection: fixtureUi.controller.selection(),
      value: document.querySelector('[data-mycodex-native-engine]').shadowRoot.querySelector('select').value,
      mouseDowns: fixtureComposerMouseDowns, submits: fixtureComposerSubmits,
      focused: document.querySelector('[data-mycodex-native-engine]').shadowRoot.activeElement?.tagName }));
    await page.waitForFunction(() => fixtureUi.controller.selection() === "mycodex/copilot/account-model").catch(async error => {
      report.pointerFailure=await page.evaluate(()=>({selections:fixtureDraftSelections,status:document.querySelector('[data-mycodex-native-engine]').shadowRoot.querySelector('[role="status"]').textContent,
        options:[...document.querySelector('[data-mycodex-native-engine]').shadowRoot.querySelector('select').options].map(o=>({value:o.value,label:o.textContent,selected:o.selected}))}));throw error;
    });
    assert.equal(await page.evaluate(() => fixtureUi.controller.selection()), "mycodex/copilot/account-model");
    assert.deepEqual(await page.evaluate(()=>[fixtureComposerMouseDowns,fixtureComposerSubmits]),[0,0]);
    report.checks.pointerAndKeyboardSelectionKeepsComposerIdle = true;
    assert.equal(await page.locator("[data-mycodex-cli-selector]").count(), 0); report.checks.inlinePickerWithoutFloatingPanel = true;
    report.checks.nativeDraftSelection = true;
    await page.getByRole('combobox',{name:'CLI 推理强度'}).selectOption('high');
    await page.getByRole('combobox',{name:'CLI 审批策略'}).selectOption('auto');
    assert.equal(await page.evaluate(()=>fixtureUi.controller.preferences().reasoningEffort),'high');
    assert.equal(await page.evaluate(()=>fixtureUi.controller.preferences().cliApprovalMode),'auto');
    await page.waitForFunction(()=>document.querySelector('[data-codex-intelligence-trigger]').style.display==='none');
    assert.equal(await page.locator('[data-mycodex-native-engine]').evaluate(node=>node.parentElement.tagName),'FOOTER');
    report.checks.compactFooterControlsReplaceNativeCliControls = true;
    await page.evaluate(async () => {
      fixtureNavigate('/local/client-new-thread:11111111-1111-1111-1111-111111111111');
      document.querySelector('[contenteditable]').setAttribute('contenteditable','false');
      document.querySelector('[data-composer-navigation-target="workspace-project"]').hidden=true;
      await new fixtureManager().startConversation({clientUserMessageId:'first-send',input:[{type:'text',text:'hello'}]});
    });
    assert.equal(await page.evaluate(()=>fixtureStartOptions.collaborationMode.settings.model),'mycodex/copilot/account-model');
    assert.equal(await page.evaluate(()=>fixtureStartOptions.collaborationMode.settings.reasoning_effort),'high');
    assert.equal(await page.evaluate(()=>location.pathname),'/');
    report.checks.memoryRouterHandoffAndInertComposerKeepCliIntent = true;
    await page.evaluate(id => {fixtureNavigate(`/local/${id}`);document.querySelector('[contenteditable]').setAttribute('contenteditable','true');}, id);
    await page.waitForFunction(() => {
      const select = document.querySelector("[data-mycodex-native-engine]")?.shadowRoot?.querySelector("select");
      return select?.value === 'mycodex/copilot/account-model' && select.options.length === 5;
    });
    assert.equal(await picker.isEnabled(), true);
    assert.equal(await picker.inputValue(), "mycodex/copilot/account-model"); report.checks.persistedThreadSelection = true;
    await page.getByRole('combobox',{name:'CLI 推理强度'}).selectOption('low');
    await page.getByRole('combobox',{name:'CLI 审批策略'}).selectOption('read-only');
    assert.equal(await page.evaluate(()=>fixtureSettings.reasoningEffort),'low');
    assert.equal(await page.evaluate(()=>fixtureSettings.cliApprovalMode),'read-only');
    report.checks.existingThreadSettingsSaved = true;
    assert.deepEqual(await picker.locator('option').evaluateAll(options=>options.map(o=>o.value)),
      ['mycodex/copilot/account-model','mycodex/copilot/second','mycodex/copilot/limited','mycodex/copilot/rejected','mycodex/copilot/auto']);
    report.checks.existingModelMenuOnlyContainsSameEngine = true;
    await picker.selectOption('mycodex/copilot/second');
    await page.waitForFunction(()=>fixtureSettings.model==='copilot/second');
    assert.equal(await page.getByRole('combobox',{name:'CLI 推理强度'}).inputValue(),'low');
    assert.equal(await page.getByRole('combobox',{name:'CLI 审批策略'}).inputValue(),'read-only');
    report.checks.modelSwitchPreservesCompatibleEffortAndApproval = true;
    await picker.selectOption('mycodex/copilot/limited');
    await page.waitForFunction(()=>fixtureSettings.model==='copilot/limited');
    assert.equal(await page.getByRole('combobox',{name:'CLI 推理强度'}).inputValue(),'medium');
    assert.equal(await page.getByRole('combobox',{name:'CLI 审批策略'}).inputValue(),'read-only');
    await page.getByRole('status').filter({hasText:'原推理强度低不受支持'}).waitFor();
    report.checks.unsupportedEffortAdjustmentIsVisible = true;
    await picker.selectOption('mycodex/copilot/rejected');
    await page.getByRole('status').filter({hasText:'Synthetic model switch rejected'}).waitFor();
    assert.equal(await picker.inputValue(),'mycodex/copilot/limited');
    assert.equal(await page.getByRole('combobox',{name:'CLI 审批策略'}).inputValue(),'read-only');
    report.checks.failedModelSwitchKeepsCommittedSettings = true;
    await picker.selectOption('mycodex/copilot/auto');
    await page.waitForFunction(()=>fixtureSettings.model==='copilot/auto');
    assert.equal(await page.getByRole('combobox',{name:'CLI 推理强度'}).isDisabled(),true);
    assert.match(await page.getByRole('combobox',{name:'CLI 推理强度'}).textContent(),/CLI 默认/);
    await picker.selectOption('mycodex/copilot/limited');
    await page.waitForFunction(()=>fixtureSettings.model==='copilot/limited');
    assert.equal(await page.getByRole('combobox',{name:'CLI 审批策略'}).inputValue(),'read-only');
    report.checks.cliControlledEffortIsNotPresentedAsNoReasoning = true;
    await page.evaluate(() => { fixtureNavigate('/'); document.querySelector("[data-composer-input]").innerHTML = '<div contenteditable="true"></div><button data-composer-navigation-target="workspace-project">项目</button>'; });
    await page.waitForFunction(() => document.querySelector("[data-mycodex-native-engine]")?.shadowRoot.querySelector("select").value === "");
    assert.equal(await page.locator("[data-mycodex-native-engine]").count(), 1); report.checks.nativeNewDraftResetsAndRemounts = true;
    assert.equal(await page.evaluate(() => fixtureModelCalls), 1); report.checks.catalogReusedAcrossComposerRemounts = true;
    assert.equal(await page.locator('[data-codex-intelligence-trigger]').isVisible(),true);
    await page.evaluate(() => document.querySelector('[data-composer-navigation-target="workspace-project"]').remove());
    await page.waitForFunction(() => !document.querySelector("[data-mycodex-native-engine]")); report.checks.genericChatGptComposerExcluded = true;
    await page.evaluate(() => fixtureUi.dispose());
    assert.equal(await page.locator("[data-mycodex-native-engine]").count(), 0); report.checks.disposeRemovesPicker = true;
    await page.evaluate(async id => { fixtureNavigate(`/local/${id}`); globalThis.fixtureUi=await mount(); }, id);
    await page.waitForFunction(() => document.querySelector("[data-mycodex-native-engine]").shadowRoot.querySelector("select").value.startsWith("mycodex/"));
    report.checks.remountRestoresFromGatewayHistory = true;
    assert.equal(await page.getByRole('combobox',{name:'CLI 推理强度'}).inputValue(),'medium');
    assert.equal(await page.getByRole('combobox',{name:'CLI 审批策略'}).inputValue(),'read-only');
    report.checks.settingsRecoveredOnRemount = true;
    await page.screenshot({ path: path.join(root, "native-composer.png") });
    await page.evaluate(() => fixtureUi.dispose());
    // Exercise the exact serialized installer with only module URLs redirected
    // to fixture exports. Never load vendor code or a live Desktop renderer.
    await page.route("http://127.0.0.1/assets/**", route => route.fulfill({ contentType: "text/javascript", body: moduleSource(isShared(route.request().url())) }));
    let bindingCalls = 0, refreshCalls = 0, lazyCatalog = false;
    await page.exposeFunction("nativeFixtureBinding", async payload => {
      const request = JSON.parse(payload); bindingCalls++;
      assert.ok(["listModels", "refreshModels", "listThreads"].includes(request.method));
      if (request.method === "refreshModels") refreshCalls++;
      const result = request.method === "refreshModels" ? [{ id: "copilot/refreshed", label: "Copilot · 刷新后模型" }]
        : request.method === "listModels" ? lazyCatalog
          ? [{ id: "antigravity/gemini", label: "Antigravity · Gemini", efforts: ["low", "high"] }]
          : [{ id: "copilot/account-model", label: "Copilot · 账户模型" }]
        : { data: [{ id, model: "copilot/account-model", cwd: "/project" }], nextCursor: null };
      await page.evaluate(detail => globalThis.dispatchEvent(new CustomEvent("nativeFixtureResponse", { detail })), { id: request.id, result });
    });
    const patch = buildNativeSessionsPatch("nativeFixtureBinding", "nativeFixtureResponse").replaceAll("app://-/assets/", "http://127.0.0.1/assets/");
    assert.equal(await page.evaluate(patch), "active");
    await page.getByRole("option", { name: "Copilot CLI · 账户模型" }).waitFor({ state: "attached" });
    assert.equal(await page.evaluate(patch), "active");
    assert.equal(await page.locator("[data-mycodex-native-engine]").count(), 1);
    assert.equal(bindingCalls, 2); report.checks.generatedInstallerBindingRoundTrip = true; report.checks.generatedInstallerIdempotent = true;
    await page.evaluate(() => {
      fixtureNavigate('/');
      const workspace = document.createElement('button');
      workspace.dataset.composerNavigationTarget = 'workspace-project'; workspace.textContent = '项目';
      document.querySelector('[data-composer-input]').appendChild(workspace);
    });
    await page.getByRole('button', { name: '刷新 CLI 模型', exact: true }).click();
    await page.getByRole('option', { name: 'Copilot CLI · 刷新后模型', exact: true }).waitFor({ state: 'attached' });
    assert.equal(refreshCalls, 1);
    assert.equal(bindingCalls, 3, 'Refresh must traverse the binding once without extra rediscovery on remount');
    report.checks.generatedRefreshReplacesCatalogWithoutChangingPermissions = true;
    await page.evaluate(() => globalThis.__mycodexNativeSessions.dispose());
    assert.equal(await page.locator("[data-mycodex-native-engine]").count(), 0); report.checks.generatedInstallerDisposed = true;
    assert.equal(await page.locator('[data-codex-intelligence-trigger]').isVisible(),true);report.checks.nativeControlRestoredOnDispose = true;
    // Real ESM live bindings model the installed bundles' deferred class/bus
    // initialization. Re-importing a cached namespace must observe readiness.
    await page.route("http://127.0.0.1/lazy-assets/**", route => route.fulfill({ contentType: "text/javascript", body: moduleSource(isShared(route.request().url()), true) }));
    const lazyPatch = buildNativeSessionsPatch("nativeFixtureBinding", "nativeFixtureResponse").replaceAll("app://-/assets/", "http://127.0.0.1/lazy-assets/");
    const beforeLazyCalls = bindingCalls;
    await page.evaluate(() => { globalThis.fixtureBeforeLazyStart=fixtureManager.prototype.startConversation; });
    assert.equal(await page.evaluate(lazyPatch), "pending");
    await page.evaluate(() => fixtureInitializeBus());
    assert.equal(await page.evaluate(lazyPatch), "pending");
    assert.equal(bindingCalls, beforeLazyCalls);
    assert.equal(await page.locator("[data-mycodex-native-engine]").count(), 0);
    assert.equal(await page.evaluate(() => fixtureManager.prototype.startConversation===fixtureBeforeLazyStart), true);
    report.checks.lazyNativeExportsWaitWithoutMutationOrRpc = true;
    lazyCatalog = true;
    await page.evaluate(() => fixtureInitializeManager());
    assert.equal(await page.evaluate(lazyPatch), "active");
    await page.getByRole("option", { name: "Antigravity · Gemini", exact: true }).waitFor({ state: "attached" });
    assert.equal(await page.evaluate(lazyPatch), "active");
    assert.equal(bindingCalls, beforeLazyCalls + 2, "Initialization retries must not leak response listeners or duplicate discovery");
    report.checks.lazyNativeExportsBindWithoutPageReload = true;
    const lazySettings = await page.evaluate(async () => {
      const before=fixtureConfigWrites.length;
      const result=await new fixtureManager().setDefaultModelConfig('mycodex/antigravity/gemini','high');
      return {status:result.status,writes:fixtureConfigWrites.length-before};
    });
    assert.deepEqual(lazySettings, {status:"okOverridden",writes:0});
    report.checks.lazyNativeDraftEffortAcknowledgedWithoutConfigWrite = true;
    await page.evaluate(() => globalThis.__mycodexNativeSessions.dispose());
    lazyCatalog = false;
    assert.equal(await page.evaluate(async ({ manager, bus }) => {
      const previous = fixtureModules, original = fixtureManager.prototype.startConversation;
      fixtureModules = fixtureModulesFor(function initializer() {}, {});
      try { await mount(); return false; }
      catch (error) { return /capabilities differ/.test(error.message) && fixtureManager.prototype.startConversation === original; }
      finally { fixtureModules = previous; }
    }, { manager: contract.managerExport ?? "VUn", bus: contract.busExport ?? "eLt" }), true);
    report.checks.wrongExportMeaningsRejectedBeforeMutation = true;
    await page.evaluate(async () => {
      const models = [{ id: 'codex-copilot/gpt-fixture', label: 'codex-copilot · GPT fixture',
        nativeCopilot: true, inputModalities: ['text','image'], efforts: ['low','xhigh'], defaultEffort: 'low' },
        { id: 'codex-copilot/gemini-fixture', label: 'codex-copilot · Gemini fixture', nativeCopilot: true }];
      fixtureServices.listModels=async()=>models;fixtureUpdateNativeModels(models);
      fixtureNavigate('/');
      const workspace = document.createElement('button');
      workspace.dataset.composerNavigationTarget = 'workspace-project'; workspace.textContent = '项目';
      document.querySelector('[data-composer-input]').appendChild(workspace);
      globalThis.fixtureUi = await mount();
    });
    await page.getByRole("option", { name: "Codex + Copilot · Gemini fixture" }).waitFor({ state: "attached" });
    await picker.selectOption("mycodex/codex-copilot/gpt-fixture");
    await page.getByRole("combobox", { name: "CLI 推理强度" }).selectOption("xhigh");
    assert.equal(await page.getByRole("combobox", { name: "CLI 审批策略" }).isVisible(), false);
    await page.evaluate(async () => {
      await new fixtureManager().startConversation({ clientUserMessageId: 'native-image-draft',
        permissionSelection: { name: 'native-default' }, input: [{type:'text',text:'describe'},
          {type:'image',url:'data:image/png;base64,fixture'}] });
    });
    assert.equal(await page.evaluate(() => fixtureStartOptions.input[1].type), "image");
    assert.equal(await page.evaluate(() => fixtureStartOptions.collaborationMode.settings.reasoning_effort), "xhigh");
    assert.equal(await page.evaluate(() => fixtureStartOptions.permissionSelection.name), "native-default");
    report.checks.nativeProviderDraftKeepsImagesAndNativePermissions = true;
    await page.evaluate(id => {
      fixtureUi.controller.remember({ id, model: 'mycodex/codex-copilot/gpt-fixture', nativeCopilot: true });
      fixtureNavigate(`/local/${id}`);
    }, id);
    await page.waitForFunction(() => document.querySelector("[data-mycodex-native-engine]")?.hidden);
    assert.equal(await page.locator('[data-codex-intelligence-trigger]').isVisible(), true);
    report.checks.nativeProviderThreadKeepsNativeModelControls = true;
    await page.evaluate(() => fixtureUi.dispose());
    const changedDraft = await page.evaluate(async id => {
      fixtureNavigate('/');
      fixtureServices.listModels=()=>new Promise(resolve=>{globalThis.fixtureResolveModels=resolve;});
      fixtureUi=await mount();
      const before=fixtureConfigWrites.length;
      const pending=new fixtureManager().setDefaultModelConfig('mycodex/antigravity/gemini','high').then(()=>false,()=>true);
      fixtureNavigate('/local/'+id);
      fixtureResolveModels([{id:'antigravity/gemini',label:'Antigravity',efforts:['high']}]);
      const rejected=await pending;
      const result={rejected,selection:fixtureUi.controller.selection(),writes:fixtureConfigWrites.length-before};
      fixtureUi.dispose();return result;
    },id);
    assert.deepEqual(changedDraft,{rejected:true,selection:null,writes:0});
    report.checks.navigationDuringDraftSettingsCannotChangeAnotherChat = true;
    const unsupported = await page.evaluate(async () => {
      const original = electronBridge.getSentryInitOptions;
      electronBridge.getSentryInitOptions = () => ({ appVersion: 'unverified-version' });
      const calls = fixtureModuleUrls.length;
      try { return (await mount()) === null && fixtureModuleUrls.length === calls; }
      finally { electronBridge.getSentryInitOptions = original; }
    });
    assert.equal(unsupported, true); report.checks.unknownVersionDoesNotImportOrMount = true;
    assert.deepEqual(errors, []); report.checks.noBrowserErrors = true;
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; report.errorStack = error.stack; }
  finally { await browser.close(); }
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return { reportFile: path.join(root, "report.json"), ...report };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await probeNativeComposer(...process.argv.slice(2)); console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
