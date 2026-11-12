import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../bridge/workiq/settings.mjs";
import { assertRegularPath } from "./paths.mjs";

export function seedDesktopPreferences(home) {
  const file = assertRegularPath(path.join(home, ".codex-global-state.json"));
  if (fs.existsSync(file)) return false;
  // Menu visibility is not authorization; users still select their mode.
  atomicWrite(file, JSON.stringify({
    "electron-persisted-atom-state": {
      "composer-permission-mode-visibility": true,
    },
  }) + "\n", { expectedContents: null });
  return true;
}
