import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { buildDesktopDisplayConfigPatch } from "../bridge/desktop-display-config.mjs";

test("display patch enables bundled translations and models, not permissions or account entitlements", () => {
  const configs = {
    "107580212": { value: { use_hidden_models: true, billing: "unchanged" } },
    "72216192": { value: { enable_i18n: false, locale_source: "IDE" } },
    requirements: { value: { allowFullAccess: false, approval_policy: "on-request" } },
  };
  const client = { getDynamicConfig(name) { return configs[name]; }, $emt() {} };
  const context = vm.createContext({ __STATSIG__: { firstInstance: client } });
  const source = buildDesktopDisplayConfigPatch();
  assert.equal(vm.runInContext(source, context), "patched");
  assert.equal(client.getDynamicConfig("72216192").value.enable_i18n, true);
  assert.equal(client.getDynamicConfig("107580212").value.use_hidden_models, false);
  assert.equal(client.getDynamicConfig("requirements"), configs.requirements);
  assert.equal(configs["72216192"].value.enable_i18n, false);
  assert.equal(configs["107580212"].value.billing, "unchanged");
  assert.equal(vm.runInContext(source, context), "active");
});
