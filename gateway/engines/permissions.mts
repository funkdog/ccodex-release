import "../../tools/typescript-runtime.mjs";
import type { Ask } from "../contracts.mjs";
export async function approveOnce(ask: Ask, description: string) {
  try {
    const result = await ask([{ id: "permission", header: "CLI permission", isOther: false, isSecret: false,
      question: description.slice(0, 16000), options: [
        { label: "Deny", description: "Do not grant this permission." },
        { label: "Allow once", description: "Approve only this CLI permission request." },
      ] }]);
    return result?.answers?.permission?.answers?.length === 1 && result.answers.permission.answers[0] === "Allow once";
  } catch { return false; }
}
