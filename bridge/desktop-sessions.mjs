import { buildDesktopSessionLocalePatch } from "./desktop-session-locale.mjs";
import { loadSquads, loadV2SquadSummaries } from "../gateway/spine/squad-lite.mjs";
import { mountSquadReturnAnchor } from "./desktop-squad-navigation.mjs";
import { readNativeComposerRoute } from "./desktop-native-composer.mjs";
import { desktopPickerBinding } from "./desktop-model-controls.mjs";
import { currentHostContracts } from "./desktop-current-host-contract.mjs";

/** Read the sidecar in the same profile as the session source. Absence from a
 * partial Recent page is never evidence that an anchor was archived. */
export async function loadDesktopSquads(dataDir, listThreads) {
  const store = await loadSquads(dataDir);
  const squads = [...Object.values(store.squads), ...loadV2SquadSummaries(dataDir).filter(s => !Object.hasOwn(store.squads, s.id))];
  if (!squads.length) return { squads: [], threads: [] };
  const wanted = new Set(squads.flatMap(squad => squad.members.map(member => member.threadId.toLowerCase())));
  const threads = new Map(), cursors = new Set();
  let cursor = null;
  do {
    if (cursors.has(cursor) || cursors.size >= 100) throw new Error("Squad session pagination did not complete.");
    cursors.add(cursor);
    const page = await listThreads(cursor);
    if (!Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === "string"))
      throw new Error("Invalid squad session page.");
    for (const thread of page.data) {
      const id = thread.id?.toLowerCase();
      if (wanted.has(id) && thread.archived !== true && thread.remote !== true) {
        // Ownership/inUse protects history operations; it is not a turn status.
        const status = thread.status || { type: "idle" };
        threads.set(id, { id, title: thread.name || thread.title || thread.preview || "", status });
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { squads: squads.filter(squad => threads.has(squad.anchorThreadId.toLowerCase())), threads: [...threads.values()] };
}

export function buildDesktopSquadsPatch(binding = "__codexCopilotSessionRequest",
  responseEvent = "codex-copilot-session-response", gateway = false) {
  return `(()=>{const desktopPickerBinding=${desktopPickerBinding.toString()};const routeReader=${readNativeComposerRoute.toString()};const mountReturnAnchor=()=>(${mountSquadReturnAnchor.toString()})({window:globalThis,contracts:${JSON.stringify(currentHostContracts)},routeReader});return (${installDesktopSquads.toString()})(${JSON.stringify(binding)},${JSON.stringify(responseEvent)},${gateway},mountReturnAnchor);})()`;
}

/** Annotate native sidebar rows in place and preserve their navigation handlers. */
export function installDesktopSquads(binding, responseEvent, gateway, mountReturnAnchor = () => null) {
  if (typeof document === "undefined" || !document.body || !document.head) return "unavailable";
  const previous = globalThis.__codexCopilotSquadsV1;
  if (previous?.revision === 6 && previous.binding === binding && previous.responseEvent === responseEvent) {
    previous.refresh(); return "active";
  }
  previous?.dispose?.();
  const navigation = gateway ? mountReturnAnchor() : null;
  const style = document.createElement("style"); style.id = "codex-copilot-squad-style";
  style.textContent = [
    ".app-shell-left-panel [data-ccodex-squad-source=true]{display:none!important}",
    ".app-shell-left-panel [data-app-action-sidebar-thread-row][data-ccodex-squad-badge]{position:relative;padding-inline-end:var(--ccodex-badge-space,68px)!important}",
    '.app-shell-left-panel [data-app-action-sidebar-thread-row]:is([data-ccodex-squad-badge^="@"],[data-ccodex-squad-badge^="⚠ @"]){--ccodex-badge-space:104px}',
    '.app-shell-left-panel [data-app-action-sidebar-thread-row][data-ccodex-squad-badge]::after{content:attr(data-ccodex-squad-badge);position:absolute;inset-inline-end:6px;top:50%;transform:translateY(-50%);display:block;box-sizing:border-box;max-inline-size:calc(var(--ccodex-badge-space,68px) - 10px);height:16px;padding:0 6px;border-radius:9999px;font:500 10px/14px "SF Mono","JetBrains Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;letter-spacing:-0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;border:1px solid light-dark(#d8d5ce,#2e3440);background:light-dark(#f3f2ee,#1d212a);color:light-dark(#4a4f57,#abb3c2)}',
    '.app-shell-left-panel [data-app-action-sidebar-thread-row][data-ccodex-squad-tone=running]::after{border-color:light-dark(#bbd8f2,rgba(84,166,235,.35));background:light-dark(#e9f3fb,rgba(84,166,235,.14));color:light-dark(#165b91,#7ec0f5)}',
    '.app-shell-left-panel [data-app-action-sidebar-thread-row][data-ccodex-squad-tone=settled]::after{border-color:light-dark(#b7e1ca,rgba(71,184,129,.35));background:light-dark(#eaf6f0,rgba(71,184,129,.14));color:light-dark(#16653e,#73d1a1)}',
    '.app-shell-left-panel [data-app-action-sidebar-thread-row][data-ccodex-squad-tone=attention]::after{border-color:light-dark(#ecc996,rgba(229,153,62,.4));background:light-dark(#fdf4e7,rgba(229,153,62,.16));color:light-dark(#8d4d08,#f2b56b)}',
  ].join("");
  const pending = new Map(), owned = new Set(), badged = new Set();
  const uuidRe = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const localRouteRe = /^\/local\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
  let snapshot = { squads: [], threads: [] }, disposed = false, loading = false, scheduled = false, sequence = 0, error = null;
  function resolveRowThreadId(row) {
    const raw = row.getAttribute("data-app-action-sidebar-thread-id") || "";
    const stripped = raw.replace(/^local:/i, "");
    if (uuidRe.test(stripped)) return stripped.toLowerCase();
    if (!/^(?:local:)?client-new-thread:/i.test(raw)) return stripped ? stripped.toLowerCase() : null;
    const draftUuid = stripped.replace(/^client-new-thread:/i, "").toLowerCase();
    const pickId = value => {
      if (typeof value !== "string") return null;
      const candidate = value.replace(/^local:/i, "");
      if (uuidRe.test(candidate) && candidate.toLowerCase() !== draftUuid) return candidate.toLowerCase();
      const routeHit = localRouteRe.exec(value);
      if (routeHit && routeHit[1].toLowerCase() !== draftUuid) return routeHit[1].toLowerCase();
      return null;
    };
    const inspectProps = props => {
      if (!props || typeof props !== "object") return null;
      for (const item of [
        props.conversationId, props.threadId, props.id,
        props.thread?.id, props.thread?.conversationId,
        props.conversation?.id, props.item?.id, props.item?.threadId,
        props.to, props.href,
      ]) {
        const found = pickId(item);
        if (found) return found;
      }
      return null;
    };
    let el = row;
    for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
      const keys = Object.keys(el);
      const propsKey = keys.find(k => k.startsWith("__reactProps$"));
      if (propsKey) {
        const direct = inspectProps(el[propsKey]);
        if (direct) return direct;
      }
      const fiberKey = keys.find(k => k.startsWith("__reactFiber$"));
      const start = fiberKey ? el[fiberKey] : null;
      if (start) {
        const queue = [start];
        const seen = new Set();
        while (queue.length && seen.size < 48) {
          const fiber = queue.shift();
          if (!fiber || seen.has(fiber)) continue;
          seen.add(fiber);
          const found = inspectProps(fiber.memoizedProps) || pickId(fiber.key);
          if (found) return found;
          if (fiber.alternate) queue.push(fiber.alternate);
          if (fiber.return) queue.push(fiber.return);
          if (fiber.child) queue.push(fiber.child);
          if (fiber.sibling && seen.size < 24) queue.push(fiber.sibling);
        }
        break;
      }
    }
    return stripped.toLowerCase();
  }
  function computeAnchorBadges() {
    const threadMap = new Map(
      (snapshot.threads || [])
        .filter(t => typeof t?.id === "string")
        .map(t => [t.id.toLowerCase(), t]),
    );
    const badges = new Map();
    for (const squad of snapshot.squads) {
      if (!squad || squad.status === "closed" || typeof squad.anchorThreadId !== "string") continue;
      const workers = (squad.members || []).filter(m => m && m.role === "worker" && typeof m.threadId === "string");
      let attention = (squad.ledger?.hopPausedForHuman || squad.missingReports?.length) ? 1 : 0;
      let running = 0;
      let done = 0;
      for (const w of workers) {
        const wid = w.threadId.toLowerCase();
        const state = squad.memberStates?.[w.threadId] ?? squad.memberStates?.[wid];
        const status = threadMap.get(wid)?.status;
        const statusType = String(status?.type || "");
        const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
        if (
          state === "attention" ||
          ["needs_attention", "error", "systemError", "failed", "waitingOnApproval", "waitingOnUserInput"].includes(statusType) ||
          flags.some(f => f === "waitingOnApproval" || f === "waitingOnUserInput")
        ) {
          attention++;
        } else if (state === "running" || ["active", "running", "inProgress"].includes(statusType)) {
          running++;
        } else if (state === "done" || statusType === "completed") {
          done++;
        }
      }
      const parts = [];
      if (attention > 0) parts.push("\u26a0" + attention);
      if (running > 0) parts.push("\u27f3" + running);
      if (done > 0) parts.push("\u2713" + done);
      const text = parts.length ? parts.slice(0, 2).join(" \u00b7 ") : "\u2726" + workers.length;
      const tone = attention > 0 ? "attention" : running > 0 ? "running" : done > 0 ? "settled" : "neutral";
      badges.set(squad.anchorThreadId.toLowerCase(), { text, tone });
    }
    return badges;
  }
  function refresh() {
    if (disposed) return;
    navigation?.update(snapshot);
    const activeSquads = snapshot.squads.filter(s => s && s.status !== "closed");
    const systemWaits = new Set((snapshot.threads || []).filter(t =>
      [t.status?.type, ...(Array.isArray(t.status?.activeFlags) ? t.status.activeFlags : [])].some(flag => ["waitingOnApproval", "waitingOnUserInput"].includes(flag))
    ).map(t => String(t.id).toLowerCase()));
    const hidden = new Set(), badges = computeAnchorBadges();
    for (const squad of activeSquads) {
      for (const member of squad.members || []) {
        if (member?.role !== "worker" || typeof member.threadId !== "string") continue;
        const id = member.threadId.toLowerCase();
        const waiting = systemWaits.has(id);
        if (!waiting && member.sidebarHidden !== false) {
          hidden.add(id);
          continue;
        }
        const handle = typeof member.shortName === "string" ? member.shortName.trim().replace(/^@+/, "") : "";
        if (handle && !badges.has(id)) {
          badges.set(id, { text: waiting ? "⚠ @" + handle : "@" + handle, tone: waiting ? "attention" : "neutral" });
        }
      }
    }
    const nextOwned = new Set(), nextBadged = new Set();
    for (const row of document.querySelectorAll(".app-shell-left-panel [data-app-action-sidebar-thread-row]")) {
      if (row.getAttribute("data-app-action-sidebar-thread-host-id") !== "local") continue;
      const id = resolveRowThreadId(row);
      if (!id) continue;
      if (hidden.has(id)) {
        if (row.getAttribute("data-ccodex-squad-source") !== "true") row.setAttribute("data-ccodex-squad-source", "true");
        nextOwned.add(row);
        continue;
      }
      const badge = badges.get(id);
      if (badge) {
        if (row.getAttribute("data-ccodex-squad-badge") !== badge.text) row.setAttribute("data-ccodex-squad-badge", badge.text);
        if (row.getAttribute("data-ccodex-squad-tone") !== badge.tone) row.setAttribute("data-ccodex-squad-tone", badge.tone);
        nextBadged.add(row);
      }
    }
    for (const row of owned) if (!nextOwned.has(row)) row.removeAttribute("data-ccodex-squad-source");
    owned.clear(); for (const row of nextOwned) owned.add(row);
    for (const row of badged) if (!nextBadged.has(row)) {
      row.removeAttribute("data-ccodex-squad-badge");
      row.removeAttribute("data-ccodex-squad-tone");
    }
    badged.clear(); for (const row of nextBadged) badged.add(row);
  }
  function schedule() {
    if (scheduled || disposed) return;
    scheduled = true; queueMicrotask(() => { scheduled = false; refresh(); });
  }
  const response = event => {
    const reply = event.detail, request = pending.get(reply?.id);
    if (!request) return;
    pending.delete(reply.id); clearTimeout(request.timer);
    if (gateway ? !reply.error : reply.ok) request.resolve(gateway ? reply.result : reply.body);
    else request.reject(new Error(reply.error || "Squad list unavailable."));
  };
  async function load() {
    if (loading || disposed || typeof globalThis[binding] !== "function") return;
    loading = true;
    try {
      const value = await new Promise((resolve, reject) => {
        const id = "sq-" + crypto.randomUUID();
        // Legacy session binding requires a UUID request ID.
        const requestId = gateway ? id : id.slice(3);
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Squad list timed out.")); }, 15000);
        pending.set(requestId, { resolve, reject, timer });
        try { globalThis[binding](JSON.stringify(gateway ? { id: requestId, method: "listSquads", params: {} }
          : { id: requestId, operation: "squads", args: {} })); }
        catch (cause) { pending.delete(requestId); clearTimeout(timer); reject(cause); }
      });
      if (disposed) return;
      if (!Array.isArray(value?.squads) || !Array.isArray(value?.threads)) throw new Error("Invalid squad snapshot.");
      snapshot = value; error = null; sequence++; refresh();
    } catch (cause) {
      if (!disposed) { error = String(cause.message); snapshot = { squads: [], threads: [] }; refresh(); }
    } finally { loading = false; }
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["data-app-action-sidebar-thread-id", "data-app-action-sidebar-thread-host-id",
      "data-app-action-sidebar-thread-active", "data-ccodex-history-removed", "data-theme", "hidden", "style"] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
  const media = matchMedia("(prefers-color-scheme: dark)"); media.addEventListener("change", schedule);
  const activity = event => { if (event.detail?.kind === "squad") void load(); };
  globalThis.addEventListener(responseEvent + "_activity", activity);
  const interval = setInterval(() => { if (!document.hidden) void load(); }, 5000);
  globalThis.addEventListener(responseEvent, response);
  globalThis.addEventListener("codex-copilot-sessions-changed", load);
  document.head.append(style);
  globalThis.__codexCopilotSquadsV1 = { revision: 6, binding, responseEvent, refresh, reload: load,
    inspect: () => ({ groups: 0, loading, sequence, error, collapsed: [] }),
    dispose() {
      if (disposed) return;
      disposed = true; observer.disconnect(); clearInterval(interval);
      globalThis.removeEventListener(responseEvent, response);
      globalThis.removeEventListener(responseEvent + "_activity", activity);
      globalThis.removeEventListener("codex-copilot-sessions-changed", load);
      navigation?.dispose();
      media.removeEventListener("change", schedule);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Squad UI closed.")); }
      pending.clear();
      for (const row of owned) row.removeAttribute("data-ccodex-squad-source");
      for (const row of badged) {
        row.removeAttribute("data-ccodex-squad-badge");
        row.removeAttribute("data-ccodex-squad-tone");
      }
      owned.clear(); badged.clear();
      style.remove(); delete globalThis.__codexCopilotSquadsV1;
    },
  };
  void load();
  return "active";
}

/** Runtime-only UI using the existing Desktop theme and a private CDP binding. */
export function buildDesktopSessionsPatch() {
  return `(() => {
    ${validDesktopSessionTransfer.toString()}
    ${desktopDeletionAcknowledged.toString()}
    ${desktopSessionRequestError.toString()}
    ${desktopSessionApplyRejected.toString()}
    ${syncDesktopSessionMetadata.toString()}
    const state = (${installDesktopSessions.toString()})();
    (${installDesktopSessionSelectionAppearance.toString()})();
    ${buildDesktopSessionLocalePatch()};
    ${buildDesktopSquadsPatch()};
    return state;
  })()`;
}

export function buildDesktopSessionMetadataPatch(operation, results) {
  return `(${syncDesktopSessionMetadata.toString()})(${JSON.stringify(operation)},${JSON.stringify(results)})`;
}

export function syncDesktopSessionMetadata(operation, results) {
  if (!["delete", "archive", "unarchive"].includes(operation) ||
      !Array.isArray(results) || results.length > 500) {
    return { pruned: 0 };
  }
  const keys = results.filter(row => row.status === "complete" ||
    (operation === "delete" && row.status === "absent") ||
    (operation === "archive" && row.status === "matches")).map(row => row.key);
  if (keys.some(key => !/^ccodex:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(key)) ||
      new Set(keys).size !== keys.length) return { pruned: 0 };
  const root = globalThis.__codexRoot?._internalRoot?.current;
  const queue = root ? [root] : [], seen = new Set(), managers = new Set();
  while (queue.length && seen.size < 16000) {
    const fiber = queue.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    for (const value of [fiber.memoizedProps?.manager, fiber.memoizedProps?.appServerManager,
      fiber.memoizedProps?.value, fiber.memoizedState?.memoizedState]) {
      if (typeof value?.getHostId === "function" && value.getHostId() === "local" &&
          typeof value.getThreadSummary === "function" &&
          typeof value.getConversation === "function" &&
          typeof value.threadStore?.removeThreadSummary === "function") managers.add(value);
    }
    if (fiber.child) queue.push(fiber.child);
    if (fiber.sibling) queue.push(fiber.sibling);
  }
  let pruned = 0;
  // Metadata only: do not invoke native delete/archive, lifecycle cleanup,
  // transcript eviction, project cleanup or callbacks on loaded conversations.
  for (const manager of operation === "unarchive" ? [] : managers) {
    for (const key of keys) {
      const id = key.slice(7);
      if (!manager.getConversation(id) && manager.getThreadSummary(id)) {
        manager.threadStore.removeThreadSummary(id);
        pruned++;
      }
    }
  }
  let hidden = 0;
  if (typeof document !== "undefined" && document.body && document.head &&
      typeof MutationObserver === "function" && keys.length) {
    let view = globalThis.__codexCopilotSessionMetadataV1;
    if (!view) {
      const removed = new Set();
      const style = document.createElement("style");
      style.id = "codex-copilot-deleted-session-rows-style";
      style.textContent = ".app-shell-left-panel [data-ccodex-history-removed=true]{display:none!important}";
      document.head.append(style);
      const refresh = () => {
        let count = 0;
        for (const row of document.querySelectorAll(".app-shell-left-panel [data-app-action-sidebar-thread-row]")) {
          const id = row.getAttribute("data-app-action-sidebar-thread-id")?.replace(/^local:/, "");
          const hide = row.getAttribute("data-app-action-sidebar-thread-host-id") === "local" &&
            row.getAttribute("data-app-action-sidebar-thread-active") !== "true" &&
            removed.has(id);
          if (hide) {
            if (row.getAttribute("data-ccodex-history-removed") !== "true")
              row.setAttribute("data-ccodex-history-removed", "true");
            count++;
          } else if (row.hasAttribute("data-ccodex-history-removed"))
            row.removeAttribute("data-ccodex-history-removed");
        }
        return count;
      };
      const observer = new MutationObserver(refresh);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["data-app-action-sidebar-thread-id",
          "data-app-action-sidebar-thread-host-id", "data-app-action-sidebar-thread-active"] });
      view = globalThis.__codexCopilotSessionMetadataV1 = { removed, refresh, observer };
    }
    for (const key of keys) {
      if (operation === "unarchive") view.removed.delete(key.slice(7));
      else view.removed.add(key.slice(7));
    }
    hidden = view.refresh();
  }
  return { pruned, hidden };
}

export function desktopSessionRequestError(result) {
  const error = new Error(result.error || "Session-management request failed.");
  if (typeof result.code === "string") error.code = result.code;
  return error;
}

export function desktopSessionApplyRejected(error) {
  return ["preview_required", "confirmation_required", "deletion_acknowledgement_required",
    "invalid_arguments", "invalid_plan", "plan_expired", "plan_consumed", "batch_busy",
    "result_store_unavailable", "invalid_result", "result_limit"].includes(error?.code);
}

export function desktopDeletionAcknowledged(preview, value) {
  if (preview?.operation !== "delete") return true;
  const count = preview.entries?.filter(entry => entry.eligible).length;
  return preview.irreversible === true && Number.isSafeInteger(count) && count > 0 &&
    preview.deletionAcknowledgement === `DELETE ${count} ${preview.id?.slice(0, 8)}` &&
    value === preview.deletionAcknowledgement;
}

export function validDesktopSessionTransfer(value, state) {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const row = item => item && uuid.test(item.id || "") &&
    item.key === "ccodex:" + item.id.toLowerCase() &&
    typeof item.title === "string" && typeof item.cwd === "string" &&
    [true, false, null].includes(item.inUse) && typeof item.remote === "boolean" &&
    Array.isArray(item.operations) &&
    item.operations.every(operation => ["delete", "archive", "unarchive", "rename"].includes(operation));
  return value?.version === 1 && uuid.test(value.clientId || "") &&
    state && !state.loading && !state.applying && !state.pendingPlan && !state.preview &&
    value.open === state.open && value.total === state.total &&
    Number.isSafeInteger(value.total) && value.total >= 0 &&
    Array.isArray(value.rows) && value.rows.length === state.displayed &&
    value.rows.length <= 50 && value.rows.every(row) &&
    new Set(value.rows.map(item => item.key)).size === value.rows.length &&
    Array.isArray(value.selection) && value.selection.length === state.selected &&
    value.selection.length <= 500 && value.selection.every(row) &&
    new Set(value.selection.map(item => item.key)).size === value.selection.length &&
    Number.isSafeInteger(value.cursor) && value.cursor >= 0 &&
    (value.nextCursor === null || (Number.isSafeInteger(value.nextCursor) && value.nextCursor >= 0)) &&
    typeof value.query === "string" && typeof value.cwd === "string" &&
    ["", "true", "false"].includes(value.archived) &&
    typeof value.status === "string" && typeof value.statusError === "boolean" &&
    Number.isFinite(value.scrollTop) && value.scrollTop >= 0;
}

export function buildDesktopSessionSelectionPatch() {
  return `(${installDesktopSessionSelectionAppearance.toString()})()`;
}

// Style-only upgrades preserve the live controller, selections and pending jobs.
function installDesktopSessionSelectionAppearance() {
  if (typeof document === "undefined" || !document.head) return "unavailable";
  const id = "codex-copilot-session-selection-style";
  let style = document.getElementById(id);
  if (!style) {
    style = document.createElement("style");
    style.id = id;
    document.head.append(style);
  }
  const css = `
    #codex-copilot-sessions {
      --ccs-selection-accent:#2675de;
      --ccs-selection-row:light-dark(#e5efff,#143655);
      --ccs-selection-rail:light-dark(#2675de,#78b9ff);
    }
    #codex-copilot-sessions input[type=checkbox] {
      appearance:auto; accent-color:var(--ccs-selection-accent); display:block;
      width:20px; height:20px; min-width:20px; min-height:20px; flex:none;
      padding:0; margin:2px 0; border:0; border-radius:3px; background:transparent;
      box-shadow:none; cursor:pointer; vertical-align:middle;
    }
    #codex-copilot-sessions input[type=checkbox]:focus-visible {
      outline:3px solid var(--ccs-selection-rail); outline-offset:3px;
    }
    #codex-copilot-sessions input[type=checkbox]:disabled {
      cursor:not-allowed;
    }
    #codex-copilot-sessions input[type=checkbox]:disabled:not(:checked):not(:indeterminate) {
      opacity:.45;
    }
    #codex-copilot-sessions th:has(input[type=checkbox]),
    #codex-copilot-sessions td:has(input[type=checkbox]) { width:46px; opacity:1; }
    #codex-copilot-sessions [data-role=rows] tr:has(input[type=checkbox]:checked) > td {
      background:var(--ccs-selection-row);
    }
    #codex-copilot-sessions [data-role=rows] tr:has(input[type=checkbox]:checked) > td:first-child {
      box-shadow:inset 4px 0 0 var(--ccs-selection-rail);
    }
    #codex-copilot-sessions [data-role=count] {
      display:inline-flex; align-items:center; justify-content:center; flex:none;
      min-height:30px; padding:4px 11px; border-radius:7px;
      background:#215bc2; color:#fff; font-weight:650; font-variant-numeric:tabular-nums;
    }
    @media(forced-colors:active) {
      #codex-copilot-sessions {
        --ccs-selection-accent:Highlight; --ccs-selection-row:Canvas; --ccs-selection-rail:Highlight;
      }
      #codex-copilot-sessions [data-role=rows] tr:has(input[type=checkbox]:checked) {
        outline:2px solid Highlight; outline-offset:-2px;
      }
      #codex-copilot-sessions [data-role=count] {
        background:Highlight; color:HighlightText; border:1px solid Highlight;
      }
    }
  `;
  if (style.textContent !== css) style.textContent = css;
  return "active";
}

function installDesktopSessions() {
  const previous = globalThis.__codexCopilotSessionsV1;
  if (previous?.revision === 8 && previous.sidebarLocaleVersion === 1 &&
      previous.sidebarPlacementVersion === 3 && previous.readLifecycleVersion === 1 &&
      previous.deleteLifecycleVersion === 1 && previous.resultLifecycleVersion === 1 &&
      previous.metadataLifecycleVersion === 1) {
    previous.refreshEntry(); return "active";
  }
  const previousState = previous?.inspect?.();
  if (previousState && (previousState.loading || previousState.applying ||
      previousState.pendingPlan || previousState.preview)) return "reload-required";
  const transferred = previous?.exportState?.();
  const restore = validDesktopSessionTransfer(transferred, previousState) ? transferred : null;
  if (previousState && (previousState.open || previousState.selected) && !restore) return "reload-required";
  previous?.dispose?.();
  const create = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const style = create("style");
  style.id = "codex-copilot-sessions-style";
  style.textContent = `
    #codex-copilot-sessions-entry {
      display:inline-flex; align-items:center; justify-content:center; flex:none;
      min-height:24px; white-space:nowrap; pointer-events:auto;
      border:0; border-radius:6px; padding:3px 7px; background:transparent;
      color:var(--color-text-secondary,inherit); cursor:pointer; font:inherit; font-size:12px;
    }
    #codex-copilot-sessions-entry:hover { background:var(--color-background-secondary,#8882); }
    #codex-copilot-sessions-entry:focus-visible { outline:2px solid var(--color-border,#8888); outline-offset:2px; }
    #codex-copilot-sessions { box-sizing:border-box; width:min(1000px,calc(100vw - 32px));
      max-height:calc(100vh - 72px); margin:auto; padding:22px; border-radius:16px;
      border:1px solid var(--color-border,#8885); background:var(--color-token-main-surface-primary,var(--main-surface-primary,Canvas));
      color:var(--color-text-primary,CanvasText); font:inherit; font-size:13px; }
    #codex-copilot-sessions[open] { display:flex; flex-direction:column; gap:14px; }
    #codex-copilot-sessions[open] { overflow:auto; }
    #codex-copilot-sessions::backdrop { background:#0006; }
    #codex-copilot-sessions * { box-sizing:border-box; }
    #codex-copilot-sessions [hidden] { display:none!important; }
    #codex-copilot-sessions h2 { margin:0; font-size:19px; font-weight:600; }
    #codex-copilot-sessions p { margin:0; line-height:1.5; }
    #codex-copilot-sessions .ccs-header, #codex-copilot-sessions .ccs-bar {
      display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    #codex-copilot-sessions .ccs-header { justify-content:space-between; }
    #codex-copilot-sessions .ccs-muted { opacity:.7; font-size:12px; }
    #codex-copilot-sessions button, #codex-copilot-sessions input,
    #codex-copilot-sessions select { font:inherit; color:inherit; border-radius:7px;
      border:1px solid var(--color-border,#8885); background:transparent; padding:7px 10px; }
    #codex-copilot-sessions button { cursor:pointer; }
    #codex-copilot-sessions button:disabled { cursor:default; opacity:.45; }
    #codex-copilot-sessions input[type=checkbox] { accent-color:var(--color-text-primary); }
    #codex-copilot-sessions [data-field=query] { flex:1; min-width:180px; }
    #codex-copilot-sessions [data-field=cwd] { width:240px; max-width:100%; }
    #codex-copilot-sessions .ccs-list { overflow:auto; min-height:120px; max-height:45vh;
      border:1px solid var(--color-border,#8884); border-radius:9px; }
    #codex-copilot-sessions table { width:100%; border-collapse:collapse; }
    #codex-copilot-sessions th, #codex-copilot-sessions td {
      text-align:left; border-bottom:1px solid var(--color-border,#8883); padding:10px; vertical-align:top; }
    #codex-copilot-sessions th { font-size:12px; font-weight:500; opacity:.8; }
    #codex-copilot-sessions .ccs-title { min-width:170px; max-width:500px; overflow-wrap:anywhere; }
    #codex-copilot-sessions .ccs-heading { display:-webkit-box; -webkit-line-clamp:2;
      -webkit-box-orient:vertical; overflow:hidden; line-height:1.5; }
    #codex-copilot-sessions .ccs-detail { display:block; opacity:.6; font-size:11px; overflow-wrap:anywhere; }
    #codex-copilot-sessions [data-role=status] { white-space:pre-wrap; line-height:1.5; }
    #codex-copilot-sessions [data-error=true] { color:var(--color-text-danger,#d55); }
    #codex-copilot-sessions [data-role=results] { max-height:160px; overflow:auto;
      white-space:pre-wrap; font-size:12px; line-height:1.5; margin:0; }
    #codex-copilot-sessions .ccs-primary { background:var(--color-text-primary,CanvasText);
      color:var(--color-token-main-surface-primary,var(--main-surface-primary,Canvas)); border-color:transparent; }
    #codex-copilot-sessions .ccs-danger {
      color:light-dark(#a51d25,#ffabb0); border-color:light-dark(#b42328,#eb767e);
      background:light-dark(#fff0f0,#49272b); }
    #codex-copilot-sessions [data-action=delete] { margin-inline-start:auto; }
    #codex-copilot-sessions [data-action=apply].ccs-danger { background:#b42328; color:#fff; }
    #codex-copilot-sessions [data-role=delete-confirm] { display:flex; flex-direction:column;
      gap:8px; padding:12px; border:1px solid light-dark(#b42328,#eb767e); border-radius:9px;
      background:light-dark(#fff0f0,#352023); }
    #codex-copilot-sessions [data-role=delete-confirm] strong { color:light-dark(#a51d25,#ffabb0); }
    #codex-copilot-sessions [data-role=delete-token] { font:600 14px/1.5 ui-monospace,Consolas,monospace;
      user-select:all; overflow-wrap:anywhere; }
    #codex-copilot-sessions [data-field=delete-ack] { width:min(420px,100%); }
    #codex-copilot-sessions [data-role=preview] .ccs-list { min-height:80px; max-height:28vh; }
    @media(max-width:640px) { #codex-copilot-sessions { padding:14px; gap:10px; }
      #codex-copilot-sessions [data-field=cwd] { width:100%; }
      #codex-copilot-sessions .ccs-date { display:none; } }
  `;
  const dialog = create("dialog");
  dialog.id = "codex-copilot-sessions";
  dialog.setAttribute("aria-labelledby", "codex-copilot-sessions-title");
  dialog.innerHTML = `
    <header class="ccs-header"><div><h2 id="codex-copilot-sessions-title">Session management</h2>
      <p class="ccs-muted">Local Codex (Copilot) Desktop / ccodex CLI. Active sessions are protected.</p></div>
      <button data-action="close" aria-label="Close session management">Close</button></header>
    <div class="ccs-bar" data-role="filters">
      <input data-field="query" aria-label="Search sessions" placeholder="Title, UUID or directory">
      <select data-field="archived" aria-label="Session state"><option value="">All sessions</option>
        <option value="false">Not archived</option><option value="true">Archived</option></select>
      <input data-field="cwd" aria-label="Working directory" placeholder="Exact working directory (optional)">
      <button data-action="refresh">Refresh</button>
    </div>
    <div class="ccs-bar" data-role="actions">
      <button data-action="select-all">Select all filtered</button><button data-action="clear">Clear selection</button>
      <span data-role="count">0 selected</span>
      <button data-action="archive">Archive selected</button><button data-action="unarchive">Restore selected</button>
      <button data-action="delete" class="ccs-danger">Delete selected permanently</button>
    </div>
    <p data-role="status" role="status" aria-live="polite">Loading sessions...</p>
    <progress data-role="progress" aria-label="Batch progress" hidden max="1" value="0"></progress>
    <section class="ccs-list" data-role="list"><table aria-label="Sessions">
      <thead><tr><th><input type="checkbox" data-action="select-page" aria-label="Select eligible displayed sessions"></th>
        <th>Session</th><th>State</th><th class="ccs-date">Modified</th></tr></thead>
      <tbody data-role="rows"></tbody></table></section>
    <div class="ccs-bar" data-role="pages"><button data-action="previous">Previous</button>
      <button data-action="next">Next</button><span data-role="page"></span></div>
    <section data-role="preview" hidden><p data-role="preview-title"></p>
      <div class="ccs-list"><table aria-label="Exact batch preview"><tbody data-role="preview-rows"></tbody></table></div>
      <p class="ccs-muted">Only the exact IDs below will be changed. Activity and revisions are checked again on apply.</p>
      <div data-role="delete-confirm" hidden>
        <strong data-role="delete-warning">Permanent deletion removes conversation history. Restore cannot undo this.</strong>
        <p>Only the eligible IDs in this preview will be deleted. Unselected descendants and project files are not targets.</p>
        <label for="codex-copilot-delete-ack">Type the exact confirmation below:</label>
        <code data-role="delete-token"></code>
        <input id="codex-copilot-delete-ack" data-field="delete-ack" autocomplete="off" spellcheck="false"
          aria-label="Permanent deletion confirmation" placeholder="Type the exact DELETE phrase">
      </div>
      <div class="ccs-bar"><button data-action="cancel">Cancel preview</button>
        <button data-action="apply" class="ccs-primary">Confirm exact selection</button></div></section>
    <pre data-role="results" aria-live="polite" hidden></pre>
    <button data-action="check-results" hidden>Check batch results</button>
    <button data-action="reconcile" hidden>Recheck current history (no replay)</button>
  `;
  const entry = create("button", "Manage");
  entry.id = "codex-copilot-sessions-entry";
  entry.type = "button";
  entry.setAttribute("aria-label", "Bulk session management");
  entry.setAttribute("aria-haspopup", "dialog");
  entry.title = "Manage sessions in bulk";
  const find = name => dialog.querySelector('[data-role="' + name + '"]');
  const action = name => dialog.querySelector('[data-action="' + name + '"]');
  const field = name => dialog.querySelector('[data-field="' + name + '"]');
  const pendingRequests = new Map();
  const selection = new Map(restore?.selection.map(row => [row.key, row]) || []);
  const clientId = restore?.clientId || crypto.randomUUID();
  let rows = restore?.rows || [], cursor = restore?.cursor || 0;
  let nextCursor = restore?.nextCursor ?? null, total = restore?.total || 0, preview = null;
  let loading = false, selecting = false, applying = false, pendingPlan = null, sequence = 0, debounce = null;
  let disposed = false, previousFocus = null;
  const status = (message, error = false) => {
    find("status").textContent = message;
    find("status").dataset.error = String(error);
  };
  const response = event => {
    const result = event.detail || {};
    const pending = pendingRequests.get(result.id);
    if (!pending) return;
    pendingRequests.delete(result.id);
    clearTimeout(pending.timer);
    if (result.ok) pending.resolve(result.body);
    else pending.reject(desktopSessionRequestError(result));
  };
  const request = (operation, args = {}) => new Promise((resolve, reject) => {
    if (typeof globalThis.__codexCopilotSessionRequest !== "function") {
      reject(new Error("The Desktop session-management bridge is unavailable."));
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Session-management request timed out. Refresh or check results; do not repeat a confirmed batch."));
    }, 35000);
    pendingRequests.set(id, { resolve, reject, timer, operation });
    try {
      globalThis.__codexCopilotSessionRequest(JSON.stringify({
        id, operation, args: { ...args, clientId },
      }));
    } catch (error) {
      clearTimeout(timer); pendingRequests.delete(id); reject(error);
    }
  });
  const filters = () => ({
    query: field("query").value.trim(), cwd: field("cwd").value.trim(),
    ...(field("archived").value ? { archived: field("archived").value === "true" } : {}),
  });
  function controls() {
    const busy = loading || applying || !!pendingPlan;
    find("count").textContent = selection.size + " selected";
    for (const name of ["select-all", "clear", "refresh", "previous", "next", "select-page"]) {
      action(name).disabled = busy || !!preview;
    }
    action("select-all").disabled ||= total > 500 || !total;
    action("previous").disabled ||= cursor === 0;
    action("next").disabled ||= nextCursor === null;
    for (const name of ["archive", "unarchive", "delete"]) {
      action(name).disabled = busy || !!preview ||
        ![...selection.values()].some(row => row.operations.includes(name));
    }
    for (const name of ["query", "cwd", "archived"]) field(name).disabled = selecting || applying || !!preview || !!pendingPlan;
    action("close").disabled = applying;
    action("apply").disabled = busy || !preview?.entries.some(row => row.eligible) ||
      !desktopDeletionAcknowledged(preview, field("delete-ack").value);
    field("delete-ack").disabled = busy;
    action("cancel").disabled = applying || !!pendingPlan;
    action("apply").hidden = !!pendingPlan;
    action("cancel").hidden = !!pendingPlan;
    find("delete-confirm").hidden = !!pendingPlan || preview?.operation !== "delete";
    find("progress").hidden = !pendingPlan;
    action("check-results").hidden = !pendingPlan || applying;
    action("reconcile").hidden = !pendingPlan || applying;
    for (const checkbox of find("rows").querySelectorAll("input")) {
      checkbox.disabled = busy || !!preview || checkbox.dataset.eligible !== "true" ||
        (selection.size >= 500 && !selection.has(checkbox.dataset.key));
    }
  }
  const cell = (row, text, cls) => {
    const node = create("td", text, cls); row.append(node); return node;
  };
  function render() {
    find("rows").replaceChildren();
    for (const item of rows) {
      const row = create("tr");
      const choice = create("input");
      choice.type = "checkbox";
      choice.dataset.key = item.key;
      choice.dataset.eligible = String(item.inUse === false && !item.remote);
      choice.checked = selection.has(item.key);
      choice.setAttribute("aria-label", "Select " + (item.title || item.id));
      choice.onchange = () => {
        if (choice.checked) selection.set(item.key, item); else selection.delete(item.key);
        syncPageSelection(); controls();
      };
      cell(row).append(choice);
      const title = cell(row, undefined, "ccs-title");
      const heading = create("span", item.title || "Untitled", "ccs-heading");
      heading.title = item.title || "Untitled";
      title.append(heading);
      title.append(create("small", item.id + (item.cwd ? "\n" + item.cwd : ""), "ccs-detail"));
      cell(row, item.inUse === true ? "In use - protected" : item.inUse === null
        ? "Unknown - protected" : item.archived ? "Archived" : item.parentId ? "Spawned / idle" : "Idle");
      cell(row, item.modifiedAt ? new Date(item.modifiedAt).toLocaleString() : "Unknown", "ccs-date");
      find("rows").append(row);
    }
    if (!rows.length) {
      const row = create("tr"); const empty = cell(row, "No sessions match these filters."); empty.colSpan = 4;
      find("rows").append(row);
    }
    syncPageSelection();
    find("page").textContent = total + " matching / " + rows.length + " displayed / page " + (Math.floor(cursor / 50) + 1);
    controls();
  }
  function syncPageSelection() {
    const eligible = rows.filter(row => row.inUse === false && !row.remote);
    const selected = eligible.filter(row => selection.has(row.key)).length;
    action("select-page").checked = !!eligible.length && selected === eligible.length;
    action("select-page").indeterminate = selected > 0 && selected < eligible.length;
  }
  async function load(reset = false, quiet = false) {
    const version = ++sequence;
    if (reset) { cursor = 0; selection.clear(); }
    loading = true; controls();
    if (!quiet) status("Loading local sessions...");
    try {
      const result = await request("list", { ...filters(), cursor, limit: 50 });
      if (disposed || version !== sequence) return;
      rows = result.sessions; nextCursor = result.nextCursor; total = result.total;
      const fresh = new Map(rows.map(row => [row.key, row]));
      for (const [key] of selection) {
        const row = fresh.get(key);
        if (row && row.inUse !== false) selection.delete(key);
        else if (row) selection.set(key, row);
      }
      if (!quiet) status(total > 500
        ? "More than 500 sessions match. Narrow the filter to select all."
        : "Select sessions, then preview archive or restore. No history changes until you confirm.");
      loading = false; render();
    } catch (error) {
      if (disposed || version !== sequence) return;
      loading = false; rows = []; nextCursor = null; total = 0; selection.clear();
      status(error.message, true); render();
    }
  }
  function refreshNativeHistory(operation, results) {
    syncDesktopSessionMetadata(operation, results);
    const root = globalThis.__codexRoot?._internalRoot?.current;
    const queue = root ? [root] : [], seen = new Set(), clients = new Set();
    while (queue.length && seen.size < 12000) {
      const fiber = queue.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      for (const value of [fiber.memoizedProps?.client, fiber.memoizedProps?.value]) {
        if (typeof value?.getQueryCache === "function" && typeof value.invalidateQueries === "function") clients.add(value);
      }
      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    for (const client of clients) {
      Promise.resolve(client.invalidateQueries({
        predicate: query => query.queryKey?.[0] === "recent-conversations-meta" ||
          (query.queryKey?.[0] === "vscode" && query.queryKey?.[1] === "list-pinned-threads"),
      })).catch(() => {});
    }
    globalThis.dispatchEvent(new CustomEvent("codex-copilot-sessions-changed"));
  }
  async function previewSelection(operation) {
    if (loading || applying || pendingPlan || preview || !selection.size) return;
    field("delete-ack").value = "";
    loading = true; controls(); status("Checking the exact selection...");
    try {
      const result = await request("preview", { operation, keys: [...selection.keys()] });
      if (disposed) return;
      if (result.operation !== operation || (operation === "delete" &&
          (result.irreversible !== true || typeof result.deletionAcknowledgement !== "string"))) {
        throw new Error("The preview operation did not match this selection. No sessions changed.");
      }
      preview = result;
      find("preview-rows").replaceChildren();
      for (const item of preview.entries) {
        const row = create("tr");
        const title = cell(row, undefined, "ccs-title");
        const heading = create("span", item.title || item.key, "ccs-heading");
        heading.title = item.title || item.key;
        title.append(heading, create("small", item.key, "ccs-detail"));
        cell(row, item.eligible ? "Ready" : "Skip: " + item.reason);
        find("preview-rows").append(row);
      }
      const eligible = preview.entries.filter(item => item.eligible).length;
      find("preview-title").textContent = "Review " + (operation === "delete" ? "permanent delete"
        : operation === "archive" ? "archive" : "restore") +
        ": " + eligible + " eligible / " + preview.entries.length + " selected";
      const deleting = operation === "delete";
      find("delete-confirm").hidden = !deleting;
      find("delete-token").textContent = deleting ? preview.deletionAcknowledgement : "";
      action("apply").className = deleting ? "ccs-danger" : "ccs-primary";
      action("apply").textContent = deleting ? "Confirm permanent deletion" : "Confirm exact selection";
      find("preview").hidden = false;
      for (const name of ["list", "pages", "actions", "filters"]) find(name).hidden = true;
      status(deleting
        ? "No sessions deleted. Review the exact IDs, then type the DELETE phrase. This cannot be restored."
        : "No sessions changed. Review the exact IDs and titles before confirming.");
    } catch (error) { status(error.message, true); }
    finally {
      loading = false; controls();
      if (preview && dialog.open) {
        if (preview.operation === "delete") field("delete-ack").focus();
        else if (!action("apply").disabled) action("apply").focus();
      }
    }
  }
  function leavePreview() {
    preview = null; find("preview").hidden = true;
    field("delete-ack").value = "";
    find("delete-token").textContent = "";
    find("delete-confirm").hidden = true;
    action("apply").className = "ccs-primary";
    action("apply").textContent = "Confirm exact selection";
    for (const name of ["list", "pages", "actions", "filters"]) find(name).hidden = false;
    controls();
  }
  async function reconcilePending() {
    if (!pendingPlan || !preview) throw new Error("The exact pending preview is unavailable. No operation was replayed.");
    const keys = preview.entries.map(row => row.key);
    const result = await request("reconcile", { operation: preview.operation, keys });
    if (disposed) return;
    if (result.readOnly !== true || result.operation !== preview.operation ||
        !Array.isArray(result.results) || result.results.length !== keys.length ||
        new Set(result.results.map(row => row.key)).size !== keys.length ||
        result.results.some(row => !keys.includes(row.key) ||
          !["absent", "matches", "present"].includes(row.status))) {
      throw new Error("The reconciliation did not match the exact preview. No operation was replayed.");
    }
    for (const row of result.results) {
      if (row.status === "absent" || row.status === "matches") selection.delete(row.key);
    }
    const removed = result.results.filter(row => row.status === "absent").length;
    const matched = result.results.filter(row => row.status === "matches").length;
    const remaining = result.results.length - removed - matched;
    pendingPlan = null;
    leavePreview();
    find("results").hidden = false;
    find("results").textContent = result.results.map(row => row.key + ": " + row.status).join("\n");
    cursor = 0;
    await load(false, true);
    status("Current history verified: " + removed + " absent; " + matched + " in target state; " +
      remaining + " remaining. The old execution result is unavailable. Nothing was replayed.", remaining > 0);
    refreshNativeHistory(result.operation, result.results);
  }
  async function checkResults() {
    if (!pendingPlan || applying) return;
    applying = true; controls();
    try {
      let result;
      do {
        result = await request("progress", { planId: pendingPlan });
        if (disposed) return;
        if (result.interrupted) {
          await reconcilePending();
          return;
        }
        status("Processed " + result.completed + " / " + result.total + " sessions...");
        find("progress").max = result.total || 1;
        find("progress").value = result.completed;
        find("results").hidden = false;
        find("results").textContent = result.results.map(row => row.key + ": " + row.status +
          (row.message ? " - " + row.message : row.reason ? " - " + row.reason : "")).join("\n");
        if (!result.done) await new Promise(resolve => setTimeout(resolve, 500));
      } while (!result.done);
      pendingPlan = null;
      leavePreview();
      for (const item of result.results) if (item.status === "complete") selection.delete(item.key);
      const count = state => result.results.filter(item => item.status === state).length;
      find("results").hidden = false;
      find("results").textContent = result.results.map(item => item.key + ": " + item.status +
        (item.message ? " - " + item.message : item.reason ? " - " + item.reason : "")).join("\n");
      cursor = 0;
      await load(false, true);
      status("Complete: " + count("complete") + "; skipped: " + count("skipped") +
        "; failed: " + count("failed") + (result.error ? "\n" + result.error : ""),
        !!result.error || count("failed") > 0);
      refreshNativeHistory(result.operation, result.results);
    } catch (error) {
      if (error.code === "execution_unavailable" ||
          /This (?:batch result|history operation).*(?:unavailable|expired)/.test(error.message)) {
        try { await reconcilePending(); }
        catch (reconcileError) { status(reconcileError.message + "\nNothing was replayed. Recheck current history.", true); }
      } else status(error.message + "\nUse Check batch results to recover the result, not Apply again.", true);
    }
    finally { applying = false; controls(); }
  }
  action("apply").onclick = async () => {
    if (!preview || loading || applying || pendingPlan ||
        !preview.entries.some(row => row.eligible)) return;
    if (!desktopDeletionAcknowledged(preview, field("delete-ack").value)) {
      status("Type the exact DELETE phrase before confirming permanent deletion.", true);
      controls(); return;
    }
    applying = true; controls();
    // Save the ID before dispatch: an uncertain response must not replay a batch.
    pendingPlan = preview.id;
    try {
      const accepted = await request("apply", { planId: preview.id, confirmation: preview.confirmation,
        ...(preview.operation === "delete"
          ? { deletionAcknowledgement: field("delete-ack").value } : {}) });
      if (accepted?.accepted !== true || accepted.planId !== preview.id) {
        throw new Error("The batch acknowledgement is uncertain. Check the existing result; nothing was replayed.");
      }
      applying = false;
      await checkResults();
    } catch (error) {
      applying = false;
      if (desktopSessionApplyRejected(error)) {
        pendingPlan = null;
        leavePreview();
        status(error.message + "\nThe batch was not accepted. Create a fresh preview before confirming.", true);
      } else status(error.message + "\nUse Check batch results; do not apply the batch again.", true);
      controls();
    }
  };
  action("cancel").onclick = () => {
    if (applying || pendingPlan) return;
    leavePreview(); status("Preview cancelled. No sessions changed.");
  };
  action("check-results").onclick = checkResults;
  action("reconcile").onclick = async () => {
    if (!pendingPlan || applying) return;
    applying = true; controls();
    try { await reconcilePending(); }
    catch (error) { status(error.message + "\nNothing was replayed. Recheck current history.", true); }
    finally { applying = false; controls(); }
  };
  action("close").onclick = () => dialog.close();
  dialog.addEventListener("cancel", event => { if (applying) event.preventDefault(); });
  function cancelClosedRead() {
    clearTimeout(debounce);
    debounce = null;
    if (selecting || applying || pendingPlan || preview) return false;
    const reads = [...pendingRequests.entries()].filter(([, pending]) => pending.operation === "list");
    if (!reads.length) return false;
    sequence++;
    loading = false;
    for (const [id, pending] of reads) {
      clearTimeout(pending.timer);
      pendingRequests.delete(id);
      pending.reject(new Error("The session list was closed."));
    }
    status("Session list closed. Reopen to refresh; your selection is preserved.");
    controls();
    return true;
  }
  dialog.addEventListener("close", () => {
    cancelClosedRead();
    if (previousFocus?.isConnected) previousFocus.focus();
  });
  action("archive").onclick = () => previewSelection("archive");
  action("unarchive").onclick = () => previewSelection("unarchive");
  action("delete").onclick = () => previewSelection("delete");
  field("delete-ack").oninput = controls;
  action("clear").onclick = () => { selection.clear(); render(); };
  action("refresh").onclick = () => load(true);
  action("previous").onclick = () => { cursor = Math.max(0, cursor - 50); load(); };
  action("next").onclick = () => { cursor = nextCursor; load(); };
  action("select-page").onchange = () => {
    const checked = action("select-page").checked;
    for (const row of rows) {
      if (row.inUse !== false || row.remote) continue;
      if (checked && selection.size < 500) selection.set(row.key, row);
      else if (!checked) selection.delete(row.key);
    }
    render();
  };
  action("select-all").onclick = async () => {
    clearTimeout(debounce);
    const criteria = filters();
    selecting = true; loading = true; controls(); status("Selecting all filtered idle sessions...");
    try {
      const chosen = new Map();
      let page = 0;
      do {
        const result = await request("list", { ...criteria, cursor: page, limit: 200 });
        if (result.total > 500) throw new Error("More than 500 sessions match. Narrow the filter.");
        for (const row of result.sessions) if (row.inUse === false && !row.remote) chosen.set(row.key, row);
        page = result.nextCursor;
      } while (page !== null);
      selection.clear(); for (const [key, row] of chosen) selection.set(key, row);
      status(chosen.size + " eligible sessions selected across all filtered pages. Active sessions were excluded.");
    } catch (error) { status(error.message, true); }
    finally { selecting = false; loading = false; render(); }
  };
  field("archived").onchange = () => load(true);
  for (const name of ["query", "cwd"]) field(name).oninput = () => {
    clearTimeout(debounce); debounce = setTimeout(() => load(true), 300);
  };
  async function open() {
    previousFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    if (preview?.operation === "delete") field("delete-ack").focus();
    else if (!preview) field("query").focus();
    if (pendingPlan) await checkResults();
    else if (!preview) await load(false);
  }
  entry.onclick = open;
  function refreshEntry() {
    const sidebar = document.querySelector(".app-shell-left-panel");
    const labels = [
      "Chat sidebar options",
      "\u804a\u5929\u4fa7\u8fb9\u680f\u9009\u9879",
      "\u5bf9\u8bdd\u4fa7\u8fb9\u680f\u9009\u9879",
      "\u804a\u5929\u4fa7\u680f\u9009\u9879",
      "\u804a\u5929\u5074\u908a\u6b04\u9078\u9805",
      "\u5c0d\u8a71\u5074\u908a\u6b04\u9078\u9805",
    ];
    const anchor = sidebar && labels.map(label =>
      sidebar.querySelector('[aria-label="' + label + '"]')).find(Boolean);
    // Native action wrappers are zero-width and transparent until hover. Mount
    // beside the section toggle, never inside those wrappers.
    let header = anchor?.parentElement;
    while (header && header !== sidebar &&
        !header.classList.contains("group/nav-section-title")) {
      header = header.parentElement;
    }
    let section = header?.querySelector("[data-app-action-sidebar-section-toggle]");
    // A fresh profile or a collapsed Recent section may omit its options button.
    // The section toggle still identifies a stable visible mounting location.
    if ((!header || header === sidebar || !section) && sidebar) {
      const recent = /^(?:recent(?:\s+chats)?|recents|chats|\u6700\u8fd1(?:\u7684(?:\u5bf9\u8bdd|\u804a\u5929))?|\u8fd1\u671f|\u6700\u8fd1\u5c0d\u8a71)$/i;
      for (const toggle of sidebar.querySelectorAll?.("[data-app-action-sidebar-section-toggle]") || []) {
        if (!recent.test(String(toggle.textContent || "").replace(/\s+/g, " ").trim())) continue;
        let candidate = toggle.parentElement;
        while (candidate && candidate !== sidebar &&
            !candidate.classList.contains("group/nav-section-title")) candidate = candidate.parentElement;
        if (candidate && candidate !== sidebar) { header = candidate; section = toggle; break; }
      }
    }
    if (!header || header === sidebar ||
        !section) return;
    const chinese = /^zh(?:-|$)/i.test(document.documentElement?.lang || "") ||
      /[\u3400-\u9fff]/.test(section.textContent || anchor?.getAttribute("aria-label") || "");
    const text = chinese ? "\u7ba1\u7406" : "Manage";
    const label = chinese ? "\u6279\u91cf\u4f1a\u8bdd\u7ba1\u7406" : "Bulk session management";
    if (entry.textContent !== text) entry.textContent = text;
    if (entry.getAttribute("aria-label") !== label) entry.setAttribute("aria-label", label);
    const title = chinese ? "\u6279\u91cf\u7ba1\u7406\u4f1a\u8bdd" : "Manage sessions in bulk";
    if (entry.title !== title) entry.title = title;
    if (entry.parentElement !== header) header.append(entry);
  }
  globalThis.addEventListener("codex-copilot-session-response", response);
  document.head.append(style);
  document.body.append(dialog);
  const observer = new MutationObserver(refreshEntry);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["aria-label", "data-app-action-sidebar-section-toggle"] });
  refreshEntry();
  globalThis.__codexCopilotSessionsV1 = {
    revision: 8, sidebarLocaleVersion: 1, sidebarPlacementVersion: 3,
    readLifecycleVersion: 1, deleteLifecycleVersion: 1, resultLifecycleVersion: 1,
    metadataLifecycleVersion: 1, open, refreshEntry,
    inspect: () => ({ open: dialog.open, total, displayed: rows.length, selected: selection.size,
      loading, applying, pendingPlan, preview: preview?.id || null,
      previewOperation: preview?.operation || null,
      status: find("status").textContent, entries: document.querySelectorAll("#codex-copilot-sessions-entry").length }),
    exportState() {
      if (loading || selecting || applying || pendingPlan || preview) return null;
      return { version: 1, clientId, rows: [...rows], selection: [...selection.values()],
        cursor, nextCursor, total, open: dialog.open, query: field("query").value,
        cwd: field("cwd").value, archived: field("archived").value,
        status: find("status").textContent, statusError: find("status").dataset.error === "true",
        scrollTop: find("list").scrollTop };
    },
    dispose() {
      disposed = true; sequence++; clearTimeout(debounce); observer.disconnect();
      globalThis.removeEventListener("codex-copilot-session-response", response);
      for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timer); pending.reject(new Error("Session-management UI was replaced."));
      }
      pendingRequests.clear(); dialog.remove(); entry.remove(); style.remove();
      delete globalThis.__codexCopilotSessionsV1;
    },
  };
  if (restore) {
    field("query").value = restore.query;
    field("cwd").value = restore.cwd;
    field("archived").value = restore.archived;
    status(restore.status, restore.statusError);
    render();
    if (restore.open) dialog.showModal();
    find("list").scrollTop = restore.scrollTop;
  }
  return "active";
}
