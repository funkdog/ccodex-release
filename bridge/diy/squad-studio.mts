import type {
  SquadArtifactPreview,
  SquadDeliverable,
  SquadSlotRound,
  SquadGate,
  SquadSessionSettings,
  SquadSlotLiveView,
  SquadStudioSnapshot,
} from "../../gateway/spine/squad-v2-contracts.mjs";

export function mountSquadStudio() {
  const root = document.getElementById("squad-studio-root");
  if (!root) return;

  const bootNode = document.getElementById("squad-studio-boot");
  let snapshot: SquadStudioSnapshot | null = null;
  try {
    const raw = bootNode?.textContent?.trim();
    if (raw && raw !== "null") snapshot = JSON.parse(raw) as SquadStudioSnapshot;
  } catch {
    snapshot = null;
  }

  type PeekTab = "result" | "files" | "brief";
  type DiffViewState = { path: string; loading: boolean; diff: string; error: string | null };
  type ArtifactViewState = { ref: string; label: string; preview?: SquadArtifactPreview; error?: string };

  let themeOverride: "light" | "dark" | null = null;
  let contractsOpen = false;
  let expandedSlotId: string | null = null;
  let expandedInitialized = false;
  const openDetails = new Set<string>();
  const peekTabs = new Map<string, PeekTab>();
  const diffViews = new Map<string, DiffViewState>();
  const artifactViews = new Map<string, ArtifactViewState>();
  const selectedGateOptions = new Map<string, string>();
  const gateNotes = new Map<string, string>();
  let busyAction = false;
  let bannerMessage = "";
  let bannerError = false;
  let pollingInFlight = false;
  let disposed = false;

  const detectTheme = (): "light" | "dark" => {
    if (themeOverride) return themeOverride;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };

  const applyTheme = () => {
    const active = detectTheme();
    document.documentElement.dataset.theme = active;
  };

  const resolveSquadId = (): string | null => {
    if (snapshot?.squadId) return snapshot.squadId;
    const match = window.location.pathname.match(/^\/squads\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
  };

  const buildApiUrl = (subroute: string, extra?: Record<string, string>): string => {
    const squadId = resolveSquadId();
    if (!squadId) throw new Error("缺少有效的小队标识。");
    const url = new URL(`/squads/${encodeURIComponent(squadId)}${subroute}`, window.location.origin);
    const currentParams = new URLSearchParams(window.location.search);
    const token = currentParams.get("token");
    if (token) url.searchParams.set("token", token);
    if (extra) {
      for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    }
    return url.pathname + url.search;
  };

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const modelName = (settings?: SquadSessionSettings) => settings?.model?.trim() ?? "";
  const shortModelName = (model: string) => model.split("/").filter(Boolean).at(-1) ?? model;
  const modelEffort = (settings?: SquadSessionSettings) => settings?.reasoningEffort?.trim() ?? "";
  const modelSettingsBadge = (settings: SquadSessionSettings | undefined): HTMLSpanElement | null => {
    const model = modelName(settings), effort = modelEffort(settings);
    if (!model && !effort) return null;
    const badge = el("span", "badge mono model-settings-badge");
    badge.title = [model, effort].filter(Boolean).join(" · ");
    if (model) badge.append(el("span", "model-name", shortModelName(model)));
    if (model && effort) badge.append(el("span", "model-separator", " · "));
    if (effort) badge.append(el("span", "model-effort", effort));
    return badge;
  };

  // Keep these helpers local: the mount function is serialized into the browser.
  const stripListMarker = (text: string): string => text.trim().replace(/^(?:[-*•]|\d+\.)\s+/, "");
  const safeWebHref = (value?: string) => {
    const raw = value?.trim();
    if (!raw || !/^https?:\/\//i.test(raw) || /[\s\u0000-\u001f\u007f\\]/.test(raw)) return;
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" || url.protocol === "http:") return url.href;
    } catch { /* A malformed URL remains text. */ }
  };
  const externalLink = (href: string, className: string) => {
    const link = el("a", className);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.onclick = event => event.stopPropagation();
    return link;
  };
  const bareUrl = (value: string) => {
    let url = value.replace(/[.,!?;:]+$/, "");
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      const unmatched = url.split(close).length - url.split(open).length;
      for (let i = 0; i < unmatched && url.endsWith(close); i++) url = url.slice(0, -1);
    }
    return url;
  };
  const inlineTokens = new RegExp([
    /`(?<code>[^`\n]+)`/.source,
    /\[(?<label>[^[\]\n]+)\]\((?<href>(?:[^\s()<>]|\([^\s()<>]*\))+)\)/.source,
    /\*\*(?<strong>[^\n]+?)\*\*/.source,
    /(?<![\w:/])(?<bare>https?:\/\/[^\s`*<>"'，。；：、！？）】》]+)/.source,
    /(?<![\w:/])(?<path>\/(?:[^/\s`*<>"'，。；：()[\]{}]+\/){2,}[^/\s`*<>"'，。；：()[\]{}]+)/.source,
    /(?<![/\w.`-])(?<sha>[a-f0-9]{40,64})(?![/\w.`-])/.source,
  ].join("|"), "gi");
  const appendInline = (parent: HTMLElement, text: string, limit = Infinity): void => {
    const compact = Number.isFinite(limit);
    let remaining = limit;
    const clip = (copy: string) => {
      if (copy.length <= remaining) {
        remaining -= copy.length;
        return copy;
      }
      const shown = copy.slice(0, remaining).trimEnd() + "…";
      remaining = -1;
      return shown;
    };
    const write = (target: HTMLElement, source: string) => {
      let offset = 0;
      for (const match of source.matchAll(inlineTokens)) {
        target.append(clip(source.slice(offset, match.index)));
        if (remaining < 0) return;
        const { code, label, href, strong, bare, path, sha } = match.groups!;
        if (strong !== undefined) {
          const node = el("strong");
          write(node, strong);
          target.append(node);
        } else if (label !== undefined || bare !== undefined) {
          const rawUrl = bare === undefined ? href : bareUrl(bare);
          const safe = safeWebHref(rawUrl);
          if (safe) {
            const link = externalLink(safe, "inline-link");
            link.textContent = clip(label ?? rawUrl);
            target.append(link);
            if (bare && remaining >= 0) target.append(clip(bare.slice(rawUrl.length)));
          } else {
            target.append(clip(match[0]));
          }
        } else {
          const raw = code ?? path ?? sha;
          const shown = compact && /^[a-f0-9]{40,64}$/i.test(raw) ? raw.slice(0, 8) : raw;
          if (sha && !compact) {
            target.append(clip(raw));
          } else {
            const node = el("code", "md-inline-code", clip(shown));
            node.title = raw;
            target.append(node);
          }
        }
        if (remaining < 0) return;
        offset = match.index + match[0].length;
      }
      target.append(clip(source.slice(offset)));
    };
    write(parent, text);
  };

  const criterionCopy = (criterion: { text: string; detail?: string | null }) => {
    if (criterion.detail != null) return { title: criterion.text, detail: criterion.detail };
    // Legacy display only: retain the entire original criterion in the detail.
    const legacy = criterion.text.match(/^([^：:\n]{2,44})[：:]\s*([\s\S]+)$/);
    if (legacy && legacy[2].trim().length >= 32 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(criterion.text)) {
      return { title: legacy[1].trim(), detail: criterion.text };
    }
    return { title: criterion.text, detail: null };
  };

  const renderMarkdown = (text: string, className: string): HTMLDivElement => {
    const root = el("div", `markdown-body ${className}`);
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    let paragraph: HTMLParagraphElement | null = null;
    let list: HTMLUListElement | HTMLOListElement | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^\s*(`{3,})(.*)$/);
      if (fence) {
        paragraph = null; list = null;
        const content: string[] = [];
        while (++i < lines.length) {
          const close = lines[i].match(/^\s*(`{3,})\s*$/);
          if (close && close[1].length >= fence[1].length) break;
          content.push(lines[i]);
        }
        const pre = el("pre", "md-code-block");
        const code = el("code", "", content.join("\n"));
        if (fence[2].trim()) pre.title = fence[2].trim();
        pre.append(code); root.append(pre);
        continue;
      }
      if (!line.trim()) { paragraph = null; list = null; continue; }
      const heading = line.match(/^(#{1,3})\s+(.+?)(?:\s+#+)?\s*$/);
      if (heading) {
        paragraph = null; list = null;
        const node = el(heading[1].length === 1 ? "h1" : heading[1].length === 2 ? "h2" : "h3");
        appendInline(node, heading[2]); root.append(node);
        continue;
      }
      const item = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.+)$/);
      if (item) {
        paragraph = null;
        const tag = item[2] ? "ol" : "ul";
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = el(tag);
          if (tag === "ol") (list as HTMLOListElement).start = Number(item[2]);
          root.append(list);
        }
        const li = el("li"); appendInline(li, item[3]); list.append(li);
        continue;
      }
      list = null;
      if (!paragraph) { paragraph = el("p"); root.append(paragraph); }
      else paragraph.append(el("span", "", "\n"));
      appendInline(paragraph, line);
    }
    return root;
  };

  const stripResultRedundancy = (
    rawBody: string,
    hasAssumptions: boolean,
    hasDeliverables = false,
  ): string => {
    let body = rawBody.replace(/\r\n?/g, "\n").trimStart();
    body = body.replace(/^---[^\S\n]*\n[\s\S]*?\n---[^\S\n]*(?:\n|$)/, "").trimStart();
    body = body.replace(/^(?:(?:[-*+][ \t]+)?(?:status|summary|\*\*(?:status|summary)\*\*)[ \t]*:[^\n]*(?:\n|$)\s*)+/i, "");
    if (!hasAssumptions && !hasDeliverables) return body.trim();
    const kept: string[] = [];
    let skippedLevel = 0, fenceLength = 0;
    for (const line of body.split("\n")) {
      const fence = line.match(/^\s*(`{3,})(.*)$/);
      if (fence) {
        if (!fenceLength) fenceLength = fence[1].length;
        else if (fence[1].length >= fenceLength && !fence[2].trim()) fenceLength = 0;
      }
      const heading = !fenceLength && !fence ? line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/) : null;
      if (heading) {
        const level = heading[1].length;
        if (skippedLevel && level <= skippedLevel) skippedLevel = 0;
        if (
          !skippedLevel &&
          ((hasAssumptions && /^(?:Assumptions\s*&\s*Trade-offs|关键假设与取舍|假设与取舍)/i.test(heading[2])) ||
            (hasDeliverables && /^Deliverables$/i.test(heading[2])))
        ) {
          skippedLevel = level;
        }
      }
      if (!skippedLevel) kept.push(line);
    }
    return kept.join("\n").trim();
  };

  const formatDuration = (ms?: number | null): string => {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
    const totalSec = Math.max(1, Math.round(ms / 1000));
    const mins = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const secs = String(totalSec % 60).padStart(2, "0");
    return `${mins}:${secs}`;
  };

  const stageLabels: Record<NonNullable<SquadSlotLiveView['stage']>, string> = { planned: '待派发', running: '执行中', waiting: '等待介入', delivered: '已交付待验收', blocked: '受阻待裁决', escalated: '待拍板升级', accepted: '已验收', superseded: '已接替', failed: '执行异常', offline: '运行时暂未连接' };
  const isArchived = (slot: SquadSlotLiveView) => slot.stage === "accepted" || slot.stage === "superseded";
  const hasReceipt = (result: SquadSlotLiveView["result"]): result is NonNullable<SquadSlotLiveView["result"]> =>
    Boolean(result && !result.autoSynthesized);
  const needsSlotAttention = (slot: SquadSlotLiveView) => {
    if (slot.delta?.forbidViolations?.length) return true;
    const outside = Boolean(slot.delta?.outsideTouches?.length);
    if (slot.stage) return !isArchived(slot) && slot.stage !== 'offline' &&
      (outside || ['waiting','failed','blocked','escalated'].includes(slot.stage));
    return slot.activity !== 'offline' &&
      (outside || slot.result?.status === 'escalate' || slot.result?.status === 'blocked' || slot.activity === 'waiting' || slot.activity === 'failed');
  };

  const repoName = (source: string): string =>
    source.replace(/[\\/]+$/, "").split(/[\\/:]/).at(-1)?.replace(/\.git$/i, "") || source;
  const slotDotState = (slot: SquadSlotLiveView): string => {
    if (slot.stage) return slot.stage === 'running' ? 'active' : ['accepted','delivered'].includes(slot.stage) ? 'quiescent' : slot.stage === 'superseded' ? 'offline' : ['blocked','escalated'].includes(slot.stage) ? 'escalate' : slot.stage;
    if (slot.activity === "offline") return "offline";
    if (slot.result && (slot.result.status === "escalate" || slot.result.status === "blocked")) {
      return "escalate";
    }
    return slot.activity;
  };

  const slotActivityLabel = (slot: SquadSlotLiveView): string => {
    if (slot.stage) return stageLabels[slot.stage];
    if (slot.activity === "offline") return "运行时暂未连接";
    if (slot.result?.status === "escalate") return "请求升级";
    if (slot.result?.status === "blocked") return "受阻";
    switch (slot.activity) {
      case "active":
        return "运行中";
      case "quiescent":
        return slot.result?.status === "done" ? "已静止·完工" : "已静止";
      case "waiting":
        return "等待输入";
      case "failed":
        return "异常";
      case "closed":
        return "已收束";
      default:
        return "待派发";
    }
  };

  const slotPriority = (slot: SquadSlotLiveView): number => {
    if (needsSlotAttention(slot)) return 0;
    if (slot.stage === "running" || (!slot.stage && slot.activity === "active")) return 1;
    if (slot.stage === "delivered" || (!slot.stage && hasReceipt(slot.result))) return 2;
    return slot.activity === "offline" ? 4 : 3;
  };

  const parseUnifiedDiff = (rawDiff: string, showFiles: boolean) => {
    const rows: Array<{ oldLn: string; newLn: string; kind: "ctx" | "add" | "del" | "meta"; text: string }> = [];
    if (!rawDiff.trim()) return rows;
    const lines = rawDiff.replace(/\r\n?/g, "\n").split("\n");
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    for (const line of lines) {
      if (!line && line === lines[lines.length - 1]) continue;
      if (line.startsWith("diff --git ")) {
        inHunk = false;
        if (showFiles) rows.push({ oldLn: "", newLn: "", kind: "meta", text: line });
        continue;
      }
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
        rows.push({ oldLn: "⋯", newLn: "⋯", kind: "meta", text: line });
        continue;
      }
      if (!inHunk) {
        if (/^(?:index |--- |\+\+\+ )/.test(line)) continue;
        rows.push({ oldLn: "", newLn: "", kind: "ctx", text: line });
        continue;
      }
      if (line.startsWith("+")) {
        rows.push({ oldLn: "", newLn: String(newLine++), kind: "add", text: line });
      } else if (line.startsWith("-")) {
        rows.push({ oldLn: String(oldLine++), newLn: "", kind: "del", text: line });
      } else if (line.startsWith("\\")) {
        rows.push({ oldLn: "", newLn: "", kind: "meta", text: line });
      } else {
        rows.push({
          oldLn: String(oldLine++),
          newLn: String(newLine++),
          kind: "ctx",
          text: line.startsWith(" ") ? line : ` ${line}`,
        });
      }
    }
    return rows;
  };

  const ensureDefaultExpanded = () => {
    if (!snapshot || expandedInitialized) return;
    expandedInitialized = true;
    const active = snapshot.slots.filter(slot => !isArchived(slot));
    expandedSlotId = (active.find(needsSlotAttention) ?? active.find(slot => hasReceipt(slot.result)) ?? active[0])?.slotId ?? null;
  };

  const fetchJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const errMsg =
        parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : `请求未完成 (${response.status})`;
      throw new Error(errMsg);
    }
    return parsed as T;
  };

  const syncRefreshButton = () => {
    const button = root.querySelector<HTMLButtonElement>('[data-action="refresh"]');
    if (button) button.disabled = pollingInFlight || busyAction;
  };

  const semanticFingerprint = (value: SquadStudioSnapshot | null) => JSON.stringify(value, function (key, field) {
    if (key === "elapsedMs" || (key === "reportedAt" && this.autoSynthesized === true)) return undefined;
    if (!field || typeof field !== "object" || Array.isArray(field)) return field;
    return Object.fromEntries(Object.keys(field).sort().map(name => [name, field[name]]));
  });
  let fingerprint = semanticFingerprint(snapshot);
  const applySnapshot = (fresh: SquadStudioSnapshot) => {
    const nextFingerprint = semanticFingerprint(fresh);
    const changed = nextFingerprint !== fingerprint;
    if (changed && expandedSlotId && (diffViews.has(expandedSlotId) || artifactViews.has(expandedSlotId))) {
      const previous = snapshot?.slots.find(slot => slot.slotId === expandedSlotId);
      const next = fresh.slots.find(slot => slot.slotId === expandedSlotId);
      if (previous && !isArchived(previous) && next && isArchived(next)) openDetails.add("archived-members");
    }
    snapshot = fresh;
    fingerprint = nextFingerprint;
    return changed;
  };

  const updateElapsed = (slots: SquadSlotLiveView[]) => {
    const selection = window.getSelection();
    const { anchorNode, anchorOffset, focusNode, focusOffset } = selection ?? {};
    let restoreSelection = false;
    for (const slot of slots) {
      if (slot.activity !== "active" || isArchived(slot)) continue;
      const timer = document.getElementById("slot-card-" + slot.slotId)?.querySelector(".role-elapsed")?.firstChild;
      const text = formatDuration(slot.elapsedMs);
      if (timer instanceof Text && timer.data !== text) {
        restoreSelection ||= timer === anchorNode || timer === focusNode;
        timer.data = text;
      }
    }
    if (restoreSelection && selection && anchorNode && focusNode && anchorOffset !== undefined && focusOffset !== undefined) {
      const fit = (target: Node, offset: number) => target instanceof Text ? Math.min(offset, target.length) : offset;
      selection.setBaseAndExtent(anchorNode, fit(anchorNode, anchorOffset), focusNode, fit(focusNode, focusOffset));
    }
  };

  const syncBanner = (scroll: Element) => {
    if (!bannerMessage) return;
    const notice = scroll.querySelector(".status-banner") ?? el("div", "status-banner");
    notice.classList.toggle("is-error", bannerError);
    notice.setAttribute("role", "status");
    notice.textContent = bannerMessage;
    if (!notice.parentNode) scroll.prepend(notice);
  };

  const refreshSnapshot = async (silent = false) => {
    if (pollingInFlight || disposed) return;
    if (!resolveSquadId()) return;
    const before = snapshot;
    pollingInFlight = true;
    syncRefreshButton();
    try {
      const fresh = await fetchJson<SquadStudioSnapshot>(buildApiUrl("/snapshot"));
      if (disposed || snapshot !== before || !fresh?.state || !Array.isArray(fresh.slots)) return;
      const changed = applySnapshot(fresh);
      if (!silent) {
        bannerError = false;
        bannerMessage = `已同步 STATE rev.${fresh.state.revision}`;
      }
      if (changed) {
        render();
      } else {
        updateElapsed(fresh.slots);
        const scroll = root.querySelector(".studio-scroll");
        if (!silent && scroll) syncBanner(scroll);
      }
    } catch (cause) {
      if (!silent && !disposed) {
        bannerError = true;
        bannerMessage = cause instanceof Error ? cause.message : "刷新状态失败。";
        const scroll = root.querySelector(".studio-scroll");
        if (scroll) syncBanner(scroll);
      }
    } finally {
      pollingInFlight = false;
      if (!disposed) syncRefreshButton();
    }
  };

  const loadSlotFileDiff = async (slotId: string, filePath: string) => {
    const pending = { path: filePath, loading: true, diff: "", error: null };
    diffViews.set(slotId, pending);
    render();
    try {
      const payload = await fetchJson<{ diff?: string }>(
        buildApiUrl("/diff", { slotId, path: filePath }),
      );
      if (disposed || diffViews.get(slotId) !== pending) return;
      diffViews.set(slotId, {
        path: filePath,
        loading: false,
        diff: typeof payload?.diff === "string" ? payload.diff : "",
        error: null,
      });
      render();
    } catch (cause) {
      if (disposed || diffViews.get(slotId) !== pending) return;
      diffViews.set(slotId, {
        path: filePath,
        loading: false,
        diff: "",
        error: cause instanceof Error ? cause.message : "读取 Diff 失败。",
      });
      render();
    }
  };

  const loadArtifact = async (slotId: string, label: string, ref: string) => {
    expandedSlotId = slotId;
    const pending: ArtifactViewState = { ref, label };
    artifactViews.set(slotId, pending);
    render();
    const card = document.getElementById(`slot-card-${slotId}`);
    const close = card?.querySelector<HTMLElement>("[data-artifact-close]");
    close?.focus({ preventScroll: true });
    close?.scrollIntoView({ block: "nearest" });
    try {
      const preview = await fetchJson<SquadArtifactPreview>(buildApiUrl("/artifact", { slotId, ref }));
      if (!preview || !["commit", "markdown", "text"].includes(preview.kind) || typeof preview.content !== "string" || typeof preview.title !== "string") {
        throw new Error("产物预览响应无效。");
      }
      pending.preview = preview;
    } catch (cause) {
      pending.error = cause instanceof Error ? cause.message : "读取产物失败。";
    }
    if (!disposed && artifactViews.get(slotId) === pending && expandedSlotId === slotId) render();
  };

  const submitGateResolution = async (
    gate: SquadGate,
    status: "approved" | "changes_requested",
  ) => {
    if (!snapshot || busyAction) return;
    const chosenOptionId =
      selectedGateOptions.get(gate.id) ??
      gate.recommendedOptionId ??
      gate.options?.[0]?.id ??
      null;
    const chosenOption = gate.options?.find(opt => opt.id === chosenOptionId) ?? null;
    const note = (gateNotes.get(gate.id) ?? "").trim();
    const baseLabel = chosenOption
      ? chosenOption.label
      : status === "approved"
        ? "已批准"
        : "请求调整方案";
    const resolutionText = note ? `${baseLabel} — ${note}` : baseLabel;

    busyAction = true;
    bannerError = false;
    bannerMessage = "正在提交门禁裁决…";
    render();
    try {
      const updated = await fetchJson<SquadStudioSnapshot>(buildApiUrl("/gate"), {
        method: "POST",
        body: JSON.stringify({
          expectedRevision: snapshot.state.revision,
          resolveGate: {
            id: gate.id,
            status,
            resolutionText,
          },
        }),
      });
      applySnapshot(updated);
      gateNotes.delete(gate.id);
      bannerError = false;
      bannerMessage = `已记录裁决（STATE rev.${updated.state.revision}）。`;
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "门禁提交失败。";
      bannerError = true;
      bannerMessage = msg;
      if (/revision conflict/i.test(msg)) {
        await refreshSnapshot(true);
      }
    } finally {
      busyAction = false;
      if (!disposed) render();
    }
  };

  const isSystemWait = (slot: SquadSlotLiveView): boolean => slot.activity === "waiting" && Boolean(
    slot.waitsOn?.split(", ").some(flag => ["waitingOnApproval", "waitingOnUserInput"].includes(flag)),
  );
  const canOpenSlot = (slot: SquadSlotLiveView): boolean => Boolean(
    slot.threadId && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(slot.threadId) &&
    (slot.continuity === "stateful" || isSystemWait(slot)),
  );
  const openSlot = async (slot: SquadSlotLiveView) => {
    if (!snapshot || busyAction || !canOpenSlot(slot)) return;
    busyAction = true;
    bannerError = false;
    bannerMessage = `正在打开 ${slot.handle} 原会话…`;
    render();
    try {
      const result = await fetchJson<{ opened: boolean; message: string; snapshot: SquadStudioSnapshot }>(buildApiUrl("/open-thread"), {
        method: "POST", body: JSON.stringify({ slotId: slot.slotId }),
      });
      applySnapshot(result.snapshot);
      bannerError = !result.opened;
      bannerMessage = result.message;
    } catch (cause) {
      bannerError = true;
      bannerMessage = cause instanceof Error ? cause.message : "打开原会话失败。";
    } finally {
      busyAction = false;
      if (!disposed) render();
    }
  };
  const openSlotButton = (slot: SquadSlotLiveView): HTMLButtonElement => {
    const button = el("button", "btn btn-sm", isSystemWait(slot) ? "打开原会话处理审批/输入" : "打开原会话");
    button.type = "button";
    button.dataset.openSlot = slot.slotId;
    button.disabled = busyAction;
    button.onclick = () => void openSlot(slot);
    return button;
  };

  const promoteSlot = async (slot: SquadSlotLiveView) => {
    if (!snapshot || busyAction || slot.continuity !== "stateful") return;
    busyAction = true;
    bannerError = false;
    bannerMessage = `正在扶正 ${slot.handle}…`;
    render();
    try {
      const updated = await fetchJson<SquadStudioSnapshot>(buildApiUrl("/promote"), {
        method: "POST",
        body: JSON.stringify({ slotId: slot.slotId }),
      });
      applySnapshot(updated);
      bannerError = false;
      bannerMessage = `${slot.handle} 已扶正至左侧会话栏。`;
    } catch (cause) {
      bannerError = true;
      bannerMessage = cause instanceof Error ? cause.message : "扶正槽位失败。";
    } finally {
      busyAction = false;
      if (!disposed) render();
    }
  };

  const renderDiffBox = (slot: SquadSlotLiveView, view: DiffViewState): HTMLElement => {
    const box = el("div", "native-diff-box");
    const head = el("div", "native-diff-head");
    const pathEl = el("span", "mono diff-title", view.path);
    pathEl.title = view.path;
    const actions = el("div", "head-actions");
    if (slot.delta?.baseSha || slot.delta?.headSha) {
      actions.append(
        el(
          "span",
          "mono muted-text",
          `${(slot.delta?.baseSha ?? "base").slice(0, 7)}..${(slot.delta?.headSha ?? "WORKTREE").slice(0, 7)}`,
        ),
      );
    }
    const backBtn = el("button", "btn btn-sm", "← 文件列表");
    backBtn.type = "button";
    backBtn.onclick = () => {
      diffViews.delete(slot.slotId);
      render();
    };
    actions.append(backBtn);
    head.append(pathEl, actions);
    box.append(head);

    if (view.loading) {
      box.append(el("div", "diff-empty muted-text", "正在读取工作树 Diff…"));
      return box;
    }
    if (view.error) {
      box.append(el("div", "diff-empty danger-text", view.error));
      return box;
    }
    box.append(renderDiffContent(view.diff, view.path, "当前文件无差异内容。"));
    return box;
  };

  const renderDiffContent = (diff: string, title: string, empty: string, showFiles = false) => {
    const parsed = parseUnifiedDiff(diff, showFiles);
    if (!parsed.length) {
      return el("div", "diff-empty muted-text", empty);
    }
    const table = el("table", "diff-table");
    table.setAttribute("aria-label", `${title} 代码差异`);
    const columns = el("colgroup");
    columns.append(el("col", "diff-ln"), el("col", "diff-ln"), el("col"));
    table.append(columns);
    const tbody = el("tbody");
    for (const row of parsed) {
      const tr = el(
        "tr",
        row.kind === "add"
          ? "diff-row-add"
          : row.kind === "del"
            ? "diff-row-del"
            : row.kind === "meta"
              ? "diff-row-meta"
              : "",
      );
      if (row.kind === "meta" && !row.oldLn) {
        const line = el("td", "diff-code", row.text);
        line.colSpan = 3;
        tr.append(line);
      } else {
        tr.append(
          el("td", "diff-ln", row.oldLn),
          el("td", "diff-ln", row.newLn),
          el("td", "diff-code", row.text),
        );
      }
      tbody.append(tr);
    }
    table.append(tbody);
    return table;
  };

  const renderArtifactPreview = (slotId: string, view: ArtifactViewState) => {
    const section = el("section", "native-diff-box artifact-preview");
    section.setAttribute("aria-label", "只读产物预览");
    const head = el("div", "native-diff-head");
    const title = el("strong", "diff-title", view.preview?.title ?? view.label);
    title.title = title.textContent ?? "";
    const close = el("button", "btn btn-sm", "关闭预览");
    close.type = "button";
    close.dataset.artifactClose = slotId;
    close.onclick = () => {
      artifactViews.delete(slotId);
      render();
      const card = document.getElementById(`slot-card-${slotId}`);
      const chip = Array.from(card?.querySelectorAll<HTMLButtonElement>("[data-preview-ref]") ?? []).find(node =>
        node.dataset.previewRef === view.ref && node.getClientRects().length > 0,
      );
      (chip ?? card?.querySelector<HTMLElement>(".role-card-summary"))?.focus({ preventScroll: true });
    };
    head.append(title, close);
    section.append(head);
    if (!view.preview) {
      const status = el("div", view.error ? "diff-empty danger-text" : "diff-empty muted-text", view.error ?? "正在读取产物…");
      status.setAttribute("role", view.error ? "alert" : "status");
      section.append(status);
      return section;
    }
    const preview = view.preview;
    if (preview.subtitle) section.append(el("p", "artifact-note muted-text", preview.subtitle));
    if (preview.truncated) section.append(el("p", "artifact-note muted-text", "内容已截断。"));
    if (preview.kind === "commit") {
      section.append(renderDiffContent(preview.content, preview.title, "当前提交无差异内容。", true));
    } else if (preview.kind === "markdown") {
      section.append(renderMarkdown(preview.content, "artifact-markdown"));
    } else {
      const pre = el("pre", "md-code-block artifact-text");
      pre.append(el("code", "", preview.content));
      section.append(pre);
    }
    return section;
  };

  const excerpt = (value: string, limit: number): string => {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
  };
  const appendInlineExcerpt = (parent: HTMLElement, raw: string, limit: number): void => {
    appendInline(parent, raw.replace(/\s+/g, " ").trim(), limit);
  };
  const cleanGoal = (goal: string): string => {
    const picked: string[] = [];
    for (const rawLine of goal.replace(/\r\n?/g, "\n").split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        if (picked.length) break;
        continue;
      }
      if (/^(?:#{1,6}\s+|(?:status|summary):)/i.test(line)) continue;
      picked.push(stripListMarker(line));
      if (picked.join(" ").length >= 160) break;
    }
    return picked.join(" ") || goal.replace(/\s+/g, " ").trim();
  };
  const outcome = (result?: SquadSlotLiveView["result"]): string => {
    if (!result || result.autoSynthesized) return "";
    const explicit =
      Boolean(result.summary) &&
      result.summary !== result.body?.slice(0, 300) &&
      !/^\s*(?:---|status:|#)/i.test(result.summary);
    if (explicit) return result.summary.trim();
    const body = stripResultRedundancy(
      result.body || result.summary || "",
      Boolean(result.assumptions?.length),
      Boolean(result.deliverables?.length),
    );
    const section = body.match(/^#{1,6}\s+(?:summary|摘要|结论)\s*\n+([\s\S]*?)(?=\n#{1,6}\s|\n\s*\n|$)/im);
    if (section?.[1]?.trim()) {
      return section[1].trim().split("\n").map(stripListMarker).filter(Boolean).join(" ");
    }
    return (
      body
        .split("\n")
        .map(line => line.trim())
        .find(line => line && !/^(?:[#`|]|---|(?:status|summary|更新时间|updated):)/i.test(line)) ?? ""
    );
  };
  const outputKinds = { mr: "合并请求", issue: "议题", report: "报告", commit: "提交", branch: "分支", artifact: "附件" };
  const compactKinds = { mr: "MR", issue: "Issue", report: "报告", commit: "提交", branch: "分支", artifact: "变更" };
  const deliverableHref = (item: SquadDeliverable) => safeWebHref(item.href) ?? safeWebHref(item.target);
  const isRelayReceipt = (item: SquadDeliverable) =>
    /[\\/]\.mycodex[\\/](?:result|brief)\.md$/i.test(item.target ?? "") ||
    (item.kind === "report" && /^(?:result|brief)\.md$/i.test(item.label.trim()) && !/^https?:\/\//i.test(item.target ?? ""));
  const groupOutputs = (items: SquadDeliverable[]) => {
    const ranked: Array<SquadDeliverable["kind"]> = ["mr", "issue", "report", "commit", "branch"];
    const primary = ranked.flatMap(kind => items.filter(item => item.kind === kind && !isRelayReceipt(item)));
    return { primary, auxiliary: items.filter(item => item.kind === "artifact" || isRelayReceipt(item)) };
  };
  const cardOutputsFor = (items: SquadDeliverable[], archived = false) => {
    const { primary, auxiliary } = groupOutputs(items);
    if (archived) return primary.filter(item => ["mr", "issue", "report"].includes(item.kind));
    return [...primary, ...auxiliary.filter(item => !isRelayReceipt(item) &&
      (deliverableHref(item) || (item.previewKind && item.previewRef) || (!primary.length && /工作树变更文件/.test(item.label))))];
  };
  const renderDeliverables = (slotId: string, items: SquadDeliverable[], compact = false): HTMLElement => {
    const list = el("div", compact ? "deliverable-strip" : "deliverables-list");
    let seenCommit = false;
    const compactPool = compact
      ? items.filter(item => {
          if (item.kind !== "commit") return true;
          if (seenCommit) return false;
          seenCommit = true;
          return true;
        })
      : items;
    const visible = compact ? compactPool.slice(0, 3) : items;
    for (const item of visible) {
      const href = deliverableHref(item);
      const previewRef = item.previewKind && item.previewRef;
      const labelTrim = item.label.trim();
      const labelIsSha = item.kind === "commit" && /^[a-f0-9]{7,64}$/i.test(labelTrim);
      const targetIsSha = item.kind === "commit" && /^[a-f0-9]{7,64}$/i.test(item.target?.trim() ?? "");
      const shortSha = labelIsSha ? labelTrim.slice(0, 8) : targetIsSha ? item.target!.trim().slice(0, 8) : "";
      const baseLabel = labelIsSha
        ? shortSha
        : item.label === item.target && /^(?:\/|[A-Za-z]:[\\/])/.test(labelTrim)
          ? labelTrim.split(/[\\/]/).at(-1) || labelTrim
          : labelTrim;
      const chip = href ? externalLink(href, "deliverable-chip is-link") :
        previewRef ? el("button", "deliverable-chip is-preview") : el("span", "deliverable-chip");
      chip.dataset.kind = item.kind;
      chip.title = [outputKinds[item.kind], item.label, item.target, item.detail].filter(Boolean).join(" · ");
      if (previewRef && chip instanceof HTMLButtonElement) {
        chip.type = "button";
        chip.dataset.previewRef = previewRef;
        chip.onclick = event => {
          event.stopPropagation();
          void loadArtifact(slotId, baseLabel, previewRef);
        };
      }
      if (compact) {
        chip.append(el("span", "chip-kind", compactKinds[item.kind]));
        if (item.kind === "commit" && shortSha && !labelIsSha) {
          chip.append(el("code", "chip-sha mono", shortSha), el("span", "chip-text", excerpt(baseLabel, 22)));
        } else {
          chip.append(el("span", `chip-text${labelIsSha || item.kind === "branch" ? " mono" : ""}`, excerpt(baseLabel, 28)));
        }
        if (href) chip.append(el("span", "chip-ext", "↗"));
        list.append(chip);
      } else {
        if (labelIsSha || item.kind === "branch") chip.classList.add("mono");
        chip.textContent = href ? `${baseLabel} ↗` : baseLabel;
        const row = el("div", "deliverable-row");
        const main = el("div", "deliverable-main");
        const titleLine = el("div", "deliverable-title-line");
        titleLine.append(chip);
        if (shortSha && !labelIsSha) titleLine.append(el("code", "md-inline-code deliverable-sha", shortSha));
        main.append(titleLine);
        if (item.detail) main.append(el("p", "deliverable-detail muted-text", excerpt(item.detail, 160)));
        row.append(el("span", "deliverable-kind", outputKinds[item.kind]), main);
        list.append(row);
      }
    }
    if (compact && items.length > visible.length) {
      const extraCommits = items.filter(i => i.kind === "commit").length - visible.filter(i => i.kind === "commit").length;
      const hiddenTotal = items.length - visible.length;
      list.append(el("span", "deliverable-more mono", extraCommits === hiddenTotal ? `+${hiddenTotal} 提交` : `+${hiddenTotal}`));
    }
    return list;
  };
  const rememberedDetails = (className: string, key: string, summary: HTMLElement) => {
    const details = el("details", className);
    const remember = (open: boolean) => {
      if (open) openDetails.add(key); else openDetails.delete(key);
    };
    details.open = openDetails.has(key);
    summary.onclick = () => remember(!details.open);
    details.ontoggle = () => {
      if (details.isConnected) remember(details.open);
    };
    details.append(summary);
    return details;
  };
  const evidenceDrawer = (key: string, label: string) =>
    rememberedDetails("evidence-drawer", key, el("summary", "", label));
  const renderAssumptions = (items: string[]): HTMLElement => {
    const list = el("ul", "assumptions-list");
    for (const item of items) {
      const li = el("li");
      appendInline(li, stripListMarker(item));
      list.append(li);
    }
    const callout = el("div", "assumptions-callout");
    callout.append(el("strong", "assumptions-callout-title", "关键假设与取舍"), list);
    return callout;
  };
  const renderHistory = (slotId: string, round: SquadSlotRound, key: string): HTMLElement => {
    const section = el("section", "round-record");
    const goalRow = el("div", "round-kv");
    const goalBody = el("div", "round-goal");
    appendInlineExcerpt(goalBody, cleanGoal(round.goal), 180);
    goalRow.append(el("span", "round-field-label", "任务"), goalBody);
    section.append(goalRow);
    if (round.criteriaIds?.length) {
      const critRow = el("div", "round-kv");
      critRow.append(el("span", "round-field-label", "判据"), el("span", "mono muted-text", round.criteriaIds.join(", ")));
      section.append(critRow);
    }
    const { primary, auxiliary } = groupOutputs(round.deliverables ?? []);
    if (primary.length) {
      const outRow = el("div", "round-kv");
      outRow.append(el("span", "round-field-label", "产物"), renderDeliverables(slotId, primary, true));
      section.append(outRow);
    }
    const body = round.result?.body
      ? stripResultRedundancy(
          round.result.body,
          Boolean(round.result.assumptions?.length),
          Boolean(round.deliverables?.length),
        )
      : "";
    if (body || round.result?.assumptions?.length || auxiliary.length || round.deltaSummary) {
      const detail = evidenceDrawer(`${key}:history`, "查看本轮证据与变更");
      if (round.result?.assumptions?.length) detail.append(renderAssumptions(round.result.assumptions));
      if (body) detail.append(renderMarkdown(body, "round-result-body"));
      if (auxiliary.length) detail.append(renderDeliverables(slotId, auxiliary));
      if (round.deltaSummary) {
        detail.append(el("p", "mono muted-text", `${round.deltaSummary.commitCount} 个提交 · ${round.deltaSummary.changedCount} 个文件`));
        for (const file of round.deltaSummary.files ?? []) detail.append(el("div", "mono round-file", file.path));
      }
      section.append(detail);
    }
    return section;
  };
  const renderRolePeek = (slot: SquadSlotLiveView): HTMLElement => {
    const panel = el("div", "role-peek-panel");
    const hasBoundaryViolation = slot.delta?.outsideTouches?.length || slot.delta?.forbidViolations?.length;
    const defaultTab: PeekTab = hasBoundaryViolation && !hasReceipt(slot.result) ? "files" : "result";
    const activeTab = peekTabs.get(slot.slotId) ?? defaultTab;
    peekTabs.set(slot.slotId, activeTab);
    const outputs = slot.deliverables ?? [];
    const { primary, auxiliary } = groupOutputs(outputs);
    const cardOutputs = cardOutputsFor(outputs);
    const current = slot.rounds?.at(-1);
    const totalRounds = slot.rounds?.length ?? 0;
    if (current) {
      const heading = el("section", "current-round");
      const metaLine = el("div", "current-round-head");
      metaLine.append(
        el("span", "badge badge-wave mono", `R${current.round}`),
        el("strong", "current-round-title", outcome(slot.result) ? "当前波次" : "当前波次 · 执行目标"),
        el("span", "muted-text", stageLabels[current.stage] ?? slotActivityLabel(slot)),
      );
      if (totalRounds > 1) metaLine.append(el("span", "muted-text mono", `· 共 ${totalRounds} 轮`));
      if (current.criteriaIds?.length) {
        metaLine.append(el("span", "badge mono round-criteria", `判据 ${current.criteriaIds.join(", ")}`));
      }
      const goalLine = el("div", "round-kv current-round-goal");
      const goalCopy = el("span", "round-goal-inline");
      appendInlineExcerpt(goalCopy, cleanGoal(current.goal), 115);
      goalLine.append(el("span", "round-field-label", "任务"), goalCopy);
      heading.append(metaLine, goalLine);
      panel.append(heading);
    }

    const boundaries = el("dl", "slot-boundaries");
    const addBoundary = (label: string, value: string) => {
      boundaries.append(el("dt", "", label), el("dd", "mono", value));
    };
    if (slot.repo?.source) {
      addBoundary("仓库", slot.repo.source);
      const branch = slot.branch ?? slot.repo.branch;
      if (branch) addBoundary("分支", branch);
      if (slot.repo.baseRef) addBoundary("基准", slot.repo.baseRef);
    }
    if (slot.readOnly !== undefined) addBoundary("只读约束", slot.readOnly ? "启用" : "未启用");
    if (slot.forbid?.length) addBoundary("禁区", slot.forbid.join(", "));
    if (slot.touches.length) addBoundary("写边界", slot.touches.join(", "));
    if (boundaries.childElementCount) panel.append(boundaries);

    const tabsRow = el("div", "peek-tabs");
    const tabList = el("div", "peek-tab-list");
    const filesCount = outputs.length + (slot.delta?.changed?.length ?? 0);
    const tabDefs: Array<[PeekTab, string]> = [
      ["result", "结论与波次"],
      ["files", filesCount > 0 ? `交付与变更 · ${filesCount}` : "交付与变更"],
      ["brief", "裁剪 Brief"],
    ];
    for (const [id, label] of tabDefs) {
      const btn = el("button", `peek-tab${activeTab === id ? " is-active" : ""}`, label);
      btn.type = "button";
      btn.setAttribute("aria-pressed", String(activeTab === id));
      btn.onclick = () => {
        peekTabs.set(slot.slotId, id);
        if (id !== "files") diffViews.delete(slot.slotId);
        render();
      };
      tabList.append(btn);
    }
    tabsRow.append(tabList);

    const actionsWrap = el("div", "peek-actions");
    if (canOpenSlot(slot)) actionsWrap.append(openSlotButton(slot));
    // Clean slots expose only a temporary system-wait exception, never promotion.
    if (slot.continuity === "stateful") {
      if (slot.sidebarHidden === false) {
        actionsWrap.append(el("span", "badge badge-settled mono", "✓ 已扶正至侧栏"));
      } else if (slot.threadId) {
        const promoteBtn = el("button", "btn btn-sm", "扶正至侧栏");
        promoteBtn.type = "button";
        promoteBtn.disabled = busyAction;
        promoteBtn.onclick = () => void promoteSlot(slot);
        actionsWrap.append(promoteBtn);
      } else {
        actionsWrap.append(el("span", "badge badge-stateful mono", "持久专家槽"));
      }
    } else {
      const cleanTag = el("span", "badge badge-clean mono", "零历史隔离槽");
      cleanTag.title = "空白验证者以零对话历史独立验收；仅系统审批或输入等待时可打开处理，不开放侧栏扶正";
      actionsWrap.append(cleanTag);
    }
    tabsRow.append(actionsWrap);
    panel.append(tabsRow);
    const artifact = artifactViews.get(slot.slotId);
    if (artifact) panel.append(renderArtifactPreview(slot.slotId, artifact));
    if (slot.activity === "offline") panel.append(el("p", "muted-text", slot.waitsOn ?? "运行时暂未连接；请等待重连。"));

    if (activeTab === "result") {
      if (hasReceipt(slot.result)) {
        const conclusion = outcome(slot.result);
        const header = el("div", "round-kv result-summary-head");
        const summaryNode = el("strong", "result-summary-text");
        if (conclusion) appendInlineExcerpt(summaryNode, conclusion, 260);
        else summaryNode.textContent = "已收到回执，未提供可预览的结论。";
        header.append(el("span", "round-field-label", "结论"), summaryNode);
        panel.append(header);
        if (cardOutputs.length) {
          const outRow = el("div", "round-kv role-card-outputs is-inline");
          outRow.append(el("span", "round-field-label", "产物"), renderDeliverables(slot.slotId, cardOutputs, true));
          panel.append(outRow);
        }
        if (slot.result.assumptions?.length) panel.append(renderAssumptions(slot.result.assumptions));
        const evidence = evidenceDrawer(`${slot.slotId}:${current?.round ?? 0}:result`, "查看验证过程与取舍");

        if (slot.result.criteriaMet?.length) {
          evidence.append(
            el("div", "mono muted-text", `声称满足判据：${slot.result.criteriaMet.join(", ")}`),
          );
        }
        const body = stripResultRedundancy(
          slot.result.body || "",
          Boolean(slot.result.assumptions?.length),
          Boolean(outputs.length),
        );
        if (conclusion.length > 260) {
          const fullSummary = el("p", "muted-text");
          appendInlineExcerpt(fullSummary, conclusion, 2000);
          evidence.append(fullSummary);
        }
        if (body) evidence.append(renderMarkdown(body, "result-body-text"));
        if (evidence.children.length > 1) panel.append(evidence);
      } else {
        const emptyText = slot.activity === "offline" ? "连接恢复后可继续核对当前执行状态。" :
          slot.activity === "active"
            ? "本轮正在执行，尚未交付。"
            : slot.waitsOn
              ? `等待前置依赖或外部输入：${slot.waitsOn}`
              : "本轮暂无交付回执。";
        panel.append(el("div", "muted-text", emptyText));
        if (cardOutputs.length) {
          const outRow = el("div", "round-kv role-card-outputs is-inline");
          outRow.append(el("span", "round-field-label", "产物"), renderDeliverables(slot.slotId, cardOutputs, true));
          panel.append(outRow);
        }
      }

      const historyRounds = (slot.rounds ?? []).slice(0, -1).reverse();
      if (historyRounds.length) panel.append(el("h3", "delivery-heading", `历史波次 · ${historyRounds.length}`));
      for (const round of historyRounds) {
        const key = `${slot.slotId}:${round.round}`;
        const summary = el("summary", "history-summary");
        const head = el("span", "history-head");
        const left = el("span", "history-head-left");
        const roundPrimary = groupOutputs(round.deliverables ?? []).primary;
        left.append(
          el("span", "badge mono", `R${round.round}`),
          el("span", "history-meta", stageLabels[round.stage] ?? round.stage),
          ...(roundPrimary.length ? [el("span", "history-meta", `· ${roundPrimary.length} 项产物`)] : []),
        );
        head.append(left, el("span", "history-chevron muted-text"));
        const outcomeNode = el("span", "history-outcome");
        appendInlineExcerpt(outcomeNode, outcome(round.result) || cleanGoal(round.goal), 150);
        summary.append(head, outcomeNode);
        const history = rememberedDetails("round-history", key, summary);
        history.append(renderHistory(slot.slotId, round, key)); panel.append(history);
      }
    } else if (activeTab === "files") {
      if (primary.length) panel.append(el("h3", "delivery-heading", "主要交付"), renderDeliverables(slot.slotId, primary));
      if (auxiliary.length) {
        const extras = evidenceDrawer(`${slot.slotId}:${current?.round ?? 0}:attachments`, `附件与过程证据 · ${auxiliary.length}`);
        extras.append(renderDeliverables(slot.slotId, auxiliary));
        panel.append(extras);
      }
      if (outputs.some(item => item.target)) {
        const refs = evidenceDrawer(`${slot.slotId}:${current?.round ?? 0}:references`, "查看完整路径与引用");
        for (const item of outputs) if (item.target) refs.append(el("code", "deliverable-target", item.target));
        panel.append(refs);
      }
      const activeDiff = diffViews.get(slot.slotId);
      if (activeDiff) {
        panel.append(renderDiffBox(slot, activeDiff));
      } else if (slot.delta?.changed?.length) {
        panel.append(el("h3", "delivery-heading", `工作树文件变更 · ${slot.delta.changed.length}`));
        if (slot.delta.commits?.length && !primary.some(item => item.kind === "commit")) {
          const commitLine = el(
            "div",
            "mono muted-text",
            `最新提交：${slot.delta.commits[0].sha.slice(0, 7)} · ${slot.delta.commits[0].subject}`,
          );
          panel.append(commitLine);
        }
        const outsideSet = new Set(slot.delta.outsideTouches ?? []);
        const forbidden = new Set(slot.delta.forbidViolations ?? []);
        const fileList = el("div", "file-list");
        for (const f of slot.delta.changed) {
          const rowBtn = el("button", "file-row-btn");
          rowBtn.type = "button";
          rowBtn.dataset.diffPath = f.path;
          const left = el("span", "file-row-left");
          left.append(
            el("span", "mono file-status", f.status),
            el("span", "mono file-path", f.path),
          );
          const right = el("span", "file-row-right mono");
          if (forbidden.has(f.path) || outsideSet.has(f.path)) {
            right.append(el("span", "badge badge-danger mono", forbidden.has(f.path) ? "触碰禁区" : "越出 touches"));
          }
          const addSpan = el("span", "text-add", `+${f.add}`);
          const delSpan = el("span", "text-del", `−${f.del}`);
          right.append(addSpan, delSpan, el("span", "muted-text", "Diff ▸"));
          rowBtn.append(left, right);
          rowBtn.onclick = () => void loadSlotFileDiff(slot.slotId, f.path);
          fileList.append(rowBtn);
        }
        panel.append(fileList);
      } else if (!outputs.length) {
        panel.append(
          el(
            "div",
            "muted-text",
            slot.continuity === "clean"
              ? "空白终审槽以只读方式核验代码与门禁，不产生业务改动。"
              : slot.workspace === "shared" ? "暂无可引用的交付记录。共享工作区不自动统计文件变更。" : "尚无交付记录或工作树变更。",
          ),
        );
      }
    } else {
      panel.append(renderMarkdown(slot.briefMarkdown || "尚未下发槽位裁剪简报。", "brief-markdown"));
    }

    return panel;
  };

  const renderNeedsYou = (snap: SquadStudioSnapshot): HTMLElement => {
    const section = el("section", "needs-you-slot");
    section.id = "needs-you-slot";
    section.setAttribute("aria-label", "Needs You 置顶拦截槽");

    const gate = snap.state.activeGate?.status === "open" ? snap.state.activeGate : null;
    const hasNeeds = snap.needsYou.length > 0 || Boolean(gate);
    // Trade-off #1: Physical 0px removal when needsYou is empty.
    if (!hasNeeds) {
      section.hidden = true;
      return section;
    }

    const head = el("div", "needs-you-head");
    head.append(
      el("span", "", `⚠ NEEDS YOU · 需你拍板 (${Math.max(snap.needsYou.length, gate ? 1 : 0)})`),
      el("span", "mono", `STATE rev.${snap.state.revision}`),
    );
    section.append(head);

    if (gate) {
      const gateCard = el("div", "needs-you-item");
      const kindText =
        gate.kind === "blueprint"
          ? "立项对齐 Gate"
          : gate.kind === "convergence"
            ? "阶段交付 Gate"
            : "契约/方案裁决 Gate";
      const titleRow = el("div", "gate-head-row");
      titleRow.append(
        el("strong", "gate-title", gate.title),
        el("span", "badge badge-attention mono", `${kindText} · rev.${snap.state.revision}`),
      );
      gateCard.append(titleRow, el("div", "gate-question", gate.question));

      if (gate.options?.length) {
        const currentSelected =
          selectedGateOptions.get(gate.id) ??
          gate.recommendedOptionId ??
          gate.options[0].id;
        const optList = el("div", "gate-options");
        for (const opt of gate.options) {
          const selected = opt.id === currentSelected;
          const optBtn = el("button", `gate-option${selected ? " is-selected" : ""}`);
          optBtn.type = "button";
          optBtn.dataset.gateOptionId = opt.id;
          optBtn.append(el("span", "mono gate-radio", selected ? "◉" : "○"));
          const copy = el("span", "gate-option-copy");
          const labelLine = el("span", "gate-option-label", opt.label);
          if (gate.recommendedOptionId === opt.id) {
            labelLine.append(el("span", "badge badge-stateful", "Recommended"));
          }
          copy.append(labelLine, el("span", "gate-option-summary", opt.summary));
          optBtn.append(copy);
          optBtn.onclick = () => {
            selectedGateOptions.set(gate.id, opt.id);
            render();
          };
          optList.append(optBtn);
        }
        gateCard.append(optList);
      }

      const noteInput = el("input", "gate-note-input") as HTMLInputElement;
      noteInput.type = "text";
      noteInput.dataset.gateNoteInput = "1";
      noteInput.dataset.gateId = gate.id;
      noteInput.placeholder = "可选补充拍板要求或修改意见…";
      noteInput.value = gateNotes.get(gate.id) ?? "";
      noteInput.disabled = busyAction;
      noteInput.oninput = () => {
        gateNotes.set(gate.id, noteInput.value);
      };
      gateCard.append(noteInput);

      const actionRow = el("div", "gate-actions");
      actionRow.append(
        el("span", "mono muted-text", `expectedRevision=${snap.state.revision}`),
      );
      const btns = el("div", "btn-group");
      const rejectBtn = el("button", "btn btn-sm", "要求修改");
      rejectBtn.type = "button";
      rejectBtn.disabled = busyAction;
      rejectBtn.dataset.gateAction = "changes_requested";
      rejectBtn.onclick = () => void submitGateResolution(gate, "changes_requested");

      const approveLabel =
        gate.kind === "blueprint"
          ? "批准开跑 ↵"
          : gate.kind === "convergence"
            ? "确认合入 ↵"
            : "确认裁决 ↵";
      const approveBtn = el("button", "btn btn-sm btn-primary", approveLabel);
      approveBtn.type = "button";
      approveBtn.disabled = busyAction;
      approveBtn.dataset.gateAction = "approved";
      approveBtn.onclick = () => void submitGateResolution(gate, "approved");
      btns.append(rejectBtn, approveBtn);
      actionRow.append(btns);
      gateCard.append(actionRow);
      section.append(gateCard);
    }

    for (const item of snap.needsYou) {
      if (item.kind === "gate" && gate) continue;
      const card = el("div", "needs-you-item");
      card.append(
        el("strong", "gate-title", item.title),
        el("div", "gate-question", item.detail),
      );
      if (item.slotId) {
        const sid = item.slotId;
        const jumpRow = el("div", "btn-group");
        const inspectBtn = el("button", "btn btn-sm", "定位槽位详情");
        inspectBtn.type = "button";
        inspectBtn.onclick = () => {
          expandedSlotId = sid;
          if (snap.slots.some(slot => slot.slotId === sid && isArchived(slot))) openDetails.add("archived-members");
          peekTabs.set(sid, "result");
          render();
          document.getElementById(`slot-card-${sid}`)?.scrollIntoView({ block: "nearest" });
        };
        jumpRow.append(inspectBtn);
        const targetSlot = snap.slots.find(s => s.slotId === sid);
        if (targetSlot && canOpenSlot(targetSlot)) jumpRow.append(openSlotButton(targetSlot));
        if (targetSlot?.delta?.changed?.length) {
          const diffBtn = el(
            "button",
            "btn btn-sm",
            targetSlot.delta.forbidViolations?.length || targetSlot.delta.outsideTouches?.length ? "查看越界文件" : "查看改动文件",
          );
          diffBtn.type = "button";
          diffBtn.onclick = () => {
            expandedSlotId = sid;
            if (isArchived(targetSlot)) openDetails.add("archived-members");
            peekTabs.set(sid, "files");
            diffViews.delete(sid);
            render();
            document.getElementById(`slot-card-${sid}`)?.scrollIntoView({ block: "nearest" });
          };
          jumpRow.append(diffBtn);
        }
        card.append(jumpRow);
      }
      section.append(card);
    }

    return section;
  };

  const render = () => {
    applyTheme();
    ensureDefaultExpanded();
    const scrollTop = root.querySelector(".studio-scroll")?.scrollTop ?? 0;
    const bodyScrollTop = document.body.scrollTop;
    const pageScrollTop = document.scrollingElement?.scrollTop ?? 0;
    const active = document.activeElement;
    const gateFocus = active instanceof HTMLInputElement && active.dataset.gateNoteInput === "1"
      ? { id: active.dataset.gateId, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection }
      : null;
    const artifactFocus = active instanceof HTMLElement ? active.dataset.artifactClose : undefined;

    const shell = el("div", "studio-shell");

    // 1. Studio Header Bar
    const tabbar = el("header", "studio-tabbar");
    const titleWrap = el("div", "studio-tab-title");
    titleWrap.append(
      el("span", "brand-mark"),
      el("span", "studio-brand-name", "Squad Studio"),
    );
    if (snapshot) {
      const sub = el("span", "studio-sub-title", snapshot.state.title);
      sub.title = snapshot.state.title;
      titleWrap.append(sub);
    }
    const metaWrap = el("div", "studio-tab-meta");
    if (snapshot) {
      metaWrap.append(el("span", "badge mono", `rev.${snapshot.state.revision}`));
      if (snapshot.status === "closed") {
        metaWrap.append(el("span", "badge mono", "已收束"));
      }
    }
    const refreshBtn = el("button", "btn btn-sm", "刷新");
    refreshBtn.type = "button";
    refreshBtn.dataset.action = "refresh";
    refreshBtn.disabled = pollingInFlight || busyAction;
    refreshBtn.onclick = () => void refreshSnapshot(false);

    const themeBtn = el(
      "button",
      "btn btn-sm",
      detectTheme() === "dark" ? "亮色" : "暗色",
    );
    themeBtn.type = "button";
    themeBtn.dataset.action = "toggle-theme";
    themeBtn.onclick = () => {
      themeOverride = detectTheme() === "dark" ? "light" : "dark";
      render();
    };
    metaWrap.append(refreshBtn, themeBtn);
    tabbar.append(titleWrap, metaWrap);
    shell.append(tabbar);

    if (!snapshot) {
      const empty = el("div", "studio-scroll");
      syncBanner(empty);
      empty.append(el("div", "studio-card muted-text", "正在等待小队状态快照…"));
      shell.append(empty);
      root.replaceChildren(shell);
      return;
    }

    // 2. Top Pinned Needs You Intercept Slot (0px when clear)
    shell.append(renderNeedsYou(snapshot));

    // 3. Scrollable STATE Canvas + Role Inspection Cards
    const scroll = el("main", "studio-scroll");

    syncBanner(scroll);

    const stateCard = el("section", "studio-card");
    stateCard.setAttribute("aria-label", "STATE 画布");
    const isVerified = (c: { verifiedBy?: string | null; verifiedAt?: number | null }) => Boolean(c.verifiedBy) || c.verifiedAt != null;
    const doneCriteria = snapshot.state.criteria.filter(isVerified).length;
    const totalCriteria = snapshot.state.criteria.length;
    const { integrationBranch, integrationWorktree } = snapshot;
    const integrations = Object.values(snapshot.integrations ?? {});
    const matchingBranches = integrations.filter(tree => tree.branch === integrationBranch);
    const mainRepo = integrations.find(tree => tree.worktreePath === integrationWorktree) ??
      snapshot.integrations?.default ?? (matchingBranches.length === 1 ? matchingBranches[0] : undefined);

    const stateHead = el("div", "studio-section-head");
    stateHead.append(el("span", "studio-section-title", "STATE 画布 · 判据"));
    const headBadges = el("div", "head-actions");
    if (integrationBranch && mainRepo?.branch !== integrationBranch) {
      headBadges.append(el("span", "badge mono repo-label", integrationBranch));
    }
    headBadges.append(
      el(
        "span",
        `badge mono${totalCriteria > 0 && doneCriteria === totalCriteria ? " badge-settled" : ""}`,
        `✓ ${doneCriteria}/${totalCriteria} 判据`,
      ),
    );
    stateHead.append(headBadges);
    stateCard.append(stateHead);
    if (integrations.length) {
      const badges = el("div", "integration-badges");
      badges.setAttribute("aria-label", "仓库集成分支");
      for (const tree of integrations) {
        const badge = el("span", "badge mono repo-label integration-badge", `${repoName(tree.source)} · ${tree.branch}`);
        badge.title = [tree.source, tree.branch, tree.worktreePath].join("\n");
        badges.append(badge);
      }
      stateCard.append(badges);
    }

    if (snapshot.state.intent) {
      stateCard.append(el("p", "intent-copy", snapshot.state.intent));
    }

    if (totalCriteria > 0) {
      const pendingList = el("div", "criteria-list");
      const completedList = el("div", "criteria-list");
      for (const crit of snapshot.state.criteria) {
        const done = isVerified(crit);
        const copy = criterionCopy(crit);
        const rowClass = `criterion-row${done ? " is-done" : ""}`;
        const row = copy.detail
          ? rememberedDetails(`${rowClass} criterion-with-detail`, `criterion:${crit.id}`, el("summary", "criterion-summary"))
          : el("div", rowClass);
        row.dataset.criterionId = crit.id;
        const header = row.firstElementChild ?? row;
        const left = el("span", "criterion-left");
        left.append(
          el("span", `criterion-check${done ? " is-done" : ""}`, done ? "✓" : "·"),
          el("span", "mono criterion-id", crit.id),
          el("span", "criterion-text", copy.title),
        );
        header.append(left);
        if (crit.verifiedBy) header.append(el("span", "mono criterion-verifier", crit.verifiedBy));
        if (row instanceof HTMLDetailsElement && copy.detail) {
          const detail = el("div", "criterion-detail-content");
          appendInline(detail, copy.detail);
          row.append(detail);
        }
        (done ? completedList : pendingList).append(row);
      }
      if (pendingList.childElementCount) stateCard.append(pendingList);
      if (completedList.childElementCount) {
        const completed = rememberedDetails("completed-criteria", "completed-criteria", el("summary", "", `已完成事项 (${doneCriteria})`));
        completed.append(completedList);
        stateCard.append(completed);
      }
    }

    const anchorSummary = el("div", "orchestrator-summary");
    anchorSummary.append(el("span", "brand-mark"), el("strong", "", "Orchestrator · 主会话"));
    const anchorBadge = modelSettingsBadge(snapshot.anchorSettings);
    if (anchorBadge) anchorSummary.append(anchorBadge);
    stateCard.append(anchorSummary);

    const totalContracts =
      snapshot.state.invariants.length + snapshot.state.contracts.length;
    if (totalContracts > 0) {
      const drawer = el("div", "contracts-drawer");
      const toggle = el("button", "contracts-toggle");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(contractsOpen));
      toggle.append(
        el(
          "span",
          "",
          `${contractsOpen ? "▾" : "▸"} 公共契约与铁律 (${totalContracts} 条)`,
        ),
        el("span", "mono muted-text", contractsOpen ? "收起" : "按需展开"),
      );
      toggle.onclick = () => {
        contractsOpen = !contractsOpen;
        render();
      };
      drawer.append(toggle);
      if (contractsOpen) {
        const ul = el("ul", "contracts-list");
        for (const inv of snapshot.state.invariants) {
          ul.append(el("li", "", `[铁律] ${inv}`));
        }
        for (const ct of snapshot.state.contracts) {
          ul.append(el("li", "", ct));
        }
        drawer.append(ul);
      }
      stateCard.append(drawer);
    }
    scroll.append(stateCard);

    const { anchorSettings, slots, state } = snapshot;
    const renderRoleCard = (slot: SquadSlotLiveView) => {
      const expanded = expandedSlotId === slot.slotId;
      const archived = isArchived(slot);
      const hasAttn = needsSlotAttention(slot);
      const card = el(
        "article",
        `role-card${expanded ? " is-expanded" : ""}${hasAttn ? " has-attention" : ""}`,
      );
      card.id = `slot-card-${slot.slotId}`;
      card.dataset.slotId = slot.slotId;

      const summaryBtn = el("button", "role-card-summary");
      summaryBtn.type = "button";
      summaryBtn.setAttribute("aria-expanded", String(expanded));
      summaryBtn.onclick = () => {
        expandedSlotId = expanded ? null : slot.slotId;
        render();
        document.getElementById(card.id)?.querySelector<HTMLElement>(".role-card-summary")?.focus({ preventScroll: true });
      };

      const topRow = el("span", "role-row-top");
      const ident = el("span", "role-ident");
      const dot = el("span", "status-dot");
      dot.dataset.state = slotDotState(slot);
      const handle = el("span", "role-handle mono", slot.handle);
      const settingsBadge = modelSettingsBadge(slot);
      handle.title = [slot.handle, settingsBadge?.title].filter(Boolean).join(" · ");
      ident.append(dot, handle);
      const matchesAnchor = anchorSettings &&
        shortModelName(modelName(slot)) === shortModelName(modelName(anchorSettings)) &&
        modelEffort(slot) === modelEffort(anchorSettings);
      if (settingsBadge && (expanded || !matchesAnchor)) ident.append(settingsBadge);
      if (slot.dependsOn.length) {
        const dependency = `↳ after ${slot.dependsOn.join(", ")}`;
        const label = el("span", "role-dependency mono", dependency);
        label.title = dependency;
        ident.append(label);
      }
      if (slot.continuity === "clean") {
        ident.append(el("span", "badge mono badge-clean", "clean"));
      }

      const metrics = el("span", "role-metrics mono");
      const current = slot.rounds?.at(-1);
      const totalRounds = slot.rounds?.length ?? 0;
      metrics.append(
        ...(current ? [el("span", `badge mono${totalRounds > 1 ? " badge-wave" : ""}`, totalRounds > 1 ? `R${current.round}/${totalRounds}` : `R${current.round}`)] : []),
        el("span", "", slotActivityLabel(slot)),
        el("span", "role-chevron", expanded ? "▾" : "▸"),
      );
      if (!archived && slot.activity === "active") metrics.append(el("span", "role-elapsed", formatDuration(slot.elapsedMs)));
      if ((!archived || expanded) && slot.contextPercent != null) {
        metrics.append(el("span", "", `· ctx ${Math.round(slot.contextPercent)}%`));
      }
      topRow.append(ident, metrics);
      summaryBtn.append(topRow);
      const annotations = el("span", "role-annotations");
      const source = slot.repo?.source;
      if (source && source !== mainRepo?.source && (!mainRepo || slot.repoKey !== mainRepo.repoKey)) {
        const repo = el("span", "badge mono repo-label role-repo-badge", `repo: ${repoName(source)}`);
        repo.title = [source, slot.branch ?? slot.repo?.branch].filter(Boolean).join(" · ");
        annotations.append(repo);
      }
      const violations = slot.delta?.forbidViolations;
      if (violations?.length) {
        const warning = el("span", "badge badge-danger mono", `${violations.length} 处触碰禁区`);
        warning.title = violations.join("\n");
        annotations.append(warning);
      }
      const dirtyCount = slot.delta?.dirtyCount ?? 0;
      if (slot.activity !== "active" && slot.stage !== "running" && dirtyCount > 0) {
        annotations.append(el("span", "badge badge-attention mono", `${dirtyCount} 个未提交改动`));
      }
      const outside = slot.delta?.outsideTouches?.length ?? 0;
      if (outside && (!archived || expanded)) annotations.append(el("span", "badge badge-danger mono", `${outside} 个文件越界`));
      if (annotations.childElementCount) summaryBtn.append(annotations);
      card.append(summaryBtn);
      if (!expanded) {
        const receipt = hasReceipt(slot.result);
        const goal = current?.goal ?? state.tasks.find(t => t.slotId === slot.slotId)?.goal ?? "";
        const rawPreview = receipt ? outcome(slot.result) || "已收到回执，未提供可预览的结论。" : cleanGoal(goal);
        if (rawPreview) {
          const previewNode = el("div", "role-preview");
          previewNode.append(el("span", "role-preview-label", receipt ? "结论" : "目标"), " ");
          appendInlineExcerpt(previewNode, rawPreview, 140);
          card.append(previewNode);
        }
        const cardOutputs = cardOutputsFor(slot.deliverables ?? [], archived);
        if (cardOutputs.length) {
          const outputRow = el("div", "role-card-outputs");
          outputRow.append(renderDeliverables(slot.slotId, cardOutputs, true));
          card.append(outputRow);
        }
      } else {
        card.append(renderRolePeek(slot));
      }
      return card;
    };

    const activeSlots = slots.filter(slot => !isArchived(slot)).sort((a, b) => slotPriority(a) - slotPriority(b));
    const archived = slots.filter(isArchived);
    if (activeSlots.length || !archived.length) {
      const rolesHeader = el("div", "studio-section-head roles-head");
      rolesHeader.append(el("span", "studio-section-title", `当前成员 (${activeSlots.length})`));
      const roleList = el("div", "role-card-list");
      if (activeSlots.length) roleList.append(...activeSlots.map(renderRoleCard));
      else roleList.append(el("div", "studio-card muted-text", "尚未派发任务槽位。"));
      scroll.append(rolesHeader, roleList);
    }
    if (archived.length) {
      const archive = rememberedDetails("archived-members", "archived-members", el("summary", "", `已归档成员 (${archived.length})`));
      const archivedList = el("div", "role-card-list");
      archivedList.append(...archived.map(renderRoleCard));
      archive.append(archivedList);
      scroll.append(archive);
    }
    shell.append(scroll);
    root.replaceChildren(shell);
    scroll.scrollTop = scrollTop;
    document.body.scrollTop = bodyScrollTop;
    if (document.scrollingElement) document.scrollingElement.scrollTop = pageScrollTop;
    if (gateFocus) {
      const input = root.querySelector<HTMLInputElement>("[data-gate-note-input]");
      if (input && input.dataset.gateId === gateFocus.id && !input.disabled) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(gateFocus.start, gateFocus.end, gateFocus.direction ?? undefined);
      }
    } else if (artifactFocus) {
      document.getElementById(`slot-card-${artifactFocus}`)?.querySelector<HTMLElement>("[data-artifact-close]")?.focus({ preventScroll: true });
    }
  };

  render();

  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onMediaChange = () => {
    if (!themeOverride && !disposed) render();
  };
  media?.addEventListener?.("change", onMediaChange);

  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void refreshSnapshot(true);
    }
  }, 2500);

  const onVisibility = () => {
    if (document.visibilityState === "visible") void refreshSnapshot(true);
  };
  document.addEventListener("visibilitychange", onVisibility);

  window.addEventListener(
    "pagehide",
    () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      media?.removeEventListener?.("change", onMediaChange);
    },
    { once: true },
  );
}

const STUDIO_CSS = `
:root, [data-theme="light"] {
  color-scheme: light;
  --bg-studio: #F9F9F8;
  --bg-header: #F6F5F2;
  --bg-elevated: #FFFFFF;
  --bg-subtle: #F2F1ED;
  --bg-hover: #EAE8E2;
  --bg-code: #F4F5F7;
  --border-hairline: #E4E2DC;
  --border-default: #D5D2CA;
  --border-strong: #B8B4AA;
  --text-primary: #17191C;
  --text-secondary: #4A4F57;
  --text-muted: #656B75;
  --text-on-accent: #FFFFFF;
  --accent-solid: #1B5488;
  --accent-hover: #14426C;
  --accent-text: #184D7D;
  --accent-soft: #EBF2F9;
  --accent-border: #B7D1EA;
  --focus-ring: rgba(27, 84, 136, 0.38);
  --status-running-dot: #1D74B8;
  --status-settled-dot: #1E7E4E;
  --status-settled-text: #16653E;
  --status-settled-bg: #EAF6F0;
  --status-settled-border: #B7E1CA;
  --status-attention-dot: #C06C14;
  --status-attention-text: #8D4D08;
  --status-attention-bg: #FDF4E7;
  --status-attention-border: #ECC996;
  --status-danger-dot: #C43B31;
  --status-danger-text: #9C2B23;
  --status-danger-bg: #FCEEEB;
  --status-danger-border: #EEBDB8;
  --status-idle-dot: #8A9099;
  --diff-add-bg: #E8F6EE;
  --diff-add-ln: #D2EEDE;
  --diff-add-text: #145936;
  --diff-del-bg: #FCECE9;
  --diff-del-ln: #F7D7D2;
  --diff-del-text: #94261E;
  --shadow-card: 0 1px 3px rgba(20, 24, 30, 0.05);
}
[data-theme="dark"] {
  color-scheme: dark;
  --bg-studio: #14171D;
  --bg-header: #12151A;
  --bg-elevated: #1B1F27;
  --bg-subtle: #20252F;
  --bg-hover: #262C37;
  --bg-code: #111419;
  --border-hairline: #252A34;
  --border-default: #303744;
  --border-strong: #434C5E;
  --text-primary: #ECEFF4;
  --text-secondary: #ABB3C2;
  --text-muted: #858E9E;
  --text-on-accent: #0C1117;
  --accent-solid: #63A9E5;
  --accent-hover: #7DB9EC;
  --accent-text: #7CB8EC;
  --accent-soft: rgba(99, 169, 229, 0.14);
  --accent-border: rgba(99, 169, 229, 0.36);
  --focus-ring: rgba(99, 169, 229, 0.45);
  --status-running-dot: #54A6EB;
  --status-settled-dot: #47B881;
  --status-settled-text: #73D1A1;
  --status-settled-bg: rgba(71, 184, 129, 0.14);
  --status-settled-border: rgba(71, 184, 129, 0.34);
  --status-attention-dot: #E5993E;
  --status-attention-text: #F2B56B;
  --status-attention-bg: rgba(229, 153, 62, 0.15);
  --status-attention-border: rgba(229, 153, 62, 0.38);
  --status-danger-dot: #E5645A;
  --status-danger-text: #F28B82;
  --status-danger-bg: rgba(229, 100, 90, 0.15);
  --status-danger-border: rgba(229, 100, 90, 0.36);
  --status-idle-dot: #6C7584;
  --diff-add-bg: rgba(56, 168, 109, 0.15);
  --diff-add-ln: rgba(56, 168, 109, 0.24);
  --diff-add-text: #85DCA9;
  --diff-del-bg: rgba(224, 93, 83, 0.15);
  --diff-del-ln: rgba(224, 93, 83, 0.24);
  --diff-del-text: #F49B94;
  --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.28);
}
*, *::before, *::after { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; width: 100%; height: 100%;
  overflow-x: hidden;
  background: var(--bg-studio);
  color: var(--text-primary);
  font: 12.5px/1.45 "SF Pro Text", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
  -webkit-font-smoothing: antialiased;
}
button, input { font: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled { opacity: 0.48; cursor: default; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.mono { font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
.muted-text { color: var(--text-muted); font-size: 11px; }
.danger-text { color: var(--status-danger-text); font-size: 11.5px; }
.text-add { color: var(--status-settled-text); }
.text-del { color: var(--status-danger-text); }

#squad-studio-root, .studio-shell {
  display: flex; flex-direction: column; width: 100%; min-height: 100vh; min-width: 0; overflow-x: hidden;
}
.studio-tabbar {
  min-height: 40px; padding: 6px 12px; background: var(--bg-header);
  border-bottom: 1px solid var(--border-hairline);
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; min-width: 0;
}
.studio-tab-title {
  display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1;
}
.studio-brand-name { font-weight: 600; font-size: 12px; flex-shrink: 0; }
.studio-sub-title {
  color: var(--text-secondary); font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.studio-tab-meta, .head-actions, .btn-group {
  display: inline-flex; align-items: center; gap: 5px; flex-wrap: wrap; flex-shrink: 0;
}
.brand-mark {
  width: 8px; height: 8px; border-radius: 2px; background: var(--accent-solid); flex-shrink: 0; display: inline-block;
}
.badge {
  display: inline-flex; align-items: center; gap: 4px; height: 19px; padding: 0 6px;
  border-radius: 4px; font-size: 10.5px; font-weight: 500;
  border: 1px solid var(--border-hairline); background: var(--bg-elevated); color: var(--text-secondary);
  white-space: nowrap;
}
.model-settings-badge { min-width: 0; max-width: min(100%, 240px); flex-shrink: 1; gap: 0; }
.model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.model-separator { flex-shrink: 0; white-space: pre; }
.model-effort { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.badge-stateful { color: var(--accent-text); background: var(--accent-soft); border-color: var(--accent-border); }
.badge-clean { border-style: dashed; border-color: var(--border-strong); background: transparent; color: var(--text-secondary); }
.badge-settled { color: var(--status-settled-text); background: var(--status-settled-bg); border-color: var(--status-settled-border); }
.badge-attention { color: var(--status-attention-text); background: var(--status-attention-bg); border-color: var(--status-attention-border); }
.badge-danger { color: var(--status-danger-text); background: var(--status-danger-bg); border-color: var(--status-danger-border); }

.btn {
  height: 25px; padding: 0 9px; border-radius: 5px; border: 1px solid var(--border-default);
  background: var(--bg-elevated); color: var(--text-primary); font-size: 11.5px; font-weight: 500;
  display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
.btn-sm { height: 22px; padding: 0 7px; font-size: 11px; border-radius: 4px; }
.btn-primary { background: var(--accent-solid); border-color: var(--accent-solid); color: var(--text-on-accent); font-weight: 600; }
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }

.needs-you-slot {
  background: var(--status-attention-bg); border-bottom: 1px solid var(--status-attention-border);
  padding: 9px 12px; display: flex; flex-direction: column; gap: 7px; min-width: 0;
}
.needs-you-slot[hidden] {
  display: none !important; height: 0 !important; padding: 0 !important; margin: 0 !important; border: 0 !important;
}
.needs-you-head {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  font-size: 11px; font-weight: 700; color: var(--status-attention-text);
}
.needs-you-item {
  background: var(--bg-elevated); border: 1px solid var(--status-attention-border);
  border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; min-width: 0;
}
.gate-head-row, .gate-actions {
  display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap;
}
.gate-title { font-size: 12px; color: var(--text-primary); }
.gate-question { font-size: 11.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
.gate-options { display: flex; flex-direction: column; gap: 5px; }
.gate-option {
  display: flex; align-items: flex-start; gap: 7px; padding: 7px 9px; border-radius: 5px;
  border: 1px solid var(--border-hairline); background: var(--bg-studio); text-align: left; width: 100%; min-width: 0;
}
.gate-option:hover { border-color: var(--border-strong); }
.gate-option.is-selected { border-color: var(--accent-solid); background: var(--accent-soft); }
.gate-radio { color: var(--accent-text); font-weight: 700; flex-shrink: 0; }
.gate-option-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.gate-option-label { font-size: 11.5px; font-weight: 600; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.gate-option-summary { font-size: 11px; color: var(--text-secondary); overflow-wrap: anywhere; }
.gate-note-input {
  width: 100%; height: 27px; padding: 0 8px; border-radius: 4px;
  border: 1px solid var(--border-default); background: var(--bg-studio); font-size: 11.5px;
}

.studio-scroll {
  flex: 1; padding: 10px 12px 18px; display: flex; flex-direction: column; gap: 11px; min-width: 0; overflow-x: hidden;
}
.status-banner {
  padding: 5px 9px; border-radius: 5px; background: var(--accent-soft); border: 1px solid var(--accent-border);
  color: var(--accent-text); font-size: 11px; overflow-wrap: anywhere;
}
.status-banner.is-error {
  background: var(--status-danger-bg); border-color: var(--status-danger-border); color: var(--status-danger-text);
}
.studio-card {
  background: var(--bg-elevated); border: 1px solid var(--border-hairline); border-radius: 8px;
  padding: 10px 11px; display: flex; flex-direction: column; gap: 8px; min-width: 0;
}
.studio-section-head {
  display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; min-width: 0;
}
.studio-section-head .head-actions { max-width: 100%; min-width: 0; }
.integration-badges, .role-annotations {
  display: flex; flex-wrap: wrap; align-items: center; gap: 5px; max-width: 100%; min-width: 0;
}
.repo-label { display: inline-block; line-height: 17px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.roles-head { padding: 0 2px; }
.studio-section-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);
}
.intent-copy { margin: 0; font-size: 11.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
.criteria-list { display: flex; flex-direction: column; gap: 4px; }
.criterion-row {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  font-size: 11.5px; padding: 4px 6px; border-radius: 4px; background: var(--bg-studio); min-width: 0;
}
.criterion-left { display: flex; align-items: flex-start; gap: 5px; min-width: 0; flex: 1 1 210px; overflow-wrap: anywhere; }
.criterion-id { flex-shrink: 0; white-space: nowrap; overflow-wrap: normal; font-size: 9.5px; font-weight: 400; color: var(--text-muted); padding: 0 4px; border: 1px solid var(--border-hairline); border-radius: 3px; background: var(--bg-subtle); }
.criterion-text { min-width: 0; flex: 1; overflow-wrap: anywhere; font-weight: 550; color: var(--text-primary); }
.criterion-with-detail { display: block; }
.criterion-summary { display: flex; align-items: flex-start; gap: 5px; flex-wrap: wrap; cursor: pointer; list-style: none; }
.criterion-summary::-webkit-details-marker { display: none; }
.criterion-summary::before { content: "▸"; color: var(--text-muted); flex-shrink: 0; }
.criterion-with-detail[open] > .criterion-summary::before { content: "▾"; }
.criterion-detail-content { margin: 7px 0 2px 16px; font-size: 11px; line-height: 1.6; color: var(--text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
.criterion-verifier { max-width: 100%; overflow-wrap: anywhere; }
.completed-criteria { min-width: 0; font-size: 11px; color: var(--text-secondary); }
.completed-criteria > summary { cursor: pointer; padding: 4px 6px; white-space: nowrap; }
.completed-criteria[open] > summary { margin-bottom: 4px; }
.criterion-check { font-family: monospace; font-weight: 700; width: 12px; flex-shrink: 0; }
.criterion-check.is-done, .criterion-verifier { color: var(--status-settled-text); flex-shrink: 0; font-size: 10.5px; }

.orchestrator-summary {
  display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 11px; color: var(--text-secondary);
}

.contracts-drawer { border-top: 1px solid var(--border-hairline); padding-top: 6px; }
.contracts-toggle {
  width: 100%; background: transparent; border: 0; padding: 2px 0;
  display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--text-secondary);
}
.contracts-list {
  margin: 5px 0 0; padding-left: 16px; display: flex; flex-direction: column; gap: 3px;
  font-size: 11px; color: var(--text-secondary); overflow-wrap: anywhere;
}

.status-dot {
  width: 12px; height: 12px; display: inline-flex; align-items: center; justify-content: center; position: relative; flex-shrink: 0;
}
.status-dot::after { content: ""; width: 6px; height: 6px; border-radius: 999px; background: var(--status-idle-dot); }
.status-dot[data-state="active"]::after { background: var(--status-running-dot); }
.status-dot[data-state="active"]::before {
  content: ""; position: absolute; width: 6px; height: 6px; border-radius: 999px;
  background: var(--status-running-dot); animation: studioPulse 2000ms cubic-bezier(0.25, 0.8, 0.25, 1) infinite;
}
.status-dot[data-state="quiescent"]::after { background: var(--status-settled-dot); }
.status-dot[data-state="waiting"]::after, .status-dot[data-state="escalate"]::after { background: var(--status-attention-dot); }
.status-dot[data-state="offline"]::after { background: var(--text-muted); }
.status-dot[data-state="failed"]::after { background: var(--status-danger-dot); }
@keyframes studioPulse { 0% { transform: scale(1); opacity: 0.6; } 100% { transform: scale(2.3); opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .status-dot[data-state="active"]::before { animation: none; transform: scale(1.75); opacity: 0.28; }
}

.role-card-list { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.archived-members { border-top: 1px solid var(--border-hairline); min-width: 0; }
.archived-members > summary { padding: 6px 0; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.archived-members article:not(.is-expanded) .role-card-summary { padding-block: 6px; }
.archived-members article:not(.is-expanded) .role-preview { font-size: 11.5px; }
.role-card {
  background: var(--bg-elevated); border: 1px solid var(--border-hairline); border-radius: 8px; overflow: hidden; min-width: 0;
}
.role-card.is-expanded { border-color: var(--accent-border); box-shadow: var(--shadow-card); }
.role-card.has-attention { border-color: var(--status-attention-border); }
.role-card-summary {
  cursor: pointer;
  width: 100%; padding: 9px 11px; background: transparent; border: 0; text-align: left;
  display: flex; flex-direction: column; gap: 6px; min-width: 0;
}
.badge-wave { color: var(--accent-text); background: var(--accent-soft); border-color: var(--accent-border); font-weight: 600; }
.deliverable-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; min-width: 0; }
.role-card-outputs { padding: 0 11px 9px; min-width: 0; }
.role-card-outputs.is-inline { padding: 0; }
.role-preview { color: var(--text-secondary); font-size: 12px; line-height: 1.55; margin: 0 11px 8px; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.role-preview-label { font-size: 10.5px; font-weight: 600; color: var(--text-muted); margin-inline-end: 6px; }
.inline-link { color: var(--accent-text); text-underline-offset: 2px; }
.deliverable-chip {
  display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-width: 0;
  border: 1px solid var(--border-default); border-radius: 5px; padding: 2px 7px;
  font-size: 11px; line-height: 1.4; color: var(--text-primary); background: var(--bg-subtle);
  text-decoration: none; vertical-align: middle;
}
.deliverable-chip:is(.is-link, .is-preview) {
  color: var(--accent-text); background: var(--accent-soft); border-color: var(--accent-border); cursor: pointer;
}
.deliverable-chip:is(.is-link, .is-preview):hover { border-color: var(--accent-solid); text-decoration: underline; }
.chip-kind {
  font-size: 10px; font-weight: 600; color: var(--text-muted);
  padding-right: 5px; border-right: 1px solid var(--border-hairline); flex-shrink: 0;
}
.deliverable-chip:is(.is-link, .is-preview) .chip-kind { color: var(--accent-text); border-right-color: var(--accent-border); }
.chip-sha { font-size: 10.5px; color: var(--text-secondary); flex-shrink: 0; }
.chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 26ch; }
.chip-ext { font-size: 10px; flex-shrink: 0; opacity: 0.85; }
.deliverable-more { font-size: 10.5px; color: var(--text-muted); padding: 1px 5px; border-radius: 4px; background: var(--bg-subtle); border: 1px solid var(--border-hairline); }
.deliverables-list, .round-record, .current-round { min-width: 0; overflow-wrap: anywhere; }
.deliverable-row { display: grid; grid-template-columns: 54px minmax(0, 1fr); align-items: baseline; gap: 4px 8px; padding: 7px 0; border-bottom: 1px solid var(--border-hairline); min-width: 0; }
.deliverable-row:last-child { border-bottom: 0; }
.deliverable-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.deliverable-title-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; min-width: 0; }
.deliverable-row .deliverable-chip { display: inline; padding: 0; border: 0; background: none; max-width: 100%; white-space: normal; font-size: 12.5px; font-weight: 600; color: var(--text-primary); }
.deliverable-row .deliverable-chip:is(.is-link, .is-preview) { color: var(--accent-text); text-align: start; overflow-wrap: anywhere; }
.deliverable-sha { font-size: 10.5px; color: var(--text-secondary); }
.deliverable-kind { color: var(--text-muted); font-size: 11px; white-space: nowrap; }
.deliverable-detail { margin: 0; line-height: 1.45; }
.deliverable-target { display: block; min-width: 0; overflow-wrap: anywhere; font-size: 11px; margin: 5px 0; }
.delivery-heading { margin: 6px 0 0; font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: 0.03em; }
.evidence-drawer { border-top: 1px solid var(--border-hairline); padding-top: 7px; min-width: 0; }
.evidence-drawer > summary { cursor: pointer; font-size: 11.5px; color: var(--text-secondary); }
.evidence-drawer[open] > summary { margin-bottom: 8px; }
.current-round { padding: 2px 0 8px; border-bottom: 1px solid var(--border-hairline); display: flex; flex-direction: column; gap: 5px; }
.current-round-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.current-round-title { font-size: 11.5px; }
.round-criteria { margin-left: auto; }
.round-kv { display: grid; grid-template-columns: 32px minmax(0, 1fr); align-items: baseline; gap: 6px; min-width: 0; }
.round-field-label { font-size: 10.5px; font-weight: 600; color: var(--text-muted); white-space: nowrap; }
.current-round-goal { font-size: 11.5px; color: var(--text-secondary); }
.round-goal-inline { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; line-height: 1.5; }
.round-goal { margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--text-secondary); }
.round-history { border: 1px solid var(--border-hairline); border-radius: 6px; background: var(--bg-elevated); padding: 7px 9px; min-width: 0; }
.round-history > summary { cursor: pointer; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; list-style: none; display: flex; flex-direction: column; gap: 5px; }
.round-history > summary::-webkit-details-marker { display: none; }
.history-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
.history-head-left { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.history-chevron::before { content: "展开 ▸"; font-size: 10.5px; }
.round-history[open] > summary .history-chevron::before { content: "收起 ▾"; }
.history-meta { color: var(--text-muted); font-size: 11px; }
.history-outcome { display: block; color: var(--text-primary); font-size: 11.5px; line-height: 1.5; }
.round-history:not([open]) .history-outcome { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.round-record { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-hairline); display: flex; flex-direction: column; gap: 7px; }
.round-file { overflow-wrap: anywhere; font-size: 11px; }
.role-card-summary:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.role-card-summary:hover { background: var(--bg-hover); }
.role-row-top { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px; width: 100%; min-width: 0; }
.role-ident { display: flex; align-items: center; gap: 5px; min-width: 0; }
.role-ident .model-settings-badge { max-width: 55%; }
.role-handle, .role-dependency { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.role-handle { font-weight: 600; font-size: 12px; }
.role-dependency { max-width: 45%; font-size: 10px; color: var(--text-muted); }
.role-metrics { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-muted); white-space: nowrap; }
.role-elapsed { font-variant-numeric: tabular-nums; }
.role-chevron { color: var(--text-muted); font-size: 10px; }

.role-peek-panel {
  border-top: 1px solid var(--border-hairline); background: var(--bg-studio); padding: 10px 11px;
  display: flex; flex-direction: column; gap: 8px; min-width: 0;
}
.slot-boundaries {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 8px; margin: 0;
  padding: 6px 8px; border: 1px solid var(--border-hairline); border-radius: 5px;
  font-size: 11px; color: var(--text-secondary);
}
.slot-boundaries dt { color: var(--text-muted); }
.slot-boundaries dd { margin: 0; overflow-wrap: anywhere; }
.peek-tabs { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; }
.peek-tab-list { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.peek-actions { display: inline-flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-left: auto; }
.peek-tab {
  height: 22px; padding: 0 8px; border-radius: 4px; border: 1px solid var(--border-hairline);
  background: var(--bg-elevated); color: var(--text-secondary); font-size: 11px;
}
.peek-tab.is-active { background: var(--accent-soft); border-color: var(--accent-border); color: var(--accent-text); font-weight: 600; }
.result-summary-head { align-items: baseline; }
.result-summary-text { font-size: 12.5px; line-height: 1.6; overflow-wrap: anywhere; }
.markdown-body { min-width: 0; font-size: 12px; line-height: 1.65; color: var(--text-secondary); overflow-wrap: anywhere; }
.markdown-body > :first-child { margin-top: 0; }
.markdown-body > :last-child { margin-bottom: 0; }
.markdown-body h1, .markdown-body h2, .markdown-body h3 { color: var(--text-primary); line-height: 1.4; margin: 16px 0 7px; font-weight: 650; }
.markdown-body h1 { font-size: 17px; }
.markdown-body h2 { font-size: 14px; }
.markdown-body h3 { font-size: 12.5px; }
.markdown-body p { margin: 8px 0; white-space: pre-wrap; }
.markdown-body ul, .markdown-body ol { padding-left: 22px; margin: 8px 0; }
.markdown-body li { margin: 4px 0; white-space: pre-wrap; }
.md-inline-code { font-family: "SF Mono", Menlo, monospace; font-size: .92em; padding: 1px 4px; border-radius: 4px; background: var(--bg-code); border: 1px solid var(--border-hairline); white-space: pre-wrap; overflow-wrap: anywhere; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.md-code-block { min-width: 0; margin: 10px 0; padding: 10px 12px; border-radius: 6px; background: var(--bg-code); border: 1px solid var(--border-hairline); white-space: pre-wrap; overflow-wrap: anywhere; font: 11.5px/1.6 "SF Mono", Menlo, monospace; }
.assumptions-callout {
  padding: 8px 10px; border-radius: 5px; background: var(--status-attention-bg);
  border: 1px solid var(--status-attention-border); display: flex; flex-direction: column; gap: 4px; min-width: 0;
}
.assumptions-callout-title {
  font-size: 11px; font-weight: 700; color: var(--status-attention-text);
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
}
.assumptions-list { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 3px; font-size: 11.5px; overflow-wrap: anywhere; }
.file-list { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.file-row-btn {
  width: 100%; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border-hairline);
  background: var(--bg-elevated); display: flex; align-items: center; justify-content: space-between; gap: 8px;
  text-align: left; font-size: 11px; min-width: 0;
}
.file-row-btn:hover { border-color: var(--accent-border); background: var(--bg-hover); }
.file-row-left { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.file-status { font-weight: 700; color: var(--accent-text); flex-shrink: 0; }
.file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.file-row-right { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; }

.native-diff-box {
  border: 1px solid var(--border-default); border-radius: 5px; background: var(--bg-code); overflow: hidden; min-width: 0;
}
.native-diff-head {
  padding: 6px 8px; background: var(--bg-elevated); border-bottom: 1px solid var(--border-hairline);
  display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; min-width: 0;
}
.diff-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.diff-empty { padding: 10px; }
.diff-table { width: 100%; border-collapse: collapse; font-family: "SF Mono", "JetBrains Mono", Menlo, monospace; font-size: 11px; line-height: 1.48; table-layout: fixed; }
.diff-table td { padding: 1px 5px; vertical-align: top; }
.diff-ln { width: 32px; text-align: right; color: var(--text-muted); user-select: none; border-right: 1px solid var(--border-hairline); }
.diff-code { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
.diff-row-add .diff-ln { background: var(--diff-add-ln); color: var(--diff-add-text); }
.diff-row-add .diff-code { background: var(--diff-add-bg); color: var(--diff-add-text); }
.diff-row-del .diff-ln { background: var(--diff-del-ln); color: var(--diff-del-text); }
.diff-row-del .diff-code { background: var(--diff-del-bg); color: var(--diff-del-text); }
.diff-row-meta .diff-code { color: var(--accent-text); background: var(--bg-subtle); }
.artifact-note { margin: 6px 8px; overflow-wrap: anywhere; }
.artifact-markdown { padding: 8px; background: var(--bg-elevated); }
.artifact-text { margin: 0; border: 0; }
.brief-markdown { padding: 10px 12px; border-radius: 6px; background: var(--bg-elevated); border: 1px solid var(--border-hairline); }
`;

/**
 * Pure browser HTML view served at `/squads/<id>?token=...` for the native right
 * split-pane. Hydrates `#squad-studio-boot` immediately and interacts with same-origin
 * `/snapshot`, `/diff`, `/artifact`, `/gate`, `/promote`, and `/open-thread` endpoints.
 */
export function renderSquadStudioHtml(initial?: SquadStudioSnapshot): string {
  const boot = initial
    ? JSON.stringify(initial)
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029")
    : "null";
  const script = `(${mountSquadStudio.toString()})()`.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Squad Studio</title><style>${STUDIO_CSS}</style></head><body><div id="squad-studio-root"></div><script id="squad-studio-boot" type="application/json">${boot}</script><script type="module">${script}</script></body></html>`;
}
