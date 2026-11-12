import { validatedFileSha256 } from "../bridge/file-validation-cache.mjs";

export function sha256File(file) {
  return validatedFileSha256(file);
}
