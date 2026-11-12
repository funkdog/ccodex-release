import { selectedBridgePort } from "../port-selection.mjs";

export function providerBridgeBackend({ home, inherited, root, preflight, repair }) {
  const port = selectedBridgePort({ home, env: inherited });
  return {
    mode: "provider-bridge", bridgePort: port, enhancedUi: true,
    environment: () => ({ CODEX_COPILOT_BRIDGE_PORT: String(port) }),
    prepare: async ({ env, runtime }) => {
      await preflight("bridge/ensure.mjs", [], env, root);
      await preflight("bridge/desktop-profile.mjs", [], env, root);
      await repair(root, env, runtime.resources);
    },
    check: async () => {},
  };
}
