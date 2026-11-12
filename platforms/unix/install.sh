#!/usr/bin/env bash
set -euo pipefail

CONFIGURE_ONLY=0
SHOWCASE_PREVIEW=0
SHOWCASE_ONLY=0
if [[ "${1:-}" == "--configure-only" ]]; then
  CONFIGURE_ONLY=1
  shift
fi
if [[ "${1:-}" == "--showcase-preview" ]]; then
  SHOWCASE_PREVIEW=1
  shift
fi
if [[ "${1:-}" == "--showcase-only" ]]; then
  SHOWCASE_ONLY=1
  shift
fi

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TARGET_FILE="$SOURCE_ROOT/platform-target.json"
VERSION="$(tr -d '\r\n' < "$SOURCE_ROOT/VERSION" 2>/dev/null || printf unknown)"
DESKTOP_URL="https://chatgpt.com/download/"
LINUX_DESKTOP_DOC_URL="https://learn.chatgpt.com/docs/linux/linux-app"
CODEX_CLI_URL="https://developers.openai.com/codex/cli"
COPILOT_CLI_URL="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"

if [[ -t 1 ]]; then
  CYAN=$'\033[36m'; MAGENTA=$'\033[35m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[94m'; GRAY=$'\033[90m'; WHITE=$'\033[97m'
  BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  CYAN=""; MAGENTA=""; GREEN=""; YELLOW=""; BLUE=""; GRAY=""; WHITE=""
  BOLD=""; RESET=""
fi

banner() {
  printf '\n%s  ╭──────────────────────────────────────────────────────────────╮%s\n' "$CYAN" "$RESET"
  printf '%s  │                 Codex (Copilot) 安装向导                    │%s\n' "$CYAN" "$RESET"
  printf '%s  │                    release %-34s│%s\n' "$GRAY" "$VERSION" "$RESET"
  printf '%s  ╰──────────────────────────────────────────────────────────────╯%s\n\n' "$CYAN" "$RESET"
  printf '%s  安装顺序：Copilot 资格 → 官方 Desktop + 独立 Codex CLI → ccodex。%s\n' "$CYAN" "$RESET"
}

status_row() {
  local name="$1" state="$2" detail="$3" symbol color
  case "$state" in
    FOUND|VERIFIED) symbol="✓"; color="$GREEN" ;;
    BUNDLED) symbol="◆"; color="$GREEN" ;;
    OPTIONAL) symbol="○"; color="$YELLOW" ;;
    N/A) symbol="–"; color="$GRAY" ;;
    *) symbol="!"; color="$YELLOW" ;;
  esac
  printf '%s  │ %s %-22s %-9s%s %s\n' "$color" "$symbol" "$name" "$state" "$RESET" "$detail"
}

copilot_diagnostics() {
  printf '\n%s  ┌─ 1/2 GitHub Copilot 资格与 SDK%s\n' "$CYAN" "$RESET"
  if [[ "$COPILOT_VERIFIED" == "1" ]]; then
    status_row "Copilot 资格" "VERIFIED" "实时可用模型已验证；${COPILOT_SUMMARY:-当前账户}"
  else
    status_row "Copilot 资格" "MISSING" "须先验证有权使用的 GitHub OAuth"
  fi
  if [[ -n "$COPILOT_SDK" ]]; then
    status_row "GitHub Copilot CLI" "FOUND" "$COPILOT_SDK"
  elif [[ "$COPILOT_VERIFIED" == "1" ]]; then
    status_row "GitHub Copilot CLI" "OPTIONAL" "GitHub 凭据已验证；SDK 元数据增强可稍后安装"
  else
    status_row "GitHub Copilot CLI" "MISSING" "可安装 SDK，或完成 GitHub OAuth 验证"
  fi
  printf '%s  └──────────────────────────────────────────────────────────────%s\n' "$CYAN" "$RESET"
}

desktop_cli_diagnostics() {
  printf '\n%s  ┌─ 2/2 官方 ChatGPT/Codex Desktop 与独立 stock Codex CLI%s\n' "$CYAN" "$RESET"
  if [[ -n "$DESKTOP_APP" ]]; then
    status_row "ChatGPT Desktop" "FOUND" "$DESKTOP_APP"
  else
    status_row "ChatGPT Desktop" "MISSING" "$([[ "$OS" == "linux" ]] && printf 'Linux preview；须安装官方包' || printf 'macOS；须安装官方应用')"
  fi
  if [[ "$OS" == "linux" ]] && ! linux_desktop_supported; then
    status_row "Linux preview" "UNSUPPORTED" "当前发行版不在官方清单；已安装的 app 也需自行验证"
  fi
  if [[ -n "$STOCK_CODEX" ]]; then
    status_row "Codex CLI" "FOUND" "$STOCK_CODEX ($STOCK_CODEX_VERSION)"
  else
    status_row "Codex CLI" "MISSING" "必须有独立 stock codex；包内 patched core 不能替代"
  fi
  if [[ -x "$SOURCE_ROOT/bin/codex-copilot-core" ]]; then
    status_row "ccodex patched core" "BUNDLED" "$SOURCE_ROOT/bin/codex-copilot-core"
  else
    status_row "ccodex patched core" "MISSING" "重新下载匹配平台的完整发行包"
  fi
  printf '%s  └──────────────────────────────────────────────────────────────%s\n' "$CYAN" "$RESET"
}

render_shared_ui() {
  local mode="$1" stage="${2:-}" detail="${3:-}"
  "$SOURCE_NODE" - "$SOURCE_ROOT/assets/installer-showcase.json" "$mode" "$OS" "$VERSION" \
    "${DESKTOP_APP:-}" "${SHOWCASE_B64:-}" "${CODEX_COPILOT_SHOWCASE_URL:-}" \
    "$SHOWCASE_PREVIEW" "$stage" "$detail" <<'NODE'
const fs = require("node:fs");
const https = require("node:https");
const { TextDecoder } = require("node:util");

const [file, mode, platform, version, desktop, encoded, configuredUrl, preview, stageIndex, stageDetail] =
  process.argv.slice(2);
const maxBytes = 65536;
const palette = {
  cyan: "\u001b[36m",
  magenta: "\u001b[35m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[94m",
  gray: "\u001b[90m",
  white: "\u001b[97m",
};
const reset = process.stdout.isTTY ? "\u001b[0m" : "";
const tint = (name) => process.stdout.isTTY ? palette[name] : "";
const safe = (value, limit, where) => {
  if (typeof value !== "string" || !value.length || value.length > limit ||
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`${where} must be a single safe line of at most ${limit} characters.`);
  }
};
const fields = (value, required, optional, where) => {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${where} must be an object.`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${where} is missing ${key}.`);
  for (const key of Object.keys(value)) {
    if (![...required, ...optional].includes(key)) throw new Error(`${where} has an unknown field: ${key}.`);
  }
};
const list = (value, minimum, maximum, where) => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${where} must contain ${minimum}-${maximum} entries.`);
  }
};
const options = (value, where) => {
  if (Object.hasOwn(value, "color") && !Object.hasOwn(palette, value.color)) {
    throw new Error(`${where} has an unsupported color.`);
  }
  if (Object.hasOwn(value, "platforms")) {
    list(value.platforms, 1, 3, `${where}.platforms`);
    if (value.platforms.some((name) => !["windows", "macos", "linux"].includes(name)) ||
        new Set(value.platforms).size !== value.platforms.length) {
      throw new Error(`${where} has unsupported or duplicate platforms.`);
    }
  }
  if (Object.hasOwn(value, "requiresDesktop") && typeof value.requiresDesktop !== "boolean") {
    throw new Error(`${where}.requiresDesktop must be boolean.`);
  }
};
function validate(data) {
  fields(data, ["schemaVersion", "title", "tagline", "verification", "dataPolicy",
    "installStages", "sections", "quickStart", "footer"], [], "showcase");
  if (data.schemaVersion !== 1) throw new Error("Unsupported showcase schemaVersion.");
  for (const name of ["title", "tagline", "verification", "dataPolicy", "footer"]) {
    safe(data[name], 260, `showcase.${name}`);
  }
  list(data.installStages, 6, 6, "showcase.installStages");
  for (const stage of data.installStages) {
    fields(stage, ["title", "detail"], [], "showcase.installStages[]");
    safe(stage.title, 60, "showcase.installStages[].title");
    safe(stage.detail, 260, "showcase.installStages[].detail");
  }
  list(data.sections, 1, 8, "showcase.sections");
  for (const section of data.sections) {
    fields(section, ["title", "color", "items"], ["platforms", "requiresDesktop"], "showcase.sections[]");
    safe(section.title, 80, "showcase.sections[].title");
    options(section, "showcase.sections[]");
    list(section.items, 1, 16, "showcase.sections[].items");
    for (const item of section.items) {
      fields(item, ["label", "text"], ["color", "platforms", "requiresDesktop"], "showcase.items[]");
      safe(item.label, 48, "showcase.items[].label");
      safe(item.text, 260, "showcase.items[].text");
      options(item, "showcase.items[]");
    }
  }
  list(data.quickStart, 1, 10, "showcase.quickStart");
  for (const entry of data.quickStart) {
    fields(entry, ["command", "color", "detail"], ["platforms", "requiresDesktop"], "showcase.quickStart[]");
    safe(entry.command, 80, "showcase.quickStart[].command");
    safe(entry.detail, 260, "showcase.quickStart[].detail");
    options(entry, "showcase.quickStart[]");
  }
  return data;
}
function parse(bytes) {
  if (bytes.length > maxBytes) throw new Error("Showcase JSON exceeds 64 KiB.");
  return validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}
async function fetchRemote(address) {
  const url = new URL(address);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new Error("Use an absolute HTTPS URL without credentials or fragment.");
  }
  const bytes = await new Promise((resolve, reject) => {
    let deadline;
    const finish = (callback, value) => {
      clearTimeout(deadline);
      callback(value);
    };
    const fail = (error) => finish(reject, error);
    const request = https.get(url, { timeout: 5000, headers: { accept: "application/json" } }, (response) => {
      if (response.statusCode !== 200) {
        fail(new Error(`HTTP ${response.statusCode} (redirects are disabled).`));
        request.destroy();
        return;
      }
      if (Number(response.headers["content-length"]) > maxBytes) {
        fail(new Error("Showcase JSON exceeds 64 KiB."));
        request.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error("Showcase JSON exceeds 64 KiB."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(resolve, Buffer.concat(chunks, size)));
      response.on("error", fail);
    });
    deadline = setTimeout(() => request.destroy(new Error("Showcase request timed out.")), 5000);
    request.on("timeout", () => request.destroy(new Error("Showcase request timed out.")));
    request.on("error", fail);
  });
  return { data: parse(bytes), source: `受信 HTTPS 端点：${url.hostname}` };
}
const visible = (entry) => (!entry.platforms || entry.platforms.includes(platform)) &&
  (!entry.requiresDesktop || Boolean(desktop));
const line = (text) => process.stdout.write(`${text}\n`);
function render(bundle) {
  const { data, source } = bundle;
  if (mode === "roadmap") {
    line(`\n${tint("cyan")}  ┌─ 安装路线 · 每步输出资源或路径，失败请查看当前步骤${reset}`);
    data.installStages.forEach((stage, index) => {
      line(`${tint("cyan")}  │ ${String(index + 1).padStart(2, "0")} ◆ ${stage.title}${reset}  ${stage.detail}`);
    });
    line(`${tint("cyan")}  └─ 功能展示不会代替 doctor 与实际请求验证${reset}`);
    line(`${tint("gray")}  展示内容：${source}；设置 CODEX_COPILOT_SHOWCASE_URL 可在安装时读取受信 HTTPS 更新${reset}`);
    if (!configuredUrl) {
      line(`${tint("yellow")}  未配置共享端点：不会联网拉取展示内容；请由发布者指定可信的 HTTPS JSON 地址。${reset}`);
    }
    return;
  }
  if (mode === "step") {
    const index = Number(stageIndex);
    if (!Number.isInteger(index) || index < 1 || index > data.installStages.length) {
      throw new Error("Invalid installation stage.");
    }
    const stage = data.installStages[index - 1];
    line(`\n${tint("cyan")}  ◆ [${String(index).padStart(2, "0")}/${data.installStages.length}] ${stage.title}${reset}  ${stage.detail}`);
    if (stageDetail) line(`${tint("gray")}  │ ${stageDetail}${reset}`);
    return;
  }
  if (mode !== "showcase") throw new Error("Unknown showcase mode.");
  const state = preview === "1" ? "PREVIEW ONLY" : "INSTALL FINISHED";
  line(`\n${tint("gray")}  ╭─ ${tint("magenta")}${data.title}${reset}  ${tint("cyan")}v${version}${reset}  ${tint("green")}${state}${reset}`);
  line(`${tint("gray")}  │  ${data.tagline}${reset}`);
  line(`${tint("yellow")}  │  ${data.verification}${reset}`);
  line(`${tint("gray")}  ╰─ ${data.dataPolicy}${reset}`);
  let index = 0;
  for (const section of data.sections) {
    if (!visible(section)) continue;
    const items = section.items.filter(visible);
    if (!items.length) continue;
    index++;
    line(`\n${tint("gray")}  ┌─ ${tint(section.color)}${String(index).padStart(2, "0")}  ${section.title}${reset}`);
    for (const item of items) {
      line(`${tint("gray")}  │  ${tint(item.color || section.color)}${item.label}${reset}  ${item.text}`);
    }
    line(`${tint("gray")}  └─${reset}`);
  }
  line(`\n${tint("gray")}  ┌─ QUICK START${reset}`);
  for (const entry of data.quickStart.filter(visible)) {
    line(`${tint("gray")}  │  ${tint(entry.color)}${entry.command.padEnd(29)}${reset}${entry.detail}`);
  }
  line(`${tint("gray")}  ╰─ ${data.footer}${reset}`);
  line(`${tint("gray")}  展示来源：${source}${reset}\n`);
}
(async () => {
  if (mode === "load") {
    let bundle = { data: parse(fs.readFileSync(file)), source: "包内快照" };
    if (configuredUrl) {
      try {
        bundle = await fetchRemote(configuredUrl);
      } catch (error) {
        process.stderr.write(`共享展示不可用（${error.name}）；已回退包内快照。请检查 CODEX_COPILOT_SHOWCASE_URL、证书与 schema。\n`);
      }
    }
    process.stdout.write(Buffer.from(JSON.stringify(bundle)).toString("base64"));
    return;
  }
  const bundle = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  validate(bundle.data);
  render(bundle);
})().catch((error) => {
  process.stderr.write(`Showcase data error: ${error.message}\n`);
  process.exitCode = 1;
});
NODE
}

install_step() {
  CURRENT_INSTALL_STEP="$1"
  render_shared_ui step "$1" "${2:-}"
}

install_failure() {
  local status="$?"
  printf '%s  ! 安装在阶段 %s 失败（脚本行 %s，退出码 %s）；检查上方路径/错误，再运行 codex-copilot doctor 或重新安装。%s\n' \
    "$YELLOW" "${CURRENT_INSTALL_STEP:-01}" "${BASH_LINENO[0]}" "$status" "$RESET" >&2
  return "$status"
}
trap 'install_failure' ERR

animate_showcase() {
  [[ -t 0 && -t 1 ]] || return 0
  [[ "${CODEX_COPILOT_NO_ANIMATION:-0}" != "1" ]] || return 0
  [[ "${CODEX_COPILOT_NONINTERACTIVE:-0}" != "1" ]] || return 0

  local gauges labels colors pulses i pulse
  gauges=('■□□□□' '■■□□□' '■■■□□' '■■■■□' '■■■■■')
  labels=('INPUT + MOUSE' 'MODEL CATALOG' 'DESKTOP LINK' 'UPDATE GUARD' \
    "$([[ "$SHOWCASE_PREVIEW" == "1" ]] && printf 'PREVIEW ONLY' || printf 'INSTALL FINISHED')")
  colors=("$CYAN" "$BLUE" "$MAGENTA" "$YELLOW" "$GREEN")
  pulses=("$CYAN" "$MAGENTA" "$WHITE")
  printf '\n'
  for i in "${!gauges[@]}"; do
    printf '\r\033[2K  %s◇  %s%s  %-18s%s' "$GRAY" "${colors[$i]}" "${gauges[$i]}" "${labels[$i]}" "$RESET"
    sleep 0.22
  done
  for pulse in "${pulses[@]}"; do
    printf '\r\033[2K  %s✦  ■■■■■  %s%s' "$pulse" \
      "$([[ "$SHOWCASE_PREVIEW" == "1" ]] && printf 'PREVIEW ONLY' || printf 'INSTALL FINISHED')" "$RESET"
    sleep 0.14
  done
  printf '\n'
}

showcase() {
  animate_showcase
  render_shared_ui showcase
}

resolve_desktop_app() {
  local candidate="${1:-}" app
  [[ -n "$candidate" ]] || return 1
  if [[ "$OS" == "linux" ]]; then
    [[ -d "$candidate" ]] && candidate="$candidate/chatgpt"
    if [[ -f "$candidate" && -x "$candidate" && "$(basename "$candidate")" == "chatgpt" ]]; then
      (cd "$(dirname "$candidate")" && printf '%s/%s\n' "$PWD" "$(basename "$candidate")")
      return 0
    fi
    return 1
  fi
  if [[ -d "$candidate" && "$candidate" == *.app ]]; then
    [[ -d "$candidate/Contents/MacOS" ]] || return 1
    (cd "$(dirname "$candidate")" && printf '%s/%s\n' "$PWD" "$(basename "$candidate")")
    return 0
  fi
  if [[ -f "$candidate" && "$candidate" == *.app/* ]]; then
    app="${candidate%%.app/*}.app"
    [[ -d "$app" ]] && printf '%s\n' "$app" && return 0
  fi
  if [[ -d "$candidate" ]]; then
    for app in "$candidate/Codex.app" "$candidate/ChatGPT.app"; do
      [[ -d "$app" ]] && printf '%s\n' "$app" && return 0
    done
  fi
  return 1
}

resolve_copilot_sdk() {
  local candidate="${1:-}" root sdk
  [[ -e "$candidate" ]] || return 1
  if [[ -f "$candidate" && "$(basename "$candidate")" == "index.js" && "$(basename "$(dirname "$candidate")")" == "copilot-sdk" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  if [[ -f "$candidate" && "$(basename "$candidate")" == *copilot* ]] && command -v npm >/dev/null 2>&1; then
    root="$(npm root -g 2>/dev/null || true)"
    if [[ -n "$root" && "$root" != "$(dirname "$candidate")" ]]; then
      sdk="$(find "$root" -type f -path '*/copilot-sdk/index.js' -print 2>/dev/null | head -n 1 || true)"
      [[ -n "$sdk" ]] && printf '%s\n' "$sdk" && return 0
    fi
  fi
  root="$candidate"
  [[ -d "$root" ]] || root="$(dirname "$root")"
  sdk="$(find "$root" -type f -path '*/copilot-sdk/index.js' -print 2>/dev/null | head -n 1 || true)"
  [[ -n "$sdk" ]] && printf '%s\n' "$sdk" && return 0
  return 1
}

find_desktop_app() {
  local candidate saved
  saved="$PROFILE_HOME/desktop-app-path.txt"
  if [[ "$OS" == "linux" ]]; then
    for candidate in "${CODEX_COPILOT_DESKTOP_APP:-}" \
      "$([[ -f "$saved" ]] && cat "$saved" || true)" \
      "$(command -v chatgpt || true)" "/usr/bin/chatgpt" "/usr/local/bin/chatgpt"; do
      resolve_desktop_app "$candidate" && return 0
    done
    return 1
  fi
  for candidate in "${CODEX_COPILOT_DESKTOP_APP:-}" "$([[ -f "$saved" ]] && cat "$saved" || true)" "/Applications/Codex.app" "$HOME/Applications/Codex.app" "/Applications/ChatGPT.app" "$HOME/Applications/ChatGPT.app"; do
    resolve_desktop_app "$candidate" && return 0
  done
  return 1
}

find_copilot_sdk() {
  local candidate root
  for candidate in "${CODEX_COPILOT_CLI_SDK:-}" "$([[ -f "$PROFILE_HOME/copilot-cli-sdk-path.txt" ]] && cat "$PROFILE_HOME/copilot-cli-sdk-path.txt" || true)"; do
    resolve_copilot_sdk "$candidate" && return 0
  done
  for root in "$SOURCE_ROOT/runtime/copilot/node_modules" "$INSTALL_ROOT/runtime/copilot/node_modules" "$(command -v npm >/dev/null 2>&1 && npm root -g 2>/dev/null || true)" "$HOME/.local/lib/node_modules" "$HOME/.npm-global/lib/node_modules" "/usr/local/lib/node_modules" "/opt/homebrew/lib/node_modules"; do
    resolve_copilot_sdk "$root" && return 0
  done
  return 1
}

resolve_stock_codex() {
  local candidate="${1:-}" resolved version
  [[ -n "$candidate" ]] || return 1
  [[ -d "$candidate" ]] && candidate="$candidate/codex"
  [[ -f "$candidate" && -x "$candidate" ]] || return 1
  resolved="$("$SOURCE_NODE" -p "require('node:fs').realpathSync(process.argv[1])" "$candidate" 2>/dev/null || true)"
  [[ -n "$resolved" ]] || return 1
  case "$resolved" in
    "$SOURCE_ROOT"/*|"$INSTALL_ROOT"/*|*.app/*) return 1 ;;
  esac
  version="$("$candidate" --version 2>/dev/null | head -n 1 || true)"
  [[ "$version" =~ ^codex-cli[[:space:]]+[0-9]+\. ]] || return 1
  STOCK_CODEX="$candidate"
  STOCK_CODEX_VERSION="$version"
}

find_stock_codex() {
  local candidate saved="$PROFILE_HOME/codex-cli-path.txt"
  for candidate in "${CODEX_COPILOT_STOCK_CODEX:-}" \
    "$([[ -f "$saved" ]] && cat "$saved" || true)" \
    "$(command -v codex || true)" "$HOME/.local/bin/codex" \
    "/usr/local/bin/codex" "/opt/homebrew/bin/codex"; do
    resolve_stock_codex "$candidate" && return 0
  done
  return 1
}

verify_copilot_entitlement() {
  local result
  COPILOT_VERIFIED=0
  if [[ -n "${PENDING_OAUTH_JSON:-}" ]]; then
    COPILOT_VERIFIED=1
    COPILOT_SUMMARY="GitHub OAuth device flow 已验证；完成前不落盘"
    return 0
  fi
  if result="$(CODEX_COPILOT_HOME="$PROFILE_HOME" CODEX_COPILOT_CLI_SDK="${COPILOT_SDK:-}" \
      "$SOURCE_NODE" "$SOURCE_ROOT/bridge/cli.mjs" status 2>&1)" &&
      [[ "$result" =~ Copilot[[:space:]]models[[:space:]]*:[[:space:]]*([1-9][0-9]*)[[:space:]]usable ]]; then
    COPILOT_VERIFIED=1
    COPILOT_SUMMARY="${BASH_REMATCH[1]} usable models"
    return 0
  fi
  COPILOT_STATUS="${result:-No valid GitHub Copilot entitlement was returned.}"
  return 1
}

preflight_device_oauth() {
  # Keep the verified token in this shell only until Desktop and stock CLI pass.
  # No bridge service starts and no ccodex profile credential is written here.
  local mode
  mode="$(printf '%s' "${CODEX_COPILOT_AUTH_MODE:-auto}" | tr '[:upper:]' '[:lower:]')"
  case "$mode" in
    auto|saved) ;;
    *)
      printf '%s  CODEX_COPILOT_AUTH_MODE=%s 不读取保存的 device OAuth；请先提供该模式的有效凭据或改用 auto/saved。%s\n' \
        "$YELLOW" "$mode" "$RESET" >&2
      return 1 ;;
  esac
  PENDING_OAUTH_JSON="$(CODEX_COPILOT_HOME="$PROFILE_HOME" "$SOURCE_NODE" --input-type=module - \
    "$SOURCE_ROOT/bridge/auth.mjs" "$SOURCE_ROOT/bridge/catalog.mjs" <<'NODE'
import { pathToFileURL } from "node:url";
const [authPath, catalogPath] = process.argv.slice(2);
const { deviceLogin, validateToken } = await import(pathToFileURL(authPath));
const { buildCatalog } = await import(pathToFileURL(catalogPath));
const record = await deviceLogin((flow) => {
  process.stderr.write(`\n  Open ${flow.verification_uri}\n  Enter code: ${flow.user_code}\n` +
    "  Waiting for GitHub authorization...\n");
}, { persist: false });
const records = await validateToken(record.oauth_token);
if (!records || buildCatalog(records).models.length === 0) {
  throw new Error("The GitHub OAuth account has no Codex-compatible Copilot entitlement.");
}
process.stdout.write(JSON.stringify(record));
NODE
)" || return 1
  [[ -n "$PENDING_OAUTH_JSON" ]]
}

persist_preflight_oauth() {
  [[ -n "${PENDING_OAUTH_JSON:-}" ]] || return 0
  CODEX_COPILOT_HOME="$PROFILE_HOME" "$NODE" --input-type=module -e '
    import fs from "node:fs";
    import { pathToFileURL } from "node:url";
    const { saveAuthRecord, validateToken } = await import(pathToFileURL(process.argv[1]));
    const record = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!await validateToken(record.oauth_token)) {
      throw new Error("The pending GitHub OAuth account is no longer Copilot-entitled.");
    }
    saveAuthRecord({ ...record, source: "device-flow", verified_at: new Date().toISOString() });
  ' "$INSTALL_ROOT/bridge/auth.mjs" <<<"$PENDING_OAUTH_JSON"
  unset PENDING_OAUTH_JSON
  status_row "GitHub OAuth" "VERIFIED" "前置条件均已满足；凭据仅写入隔离 profile"
}

linux_desktop_instructions() {
  local distro="" release="" package="" url=""
  if [[ -r /etc/os-release ]]; then
    distro="$(. /etc/os-release; printf '%s' "${ID:-}")"
    release="$(. /etc/os-release; printf '%s' "${VERSION_ID:-}")"
  fi
  case "$distro:$release" in
    ubuntu:24.04|ubuntu:26.04|debian:13)
      package="chatgpt_$([[ "$ARCH" == "x64" ]] && printf amd64 || printf arm64).deb"
      url="https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/$package"
      printf '%s  官方 .deb：%s%s\n' "$CYAN" "$url" "$RESET"
      printf '%s  下载后手动运行：sudo apt install ./%s%s\n' "$YELLOW" "$package" "$RESET"
      ;;
    fedora:43|fedora:44)
      package="chatgpt.$([[ "$ARCH" == "x64" ]] && printf x86_64 || printf aarch64).rpm"
      url="https://persistent.oaistatic.com/codex-app-prod/linux/rpm/latest/$package"
      printf '%s  官方 .rpm：%s%s\n' "$CYAN" "$url" "$RESET"
      printf '%s  下载后手动运行：sudo dnf install ./%s%s\n' "$YELLOW" "$package" "$RESET"
      ;;
    arch:*)
      printf '%s  官方 Arch 脚本：https://persistent.oaistatic.com/codex-app-prod/linux/install-arch.sh%s\n' "$CYAN" "$RESET"
      printf '%s  手动：curl --proto '\''=https'\'' --tlsv1.2 -fL -o install-arch.sh https://persistent.oaistatic.com/codex-app-prod/linux/install-arch.sh%s\n' "$YELLOW" "$RESET"
      printf '%s        sudo bash install-arch.sh（会执行完整系统升级，请先核对脚本）。%s\n' "$YELLOW" "$RESET"
      ;;
    *)
      printf '%s  当前 %s %s 不在官方预览支持清单；不假定 Desktop 可用。%s\n' \
        "$YELLOW" "${distro:-unknown}" "${release:-unknown}" "$RESET"
      ;;
  esac
  printf '%s  官方发行版、架构与安装说明：%s%s\n' "$CYAN" "$LINUX_DESKTOP_DOC_URL" "$RESET"
  printf '%s  Linux preview 尚不支持 Computer Use；安装 Desktop 不代表该能力可用。%s\n' "$YELLOW" "$RESET"
}

linux_desktop_supported() {
  local distro="" release=""
  [[ -r /etc/os-release ]] || return 1
  distro="$(. /etc/os-release; printf '%s' "${ID:-}")"
  release="$(. /etc/os-release; printf '%s' "${VERSION_ID:-}")"
  case "$distro:$release" in
    ubuntu:24.04|ubuntu:26.04|debian:13|fedora:43|fedora:44|arch:*) return 0 ;;
    *) return 1 ;;
  esac
}

desktop_instructions() {
  if [[ "$OS" == "linux" ]]; then
    linux_desktop_instructions
  else
    printf '%s  官方 macOS ChatGPT/Codex Desktop 下载：%s%s\n' "$CYAN" "$DESKTOP_URL" "$RESET"
  fi
}

prompt_copilot() {
  local choice candidate
  while [[ "$COPILOT_VERIFIED" != "1" ]]; do
    printf '\n%s  GitHub Copilot 资格尚未验证；仅发现 SDK 并不证明账户有权限。%s\n' "$YELLOW" "$RESET"
    printf '    [1] GitHub OAuth device flow（成功后可不安装 Copilot CLI）\n'
    printf '    [2] 提供现有 copilot-sdk/index.js 或 CLI 路径\n'
    printf '    [3] 经确认用 npm 安装官方 GitHub Copilot CLI，然后验证账户\n'
    printf '    [4] 查看官方 CLI 安装文档并重新检测\n'
    printf '    [q] 退出，不部署 ccodex\n'
    read -r -p '  请选择: ' choice || return 1
    case "$choice" in
      1)
        preflight_device_oauth ||
          printf '%s  GitHub OAuth/资格验证未完成；未写入 profile 或启动 bridge。%s\n' "$YELLOW" "$RESET"
        ;;
      2)
        read -r -p '  Copilot 资源路径: ' candidate || return 1
        COPILOT_SDK="$(resolve_copilot_sdk "$candidate" || true)"
        [[ -n "$COPILOT_SDK" ]] || printf '%s  路径中未找到 copilot-sdk/index.js。%s\n' "$YELLOW" "$RESET"
        ;;
      3)
        if command -v npm >/dev/null 2>&1 && npm install --global '@github/copilot@latest'; then
          COPILOT_SDK="$(find_copilot_sdk || true)"
        fi
        [[ -n "$COPILOT_SDK" ]] || printf '%s  SDK 安装/探测失败：%s%s\n' "$YELLOW" "$COPILOT_CLI_URL" "$RESET"
        ;;
      4)
        printf '%s  GitHub 官方安装说明：%s%s\n' "$CYAN" "$COPILOT_CLI_URL" "$RESET"
        read -r -p '  完成后按 Enter 重新检测: ' candidate || return 1
        COPILOT_SDK="$(find_copilot_sdk || true)"
        ;;
      q|Q) return 1 ;;
      *) printf '%s  无效选项。%s\n' "$YELLOW" "$RESET" ;;
    esac
    verify_copilot_entitlement || printf '%s  尚无已验证资格；请继续 GitHub OAuth，或检查网络与账号权限。%s\n' "$YELLOW" "$RESET"
  done
}

prompt_desktop() {
  local choice candidate
  while [[ -z "$DESKTOP_APP" ]]; do
    printf '\n%s  未找到官方 ChatGPT/Codex Desktop（安装前必需）。%s\n' "$YELLOW" "$RESET"
    printf '    [1] 提供已安装应用路径\n'
    printf '    [2] 显示官方下载安装说明，完成后重新检测\n'
    printf '    [q] 退出，不部署 ccodex\n'
    read -r -p '  请选择: ' choice || return 1
    case "$choice" in
      1)
        read -r -p '  应用路径: ' candidate || return 1
        DESKTOP_APP="$(resolve_desktop_app "$candidate" || true)"
        [[ -n "$DESKTOP_APP" ]] || printf '%s  无法在此路径找到有效应用。%s\n' "$YELLOW" "$RESET"
        ;;
      2)
        desktop_instructions
        read -r -p '  安装完成后按 Enter 重新检测: ' candidate || return 1
        DESKTOP_APP="$(find_desktop_app || true)"
        ;;
      q|Q) return 1 ;;
      *) printf '%s  无效选项。%s\n' "$YELLOW" "$RESET" ;;
    esac
  done
}

prompt_stock_codex() {
  local choice candidate
  while [[ -z "$STOCK_CODEX" ]]; do
    printf '\n%s  未找到独立 stock Codex CLI；包内 patched core 不能替代官方 codex。%s\n' "$YELLOW" "$RESET"
    printf '    [1] 提供已安装的 codex 命令路径\n'
    printf '    [2] 经确认用官方 npm 包安装（npm install -g @openai/codex）\n'
    printf '    [3] 查看官方 standalone/npm/Homebrew 安装说明，完成后重新检测\n'
    printf '    [q] 退出，不部署 ccodex\n'
    read -r -p '  请选择: ' choice || return 1
    case "$choice" in
      1)
        read -r -p '  stock codex 路径: ' candidate || return 1
        resolve_stock_codex "$candidate" ||
          printf '%s  路径无效或指向 ccodex/应用内核；需要独立 stock codex --version。%s\n' "$YELLOW" "$RESET"
        ;;
      2)
        if command -v npm >/dev/null 2>&1 && npm install -g @openai/codex; then
          find_stock_codex || true
        fi
        [[ -n "$STOCK_CODEX" ]] || printf '%s  自动安装/探测失败：%s%s\n' "$YELLOW" "$CODEX_CLI_URL" "$RESET"
        ;;
      3)
        printf '%s  官方 CLI 安装方法：%s%s\n' "$CYAN" "$CODEX_CLI_URL" "$RESET"
        printf '%s  standalone：curl -fsSL https://chatgpt.com/codex/install.sh | sh%s\n' "$CYAN" "$RESET"
        printf '%s  npm：npm install -g @openai/codex%s\n' "$CYAN" "$RESET"
        read -r -p '  安装完成后按 Enter 重新检测: ' candidate || return 1
        find_stock_codex || true
        ;;
      q|Q) return 1 ;;
      *) printf '%s  无效选项。%s\n' "$YELLOW" "$RESET" ;;
    esac
  done
}

validate_bin_home() {
  local name link existing
  [[ "$BIN_HOME" == /* && "$BIN_HOME" != "/" && "$BIN_HOME" != "$HOME" ]] || {
    printf '%s  命令目录必须是独立的绝对路径，不能是根目录或 HOME：%s%s\n' "$YELLOW" "$BIN_HOME" "$RESET" >&2
    return 1
  }
  case "$BIN_HOME" in
    "$SOURCE_ROOT"|"$SOURCE_ROOT"/*|"$INSTALL_ROOT"|"$INSTALL_ROOT"/*|"$PROFILE_HOME"|"$PROFILE_HOME"/*)
      printf '%s  命令目录不能位于源码、安装根或 profile 内：%s%s\n' "$YELLOW" "$BIN_HOME" "$RESET" >&2
      return 1 ;;
  esac
  for name in codex-copilot ccodex codex-copilot-desktop; do
    link="$BIN_HOME/$name"
    if [[ -e "$link" || -L "$link" ]]; then
      [[ -L "$link" ]] || {
        printf '%s  拒绝覆盖已有的非链接命令：%s%s\n' "$YELLOW" "$link" "$RESET" >&2
        return 1
      }
      existing="$(readlink "$link")"
      case "$existing" in
        "$INSTALL_ROOT/bin/$name"|*/codex-copilot/bin/"$name"|*/CodexCopilot/bin/"$name") ;;
        *)
          printf '%s  拒绝改写不属于 ccodex 的命令链接：%s → %s%s\n' \
            "$YELLOW" "$link" "$existing" "$RESET" >&2
          return 1 ;;
      esac
    fi
  done
}

validate_install_root() {
  "$SOURCE_NODE" - "$INSTALL_ROOT" "$SOURCE_ROOT" "$PROFILE_HOME" "$PACKAGE_OS-$PACKAGE_ARCH" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [raw, source, profile, target] = process.argv.slice(2);
function fail(message) { throw new Error(`Unsafe installation root: ${message}`); }
if (!path.isAbsolute(raw) || path.normalize(raw) !== raw ||
    !/^codex-?copilot$/i.test(path.basename(raw))) {
  fail("use an absolute normalized path ending in codex-copilot or CodexCopilot.");
}
let ancestor = path.dirname(raw);
if (ancestor === path.parse(ancestor).root) fail("the filesystem root cannot be the install parent.");
while (!fs.existsSync(ancestor)) {
  const next = path.dirname(ancestor);
  if (next === ancestor) fail("no existing parent directory.");
  ancestor = next;
}
const physicalParent = path.join(fs.realpathSync(ancestor),
  path.relative(ancestor, path.dirname(raw)));
const destination = path.join(physicalParent, path.basename(raw));
const sourceRoot = fs.realpathSync(source);
const profileRoot = fs.existsSync(profile) ? fs.realpathSync(profile) : path.resolve(profile);
const within = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
if (within(sourceRoot, destination) || within(destination, sourceRoot) ||
    within(profileRoot, destination) || within(destination, profileRoot)) {
  fail("the install, source, and profile directories must not overlap.");
}
let existing;
try { existing = fs.lstatSync(destination); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (existing) {
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    fail("the existing install root is not a regular directory.");
  }
  const marker = path.join(destination, "platform-target.json");
  const launcher = path.join(destination, "bin", "codex-copilot");
  const installedVersion = path.join(destination, "VERSION");
  const bridge = path.join(destination, "bridge", "cli.mjs");
  try {
    const installed = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (installed.target !== target ||
        installed.packageVersion !== fs.readFileSync(installedVersion, "utf8").trim() ||
        !fs.statSync(launcher).isFile() || !fs.statSync(bridge).isFile()) {
      fail("the existing directory is not a matching CodexCopilot installation.");
    }
  } catch (error) {
    if (error.message.startsWith("Unsafe installation root:")) throw error;
    fail("refusing to replace an unrecognized existing directory.");
  }
}
process.stdout.write(destination);
NODE
}

validate_staged_payload() {
  "$SOURCE_NODE" - "$STAGING" "$PACKAGE_OS" "$PACKAGE_ARCH" "$VERSION" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [stage, os, arch, version] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(path.join(stage, "platform-target.json"), "utf8"));
const installedVersion = fs.readFileSync(path.join(stage, "VERSION"), "utf8").trim();
if (metadata.os !== os || metadata.arch !== arch ||
    metadata.packageVersion !== version || installedVersion !== version) {
  throw new Error("Staged package target/version does not match this machine.");
}
for (const name of ["platform-target.json", "VERSION", "install.sh",
  "bridge/cli.mjs", "tools/gen-config.mjs", "assets/installer-showcase.json",
  "bin/codex-copilot", "bin/ccodex", "bin/bridge-port.sh", "bin/codex-copilot-desktop",
  "runtime/node/bin/node", "bin/codex-copilot-core"]) {
  const file = fs.lstatSync(path.join(stage, name));
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error(`Staged critical file must be a regular file: ${name}`);
  }
}
const coreHash = crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(stage, "bin", "codex-copilot-core")))
  .digest("hex").toUpperCase();
if (coreHash !== metadata.coreSha256.toUpperCase()) {
  throw new Error("Staged core hash does not match platform-target.json.");
}
NODE
}

# Only directories returned by mktemp directly under the validated install parent
# may be removed. Never clean an env-derived .new/.old path.
remove_owned_stage() {
  local candidate="$1" kind="$2"
  [[ -n "$candidate" && "$candidate" == "$INSTALL_PARENT"/.codex-copilot."$kind".???????? &&
    -d "$candidate" && ! -L "$candidate" &&
    "$(cd "$(dirname "$candidate")" && pwd -P)" == "$INSTALL_PARENT" ]] || {
    printf '%s  拒绝清理非安装器创建的目录：%s%s\n' "$YELLOW" "$candidate" "$RESET" >&2
    return 1
  }
  rm -rf -- "$candidate"
}

rename_exact() {
  "$SOURCE_NODE" -e '
    const fs = require("node:fs");
    try {
      fs.lstatSync(process.argv[2]);
      throw new Error("Refusing to rename over an existing destination.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    fs.renameSync(process.argv[1], process.argv[2]);
  ' "$1" "$2"
}

finish_deployment() {
  local result="$?" restored=0
  trap - EXIT
  if (( result != 0 )); then
    if [[ "$DEPLOYED" == "1" && -n "$STAGING" && ! -e "$STAGING" &&
          ! -L "$STAGING" && -d "$INSTALL_ROOT" && ! -L "$INSTALL_ROOT" ]]; then
      rename_exact "$INSTALL_ROOT" "$STAGING" ||
        printf '%s  无法移走失败的新安装，请手动检查 %s。%s\n' "$YELLOW" "$INSTALL_ROOT" "$RESET" >&2
    fi
    if [[ -n "$ROLLBACK" && -d "$ROLLBACK/previous" &&
          ! -e "$INSTALL_ROOT" && ! -L "$INSTALL_ROOT" ]]; then
      if rename_exact "$ROLLBACK/previous" "$INSTALL_ROOT"; then
        restored=1
        printf '%s  已恢复先前安装：%s%s\n' "$GREEN" "$INSTALL_ROOT" "$RESET" >&2
      fi
    fi
  fi
  if [[ -n "$STAGING" && -d "$STAGING" ]]; then
    remove_owned_stage "$STAGING" stage || result=1
  fi
  if [[ -n "$ROLLBACK" && -d "$ROLLBACK" ]]; then
    if (( result == 0 || restored == 1 )) || [[ ! -d "$ROLLBACK/previous" ]]; then
      remove_owned_stage "$ROLLBACK" rollback || result=1
    else
      printf '%s  保留回滚副本：%s/previous；请人工恢复，未清理该目录。%s\n' \
        "$YELLOW" "$ROLLBACK" "$RESET" >&2
    fi
  fi
  exit "$result"
}

deploy_payload() {
  INSTALL_ROOT="$(validate_install_root)" || return 1
  INSTALL_PARENT="$(dirname "$INSTALL_ROOT")"
  mkdir -p "$INSTALL_PARENT"
  INSTALL_ROOT="$(validate_install_root)" || return 1
  INSTALL_PARENT="$(dirname "$INSTALL_ROOT")"
  STAGING="$(mktemp -d "$INSTALL_PARENT/.codex-copilot.stage.XXXXXXXX")"
  ROLLBACK=""
  DEPLOYED=0
  trap finish_deployment EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  printf '%s  │ 安全暂存：%s%s\n' "$CYAN" "$STAGING" "$RESET"
  (cd "$SOURCE_ROOT" && tar -cf - .) | (cd "$STAGING" && tar -xf -)
  validate_staged_payload
  printf '%s  │ 平台、版本与核心 SHA-256 已在暂存目录核对。%s\n' "$GREEN" "$RESET"
  [[ "$(validate_install_root)" == "$INSTALL_ROOT" ]] || {
    printf '%s  安装根在暂存期间发生变化；拒绝替换。%s\n' "$YELLOW" "$RESET" >&2
    return 1
  }
  if [[ -e "$INSTALL_ROOT" || -L "$INSTALL_ROOT" ]]; then
    [[ -d "$INSTALL_ROOT" && ! -L "$INSTALL_ROOT" ]] || {
      printf '%s  安装目标已变为非目录/符号链接；拒绝替换。%s\n' "$YELLOW" "$RESET" >&2
      return 1
    }
    ROLLBACK="$(mktemp -d "$INSTALL_PARENT/.codex-copilot.rollback.XXXXXXXX")"
    rename_exact "$INSTALL_ROOT" "$ROLLBACK/previous"
    printf '%s  │ 旧安装保留在临时回滚目录；后续成功才清理。%s\n' "$CYAN" "$RESET"
  fi
  rename_exact "$STAGING" "$INSTALL_ROOT"
  DEPLOYED=1
}

case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux) OS="linux" ;;
  *) echo "CodexCopilot supports macOS and Linux from this installer." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

SOURCE_NODE="$SOURCE_ROOT/runtime/node/bin/node"
if [[ ! -x "$SOURCE_NODE" ]]; then SOURCE_NODE="$(command -v node || true)"; fi
if [[ -z "$SOURCE_NODE" ]]; then
  echo "Node.js 22+ is required; this package is missing its bundled runtime." >&2
  exit 1
fi
NODE_MAJOR="$("$SOURCE_NODE" -p "Number(process.versions.node.split('.')[0])")"
if (( NODE_MAJOR < 22 )); then
  echo "Node.js 22+ is required (found $NODE_MAJOR)." >&2
  exit 1
fi

SHOWCASE_B64="$(render_shared_ui load)"
if (( SHOWCASE_ONLY )); then
  PROFILE_HOME="${CODEX_COPILOT_HOME:-$HOME/.codex-copilot}"
  DESKTOP_APP="$(find_desktop_app || true)"
  showcase
  exit 0
fi
if (( SHOWCASE_PREVIEW )); then
  banner
  printf '%s  仅预览展示：未执行资源安装、账户登录或目录修改。%s\n' "$YELLOW" "$RESET"
  showcase
  exit 0
fi

banner
install_step 01 "当前平台：$OS-$ARCH；包目标文件：$TARGET_FILE"
if [[ ! -f "$TARGET_FILE" ]]; then echo "platform-target.json is missing." >&2; exit 1; fi
PACKAGE_OS="$("$SOURCE_NODE" -p "require(process.argv[1]).os" "$TARGET_FILE")"
PACKAGE_ARCH="$("$SOURCE_NODE" -p "require(process.argv[1]).arch" "$TARGET_FILE")"
PACKAGE_MINIMUM_OS="$("$SOURCE_NODE" -p "require(process.argv[1]).minimumOsVersion || ''" "$TARGET_FILE")"
if [[ "$PACKAGE_OS" != "$OS" || "$PACKAGE_ARCH" != "$ARCH" ]]; then
  echo "This package targets $PACKAGE_OS-$PACKAGE_ARCH; this machine is $OS-$ARCH." >&2
  exit 1
fi
status_row "平台与匹配包" "FOUND" "$OS-$ARCH；Node $NODE_MAJOR；release $VERSION"
if [[ "$OS" == "macos" && -n "$PACKAGE_MINIMUM_OS" ]]; then
  CURRENT_OS_VERSION="$(sw_vers -productVersion)"
  if ! "$SOURCE_NODE" -e '
    const have = process.argv[1].split(".").map(Number);
    const need = process.argv[2].split(".").map(Number);
    for (let i = 0; i < Math.max(have.length, need.length); i++) {
      const delta = (have[i] || 0) - (need[i] || 0);
      if (delta > 0) process.exit(0);
      if (delta < 0) process.exit(1);
    }
  ' "$CURRENT_OS_VERSION" "$PACKAGE_MINIMUM_OS"; then
    echo "This package requires macOS $PACKAGE_MINIMUM_OS or newer (found $CURRENT_OS_VERSION)." >&2
    exit 1
  fi
fi

if [[ "$OS" == "macos" ]]; then
  DEFAULT_INSTALL_ROOT="$HOME/Library/Application Support/CodexCopilot"
else
  DEFAULT_INSTALL_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/codex-copilot"
fi
if (( CONFIGURE_ONLY )); then
  INSTALL_ROOT="$SOURCE_ROOT"
else
  INSTALL_ROOT="${CODEX_COPILOT_INSTALL_ROOT:-$DEFAULT_INSTALL_ROOT}"
fi
PROFILE_HOME="${CODEX_COPILOT_HOME:-$HOME/.codex-copilot}"
SOURCE_CODEX_HOME="${CODEX_COPILOT_SOURCE_HOME:-$HOME/.codex}"
source "$SOURCE_ROOT/bin/bridge-port.sh"
cc_resolve_bridge_port "$PROFILE_HOME"
status_row "bridge 端口" "FOUND" "$CODEX_COPILOT_BRIDGE_PORT（环境覆盖 / profile 文件 / 默认值）"
if (( ! CONFIGURE_ONLY )); then
  INSTALL_ROOT="$(validate_install_root)"
  printf '%s  │ 已验证安装根：%s（仅替换匹配平台的既有安装）。%s\n' "$GREEN" "$INSTALL_ROOT" "$RESET"
fi
[[ -x "$SOURCE_ROOT/bin/codex-copilot-core" ]] || {
  printf '%s  缺少包内 patched core；请重新下载匹配平台发行包。%s\n' "$YELLOW" "$RESET" >&2
  exit 1
}

install_step 02 "先核对 GitHub Copilot 资格/SDK，再核对官方 Desktop 与独立 stock Codex CLI；缺失时不部署。"
COPILOT_VERIFIED=0
COPILOT_SUMMARY=""
PENDING_OAUTH_JSON=""
COPILOT_SDK="$(find_copilot_sdk || true)"
if ! verify_copilot_entitlement; then
  copilot_diagnostics
  if [[ "${CODEX_COPILOT_NONINTERACTIVE:-0}" == "1" || ! -t 0 ||
        "${CODEX_COPILOT_SKIP_LOGIN:-0}" == "1" ]]; then
    printf '%s  Copilot 实时资格验证失败；非交互/跳过登录模式不得静默部署。先在当前隔离 profile 登录 GitHub 并重试。%s\n' \
      "$YELLOW" "$RESET" >&2
    printf '%s  │ 诊断：%s%s\n' "$YELLOW" "$COPILOT_STATUS" "$RESET" >&2
    exit 1
  fi
  prompt_copilot
fi
copilot_diagnostics

DESKTOP_APP="$(find_desktop_app || true)"
STOCK_CODEX=""
STOCK_CODEX_VERSION=""
find_stock_codex || true
desktop_cli_diagnostics
if [[ "${CODEX_COPILOT_NONINTERACTIVE:-0}" == "1" || ! -t 0 ]]; then
  if [[ -z "$DESKTOP_APP" ]]; then desktop_instructions; fi
  if [[ -z "$STOCK_CODEX" ]]; then
    printf '%s  独立 stock Codex CLI 未找到；官方安装方法：%s%s\n' "$YELLOW" "$CODEX_CLI_URL" "$RESET" >&2
  fi
  if [[ -z "$DESKTOP_APP" || -z "$STOCK_CODEX" ]]; then
    printf '%s  非交互前置资源检查未通过；不会安装 ccodex、生成 profile 或改动 bridge。%s\n' "$YELLOW" "$RESET" >&2
    exit 1
  fi
else
  [[ -n "$DESKTOP_APP" ]] || prompt_desktop
  [[ -n "$STOCK_CODEX" ]] || prompt_stock_codex
fi
desktop_cli_diagnostics
if (( ! CONFIGURE_ONLY )); then
  BIN_HOME="${CODEX_COPILOT_BIN_HOME:-$HOME/.local/bin}"
  validate_bin_home
  status_row "命令目录" "FOUND" "$BIN_HOME（不覆盖已有的非 ccodex 命令）"
fi

if (( CONFIGURE_ONLY )); then
  install_step 03 "使用已有安装目录：$INSTALL_ROOT（--configure-only 不复制包文件）"
else
  install_step 03 "目标安装目录：$INSTALL_ROOT；先暂存并核对，再保留旧安装以备回滚。"
  deploy_payload
fi

NODE="$INSTALL_ROOT/runtime/node/bin/node"
chmod +x "$NODE" "$INSTALL_ROOT/bin/codex-copilot-core" "$INSTALL_ROOT/bin/codex-copilot" "$INSTALL_ROOT/bin/ccodex"
if [[ -f "$INSTALL_ROOT/bin/codex-copilot-desktop" ]]; then chmod +x "$INSTALL_ROOT/bin/codex-copilot-desktop"; fi

install_step 04 "配置目录：$PROFILE_HOME；命令入口将指向 $INSTALL_ROOT/bin"
mkdir -p "$PROFILE_HOME"
if [[ -d "$INSTALL_ROOT/runtime/workiq" && ! -d "$PROFILE_HOME/workiq/runtime" ]]; then
  mkdir -p "$PROFILE_HOME/workiq"
  cp -R "$INSTALL_ROOT/runtime/workiq" "$PROFILE_HOME/workiq/runtime"
fi
if [[ -d "$INSTALL_ROOT/profile-seed" ]]; then
  for seed_dir in plugins skills agent-skills; do
    if [[ -d "$INSTALL_ROOT/profile-seed/$seed_dir" && ! -d "$PROFILE_HOME/$seed_dir" ]]; then
      cp -R "$INSTALL_ROOT/profile-seed/$seed_dir" "$PROFILE_HOME/$seed_dir"
    fi
  done
fi
if [[ -d "$INSTALL_ROOT/runtime/primary/codex-primary-runtime" && ! -d "$PROFILE_HOME/host-profile/.cache/codex-runtimes/codex-primary-runtime" ]]; then
  mkdir -p "$PROFILE_HOME/host-profile/.cache/codex-runtimes"
  cp -R "$INSTALL_ROOT/runtime/primary/codex-primary-runtime" "$PROFILE_HOME/host-profile/.cache/codex-runtimes/codex-primary-runtime"
fi
persist_preflight_oauth
status_row "隔离 profile" "FOUND" "$PROFILE_HOME（不覆盖 stock Codex profile）"
if [[ -n "$DESKTOP_APP" ]]; then printf '%s\n' "$DESKTOP_APP" > "$PROFILE_HOME/desktop-app-path.txt"; fi
if [[ -n "$COPILOT_SDK" ]]; then
  printf '%s\n' "$COPILOT_SDK" > "$PROFILE_HOME/copilot-cli-sdk-path.txt"
  export CODEX_COPILOT_CLI_SDK="$COPILOT_SDK"
fi
printf '%s\n' "$STOCK_CODEX" > "$PROFILE_HOME/codex-cli-path.txt"
status_row "独立 stock CLI" "FOUND" "$STOCK_CODEX"
CODEX_COPILOT_HOME="$PROFILE_HOME" CODEX_COPILOT_SOURCE_HOME="$SOURCE_CODEX_HOME" \
  "$NODE" "$INSTALL_ROOT/tools/gen-config.mjs"

if (( ! CONFIGURE_ONLY )); then
  validate_bin_home
  mkdir -p "$BIN_HOME"
  ln -sfn "$INSTALL_ROOT/bin/codex-copilot" "$BIN_HOME/codex-copilot"
  ln -sfn "$INSTALL_ROOT/bin/ccodex" "$BIN_HOME/ccodex"
  if [[ -f "$INSTALL_ROOT/bin/codex-copilot-desktop" ]]; then
    ln -sfn "$INSTALL_ROOT/bin/codex-copilot-desktop" "$BIN_HOME/codex-copilot-desktop"
  fi
else
  BIN_HOME="$(dirname "$(command -v codex-copilot 2>/dev/null || printf '%s/bin/codex-copilot' "$INSTALL_ROOT")")"
fi

install_step 05 "重新验证 GitHub 资格并构建隔离模型目录；bridge 默认按需启动，保留显式 autostart 设置。"
verify_copilot_entitlement || {
  printf '%s  配置后 Copilot 资格失效：%s%s\n' "$YELLOW" "$COPILOT_STATUS" "$RESET" >&2
  exit 1
}
status_row "Copilot 资格" "VERIFIED" "$COPILOT_SUMMARY"
CODEX_COPILOT_HOME="$PROFILE_HOME" "$NODE" "$INSTALL_ROOT/bridge/cli.mjs" catalog
if autostart_state="$(CODEX_COPILOT_HOME="$PROFILE_HOME" "$NODE" "$INSTALL_ROOT/bridge/cli.mjs" autostart 2>&1)"; then
  if [[ "$autostart_state" == "Bridge autostart is ON."* ]]; then
    printf '%s  │ 已检测到用户显式启用的 autostart on；本次升级保留设置，不关闭或重建。%s\n' "$GREEN" "$RESET"
  else
    printf '%s  │ bridge 默认按需启动，不占开机常驻资源；打开 ccodex 时由 bridge/ensure.mjs 启动。%s\n' "$GREEN" "$RESET"
    printf '%s  │ 如需登录时自启，可自行运行 codex-copilot autostart on。%s\n' "$GRAY" "$RESET"
  fi
else
  printf '%s  │ 无法读取现有自启状态（%s）；未改动该设置，检查 codex-copilot autostart。%s\n' \
    "$YELLOW" "$autostart_state" "$RESET"
fi

install_step 06 "运行 doctor；真实模型请求和 Browser / Computer Use 仍需分别实测。"
CODEX_COPILOT_HOME="$PROFILE_HOME" "$NODE" "$INSTALL_ROOT/bridge/cli.mjs" doctor
status_row "本机诊断" "VERIFIED" "doctor 通过；真实网页/桌面能力须另行实测"
cat <<EOF
CodexCopilot is configured for $OS-$ARCH.

Commands:
  $BIN_HOME/codex-copilot
  $BIN_HOME/ccodex
  $BIN_HOME/codex-copilot-desktop
  $STOCK_CODEX  ($STOCK_CODEX_VERSION, separate stock CLI)

If $BIN_HOME is not on PATH, add it to your shell profile.
EOF
showcase
