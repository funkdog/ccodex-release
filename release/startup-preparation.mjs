import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FileValidationCache, withFileValidation } from "../bridge/file-validation-cache.mjs";
import { desktopSnapshot } from "../bridge/desktop-runtime.mjs";
import { cliCoreSelection } from "../bridge/cli-update.mjs";
import { releaseMetadata, releaseRoot, releaseEnvironment } from "./environment.mjs";
import { boundedJson } from "./paths.mjs";
import { restorePinnedPrimaryRuntime, synchronizePrimaryOverrides } from "./primary-overrides.mjs";
import { prepareDesktopState } from "./desktop-preparation.mjs";

export async function prepareStartupValidation({ root = releaseRoot, home } = {}) {
  const metadata = releaseMetadata(root);
  const cacheFile = path.join(home, "startup-validation.json");
  if (fs.existsSync(cacheFile)) {
    const stat = fs.lstatSync(cacheFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Startup metadata cannot be redirected.");
    fs.unlinkSync(cacheFile);
  }
  const cache = new FileValidationCache({ root, home,
    generation: `${metadata.releaseId}:${metadata.fileManifestSha256}` });
  await withFileValidation(cache, async () => {
    const runtime = desktopSnapshot(root);
    cliCoreSelection({ root, home });
    restorePinnedPrimaryRuntime(root, home);
    synchronizePrimaryOverrides(root, home);
    await prepareDesktopState({ root, home, runtime,
      env: releaseEnvironment({ root, home, desktopHost: true }) });
  });
  return { installationPrepared: true, resourcesHashed: cache.hashes,
    generation: cache.generation };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const settings = boundedJson(path.join(releaseRoot, "release-install.json"));
    console.log(JSON.stringify(await prepareStartupValidation({ home: settings.profile })));
  } catch (error) {
    console.error(`Ccodex startup preparation: ${error.message}`);
    process.exitCode = 1;
  }
}
