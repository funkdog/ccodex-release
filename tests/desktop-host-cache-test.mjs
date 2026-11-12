import assert from "node:assert/strict";
import test from "node:test";
import { mountCurrentNativeSessions } from "../bridge/desktop-native-composer.mjs";
import { currentHostContracts } from "../bridge/desktop-current-host-contract.mjs";

test("the current Rspack host waits for naturally initialized cached modules without executing factories", async () => {
  const contract = currentHostContracts.find(item => item.version === "26.1103.60933");
  assert.ok(contract, "The installed host needs its own verified adapter");
  const runtime = Object.assign(() => assert.fail("The adapter must not execute a vendor factory"), { c: {} });
  const modules = { [contract.managerModuleId]: () => assert.fail("The adapter must not initialize the manager") };
  const window = { electronBridge: { getSentryInitOptions: () => ({ appVersion: contract.version }) }, codexWindowType: "electron" };
  const services = new Proxy({}, { get: () => assert.fail("Pending modules cannot send RPCs") });
  const importModule = async url => url === contract.sharedModule ? { __webpack_require__: runtime } : { __webpack_modules__: modules };
  assert.equal(await mountCurrentNativeSessions({ window, services, importModule }), "pending");
  runtime.c[contract.busModuleId] = { exports: { [contract.busExport]: {
    dispatchMessage() {}, dispatchHostMessage() {}, subscribe() {} } } };
  assert.equal(await mountCurrentNativeSessions({ window, services, importModule }), "pending");
  runtime.c[contract.managerModuleId] = { exports: { [contract.managerExport]: function WrongManager() {} } };
  await assert.rejects(mountCurrentNativeSessions({ window, services, importModule }), /capabilities differ/);
  delete runtime.c[contract.managerModuleId];
  await assert.rejects(mountCurrentNativeSessions({ window, services,
    importModule: async url => url === contract.sharedModule ? {} : { __webpack_modules__: modules } }), /runtime/);
});
