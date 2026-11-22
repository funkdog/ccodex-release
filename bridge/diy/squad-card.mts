import type {
  SquadGate,
  SquadCardReview,
  SquadStudioSnapshot,
} from "../../gateway/spine/squad-v2-contracts.mjs";

export const SQUAD_CARD_URI = "ui://mycodex/squad-card-v2.html";
export const SQUAD_CARD_MIME = "text/html;profile=mcp-app";

export function mountConversationSquadCard() {
  type ToolResult = {
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  type LegacyHost = {
    toolOutput?: unknown;
    toolInput?: { squadId?: string };
    theme?: string;
    callTool?(name: string, args: object): Promise<ToolResult>;
    sendFollowUpMessage?(value: { prompt: string }): Promise<unknown>;
  };

  const legacy = () => (window as Window & { openai?: LegacyHost }).openai;
  const root = document.querySelector<HTMLElement>("#squad-card");
  if (!root) return;

  const pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  let boundSquadId: string | null = null;
  let snapshot: SquadStudioSnapshot | null = null;
  let review: SquadCardReview | null = null;
  let criteriaExpanded = false;
  let connected = false;
  let disposed = false;
  let busy = false;
  let failed = false;
  let initialReadStarted = false;
  let initialReadTimer: ReturnType<typeof setTimeout> | undefined;
  let status = "正在接入协作小队里程碑…";
  let capabilities: Record<string, unknown> = {};
  let resize: ResizeObserver | null = null;
  const openCriterionDetails = new Set<string>();
  const selectedOptions = new Map<string, string>();
  const noteDrafts = new Map<string, string>();

  const notify = (method: string, params: object = {}) => {
    if (!disposed && window.parent !== window) {
      window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
    }
  };

  const request = (method: string, params: object) =>
    new Promise<unknown>((resolve, reject) => {
      if (disposed || pending.size >= 8 || window.parent === window) {
        reject(new Error("当前对话的小队卡片连接不可用。"));
        return;
      }
      const id = `squad-card:${crypto.randomUUID()}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("请求回执尚未确认，请先刷新状态核对；没有自动重试。"));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    });

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

  // Keep these helpers local: the mount function is serialized into the browser.
  const stripListMarker = (text: string): string => text.trim().replace(/^(?:[-*•]|\d+\.)\s+/, "");
  const appendInline = (parent: HTMLElement, text: string): void => {
    const tokens = /`([^`\n]+)`|\*\*([^\n]+?)\*\*|(?<![\w:/])\/(?:[^/\s`*<>"'，。；：()[\]{}]+\/){2,}[^/\s`*<>"'，。；：()[\]{}]+/g;
    let offset = 0;
    for (const match of text.matchAll(tokens)) {
      parent.append(el("span", "", text.slice(offset, match.index)));
      if (match[2] !== undefined) {
        const strong = el("strong");
        appendInline(strong, match[2]);
        parent.append(strong);
      } else {
        const code = el("code", "md-inline-code", match[1] ?? match[0]);
        code.title = code.textContent ?? "";
        parent.append(code);
      }
      offset = match.index + match[0].length;
    }
    parent.append(el("span", "", text.slice(offset)));
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

  const decode = (result: ToolResult): Record<string, unknown> => {
    if (result.isError) {
      throw new Error(
        result.content?.find(item => item.type === "text")?.text || "小队操作未完成。",
      );
    }
    const rawText = result.content?.find(item => item.type === "text")?.text;
    const parsed = result.structuredContent ?? (rawText ? JSON.parse(rawText) : null);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("小队服务未返回有效状态快照。");
    }
    return parsed as Record<string, unknown>;
  };

  const isValidSquadId = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);

  const accept = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as SquadStudioSnapshot;
    if (
      !isValidSquadId(candidate.squadId) ||
      !candidate.state ||
      candidate.state.schemaVersion !== 2 ||
      !Number.isSafeInteger(candidate.state.revision) ||
      candidate.state.revision < 1 ||
      !Array.isArray(candidate.slots) ||
      !Array.isArray(candidate.state.criteria)
    ) {
      return false;
    }
    if (boundSquadId && candidate.squadId !== boundSquadId) return false;
    if (snapshot && candidate.state.revision < snapshot.state.revision) return false;
    // Editorial content belongs to this presentation. Background refreshes
    // carry only a snapshot and must not erase the main session's synthesis.
    if (Object.hasOwn(candidate, "review")) {
      const offered = (candidate as SquadStudioSnapshot & { review?: SquadCardReview }).review;
      if (!offered || typeof offered !== "object" || Array.isArray(offered) ||
          (offered.summary !== undefined && (typeof offered.summary !== "string" || offered.summary.length > 500)) ||
          (offered.highlights !== undefined && (!Array.isArray(offered.highlights) || offered.highlights.length > 6 || offered.highlights.some(item => !item || typeof item.title !== "string" || !item.title.trim() || typeof item.body !== "string" || !item.body.trim())))) return false;
      review = offered;
    }
    boundSquadId = candidate.squadId;
    snapshot = candidate;
    initialReadStarted = true;
    clearTimeout(initialReadTimer);
    return true;
  };

  const callTool = async (name: string, args: object): Promise<Record<string, unknown>> => {
    const result = connected
      ? ((await request("tools/call", { name, arguments: args })) as ToolResult)
      : await legacy()?.callTool?.(name, args);
    if (!result) throw new Error("当前宿主未提供小队状态操作能力。");
    return decode(result);
  };

  const refresh = async () => {
    if (!boundSquadId) throw new Error("尚未收到确切的小队引用。");
    const latest = await callTool("mycodex.squad_status", { squadId: boundSquadId });
    if (!accept(latest)) throw new Error("小队记录未能校验通过。");
  };

  const initialRead = () => {
    if (snapshot) { initialReadStarted = true; return; }
    if ((!connected && !legacy()?.callTool) || !boundSquadId || initialReadStarted || disposed) return;
    initialReadStarted = true;
    void callTool("mycodex.squad_status", { squadId: boundSquadId })
      .then(raw => {
        if (disposed) return;
        if (!accept(raw)) throw new Error("小队状态暂不可用。");
        if (!busy) {
          failed = false;
          status = `已同步 STATE rev.${snapshot!.state.revision}（与右侧 Squad Studio 分屏共用状态）。`;
          render();
        }
      })
      .catch(() => {
        if (disposed || busy) return;
        failed = !snapshot;
        status = snapshot
          ? `显示快照 rev.${snapshot.state.revision}；可点击刷新核对最新进展。`
          : "卡片已接入，尚未读回小队快照，可点击刷新状态。";
        render();
      });
  };

  const scheduleInitialRead = () => {
    if (snapshot || initialReadStarted || disposed || initialReadTimer !== undefined) return;
    initialReadTimer = setTimeout(() => {
      initialReadTimer = undefined;
      initialRead();
    }, 50);
  };

  const syncModelContext = async () => {
    if (!connected || !capabilities.updateModelContext || !snapshot) return;
    const state = snapshot.state;
    const gateSummary = state.activeGate
      ? `门禁 ${state.activeGate.id} (${state.activeGate.status}): ${state.activeGate.resolutionText ?? state.activeGate.title}`
      : "无活动门禁";
    await request("ui/update-model-context", {
      structuredContent: {
        squadId: snapshot.squadId,
        revision: state.revision,
        activeGate: state.activeGate ?? null,
      },
      content: [
        {
          type: "text",
          text: `协作小队「${state.title}」（${snapshot.squadId}）当前处于 STATE rev.${state.revision}，${gateSummary}。`,
        },
      ],
    });
  };

  const runOperation = async (fn: () => Promise<void>) => {
    if (busy || disposed) return;
    busy = true;
    failed = false;
    render();
    try {
      await fn();
    } catch (cause) {
      failed = true;
      status = cause instanceof Error ? cause.message : "操作未完成，请刷新核对最新状态。";
    } finally {
      busy = false;
      if (!disposed) render();
    }
  };

  const resolveGate = (gate: SquadGate, verdict: "approved" | "changes_requested") =>
    void runOperation(async () => {
      if (!snapshot) return;
      const chosenId =
        selectedOptions.get(gate.id) ??
        gate.recommendedOptionId ??
        gate.options?.[0]?.id ??
        null;
      const chosenOpt = gate.options?.find(o => o.id === chosenId) ?? null;
      const note = (noteDrafts.get(gate.id) ?? "").trim();
      const baseText = chosenOpt
        ? chosenOpt.label
        : verdict === "approved"
          ? "已批准"
          : "请求修改方案";
      const resolutionText = note ? `${baseText} — ${note}` : baseText;

      try {
        const updated = await callTool("mycodex.squad_state", {
          squadId: snapshot.squadId,
          expectedRevision: snapshot.state.revision,
          resolveGate: {
            id: gate.id,
            status: verdict,
            resolutionText,
          },
        });
        if (!accept(updated)) {
          await refresh();
        }
        noteDrafts.delete(gate.id);
        status = `门禁已批复，推进至 STATE rev.${snapshot!.state.revision}。`;
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : "门禁批复未完成。";
        if (/revision conflict/i.test(msg)) {
          await refresh();
          throw new Error(
            `小队状态刚被更新至 rev.${snapshot!.state.revision}，请核对新版内容后再确认。`,
          );
        }
        throw cause;
      }
      try {
        await syncModelContext();
      } catch {
        // Host context sync is advisory; persistent state is already committed.
      }
    });

  const render = () => {
    root.replaceChildren();
    root.setAttribute("aria-busy", String(busy));

    if (!snapshot) {
      const head = el("header", "mc-head");
      head.append(el("span", "mc-eyebrow", "◆ SQUAD MILESTONE · 协作小队里程碑"));
      root.append(head, el("p", "mc-muted", "正在等待小队状态快照…"));
      if (boundSquadId && connected) {
        const retryBtn = el("button", "mc-btn", "刷新状态");
        retryBtn.type = "button";
        retryBtn.disabled = busy;
        retryBtn.onclick = () =>
          void runOperation(async () => {
            await refresh();
            status = `已读取 STATE rev.${snapshot!.state.revision}。`;
          });
        root.append(retryBtn);
      }
      const statusEl = el("p", failed ? "mc-notice is-error" : "mc-notice", status);
      statusEl.setAttribute("role", "status");
      root.append(statusEl);
      return;
    }

    const state = snapshot.state;
    const gate = state.activeGate ?? null;
    const gateOpen = gate?.status === "open";
    const isVerified = (c: { verifiedBy?: string | null; verifiedAt?: number | null }) => Boolean(c.verifiedBy) || c.verifiedAt != null;
    const doneCriteria = state.criteria.filter(isVerified).length;
    const totalCriteria = state.criteria.length;
    const hasCompletedWork =
      snapshot.status === "closed" ||
      doneCriteria > 0 ||
      snapshot.slots.some(s => Boolean(s.result) || (s.delta?.changed?.length ?? (s.delta as { changedCount?: number } | undefined)?.changedCount ?? 0) > 0);

    const cardMode: "blueprint" | "decision" | "convergence" =
      gate?.kind === "blueprint"
        ? "blueprint"
        : gate?.kind === "decision"
          ? "decision"
          : gate?.kind === "convergence" || hasCompletedWork
            ? "convergence"
            : "blueprint";

    // 1. Header
    const head = el("header", "mc-head");
    const eyebrowText =
      cardMode === "blueprint"
        ? "方案拍板"
        : gateOpen
          ? (cardMode === "convergence" ? "阶段验收" : "方案裁决")
          : "技术品鉴";
    const eyebrow = el(
      "span",
      `mc-eyebrow${cardMode === "convergence" ? " is-settled" : cardMode === "decision" ? " is-warn" : ""}`,
      eyebrowText,
    );
    const badges = el("div", "mc-badges");
    badges.append(el("span", "mc-badge mono", `STATE rev.${state.revision}`));
    if (totalCriteria > 0) {
      badges.append(
        el(
          "span",
          `mc-badge mono${doneCriteria === totalCriteria ? " is-settled" : ""}`,
          `✓ ${doneCriteria}/${totalCriteria} 判据`,
        ),
      );
    }
    if (snapshot.status === "closed") {
      badges.append(el("span", "mc-badge mono", "已收束"));
    } else if (snapshot.slots.length) {
      const running = snapshot.slots.filter(s => s.stage ? s.stage === "running" : s.activity === "active").length;
      const accepted = snapshot.slots.filter(s => s.stage === "accepted").length;
      if (accepted) badges.append(el("span", "mc-badge mono is-settled", `${accepted} 已验收`));
      const quiescent = snapshot.slots.filter(s => s.activity === "quiescent").length;
      badges.append(el("span", "mc-badge mono", running ? `⟳${running} 执行中` : `${quiescent}/${snapshot.slots.length} 静止`));
    }
    const heading = el("div", "mc-heading");
    heading.append(eyebrow, el("h2", "mc-title", state.title));
    head.append(heading, badges);
    root.append(head);

    // 2. Body
    const body = el("section", "mc-body");
    // Details remain opt-in; badge counts carry the default summary.
    const criteriaFold = el("details", "mc-criteria-fold");
    if (totalCriteria > 0) {
      criteriaFold.open = criteriaExpanded;
      const summary = el("summary", "", "判据明细");
      summary.onclick = () => { criteriaExpanded = !criteriaFold.open; };
      criteriaFold.append(summary);
      const critList = el("div", "mc-criteria-list");
      for (const crit of state.criteria) {
        const verified = isVerified(crit);
        const copy = criterionCopy(crit);
        const item = copy.detail ? el("details", `mc-criterion mc-with-detail${verified ? " is-done" : ""}`) : el("div", `mc-criterion${verified ? " is-done" : ""}`);
        item.dataset.criterionId = crit.id;
        const header = copy.detail ? el("summary", "mc-criterion-summary") : item;
        header.append(
          el(
            "span",
            `mono mc-crit-id${verified ? " is-done" : ""}`,
            verified ? `✓ ${crit.id}` : crit.id,
          ),
          el("span", "mc-crit-text", copy.title),
        );
        if (crit.verifiedBy) {
          header.append(el("span", "mc-badge is-clean mono", crit.verifiedBy));
        }
        if (item instanceof HTMLDetailsElement && copy.detail) {
          item.open = openCriterionDetails.has(crit.id);
          const remember = (open: boolean) => { if (open) openCriterionDetails.add(crit.id); else openCriterionDetails.delete(crit.id); };
          header.onclick = () => remember(!item.open);
          item.ontoggle = () => { if (item.isConnected) remember(item.open); };
          const detail = el("div", "mc-criterion-detail-content");
          appendInline(detail, copy.detail);
          item.append(header, detail);
        }
        critList.append(item);
      }
      criteriaFold.append(critList);
    }

    if (review?.summary) {
      const summary = el("p", "mc-review-summary");
      appendInline(summary, review.summary);
      body.append(summary);
    }
    if (review?.highlights?.length) {
      const list = el("div", "mc-review-list");
      const kinds = { tradeoff: "取舍", architecture: "架构", performance: "性能", risk: "风险" };
      for (const item of review.highlights) {
        const article = el("article", "mc-review-item");
        const heading = el("div", "mc-review-heading");
        if (item.kind && Object.hasOwn(kinds, item.kind)) heading.append(el("span", "mc-review-kind", kinds[item.kind]));
        heading.append(el("h3", "mc-review-title", item.title));
        const copy = el("div", "mc-review-copy");
        for (const text of item.body.split(/\n\s*\n/)) {
          const paragraph = el("p");
          appendInline(paragraph, text);
          copy.append(paragraph);
        }
        article.append(heading, copy);
        list.append(article);
      }
      body.append(list);
    } else if (!gateOpen) {
      // A small, explicitly labelled fallback is not a substitute for curated
      // technical judgement. Full worker audit material remains in Studio.
      const reports = snapshot.slots.filter(slot => slot.result && !slot.result.autoSynthesized).slice(0, 3);
      if (reports.length) {
        const fallback = el("section", "mc-deliveries");
        fallback.append(el("div", "mc-section-label", "交付摘要"));
        const excerpt = (text: string, limit: number) => text.length > limit ? text.slice(0, limit).trimEnd() + "…" : text;
        for (const slot of reports) {
          const result = slot.result!;
          const item = el("article", "mc-delivery-item");
          item.append(el("strong", "mc-delivery-handle", slot.handle));
          const summary = el("p", "mc-delivery-summary");
          summary.title = result.summary;
          appendInline(summary, excerpt(result.summary, 280));
          item.append(summary);
          const first = result.assumptions?.find(text => text.trim());
          if (first) {
            const assumption = el("p", "mc-delivery-assumption");
            assumption.title = stripListMarker(first);
            appendInline(assumption, "边界：" + excerpt(stripListMarker(first), 180));
            item.append(assumption);
          }
          fallback.append(item);
        }
        body.append(fallback);
      }
    }

    if (state.openBlockers.length > 0) {
      const text = state.openBlockers.map(blk => `${blk.slotId ? `${blk.slotId}：` : ""}${blk.summary}`).join("；");
      const alert = el("div", "mc-blocker-row", `⚠ ${text}`);
      alert.title = text;
      body.append(alert);
    }

    // Active Gate Decision Options & Dual-Channel Controls
    if (gate && gateOpen) {
      const gateBox = el("div", "mc-gate-box");
      gateBox.append(
        el("div", "mc-gate-title", gate.title),
        el("div", "mc-gate-question", gate.question),
      );
      if (gate.options?.length) {
        const chosenId =
          selectedOptions.get(gate.id) ??
          gate.recommendedOptionId ??
          gate.options[0].id;
        const optList = el("div", "mc-option-list");
        for (const opt of gate.options) {
          const selected = opt.id === chosenId;
          const optBtn = el("button", `mc-option${selected ? " is-selected" : ""}`);
          optBtn.type = "button";
          optBtn.disabled = busy;
          optBtn.dataset.optionId = opt.id;
          optBtn.append(el("span", "mono mc-radio", selected ? "◉" : "○"));
          const copy = el("span", "mc-option-copy");
          const labelRow = el("span", "mc-option-label", opt.label);
          if (gate.recommendedOptionId === opt.id) {
            labelRow.append(el("span", "mc-badge is-stateful", "Recommended"));
          }
          copy.append(labelRow, el("span", "mc-option-summary", opt.summary));
          optBtn.append(copy);
          optBtn.onclick = () => {
            selectedOptions.set(gate.id, opt.id);
            render();
          };
          optList.append(optBtn);
        }
        gateBox.append(optList);
      }

      const noteInput = el("input", "mc-note-input") as HTMLInputElement;
      noteInput.type = "text";
      noteInput.placeholder = "可选拍板备注";
      noteInput.value = noteDrafts.get(gate.id) ?? "";
      noteInput.disabled = busy;
      noteInput.oninput = () => {
        noteDrafts.set(gate.id, noteInput.value);
      };
      gateBox.append(noteInput);

      const gateFoot = el("div", "mc-gate-actions");
      const btnGroup = el("div", "mc-badges");
      const changesBtn = el("button", "mc-btn", "要求调整");
      changesBtn.type = "button";
      changesBtn.disabled = busy;
      changesBtn.dataset.gateAction = "changes_requested";
      changesBtn.onclick = () => resolveGate(gate, "changes_requested");

      const primaryText =
        gate.kind === "blueprint"
          ? "批准开跑 ↵"
          : gate.kind === "convergence"
            ? "确认合入 ↵"
            : "确认裁决 ↵";
      const approveBtn = el("button", "mc-btn is-primary", primaryText);
      approveBtn.type = "button";
      approveBtn.disabled = busy;
      approveBtn.dataset.gateAction = "approved";
      approveBtn.onclick = () => resolveGate(gate, "approved");
      btnGroup.append(changesBtn, approveBtn);
      gateFoot.append(btnGroup);
      gateBox.append(gateFoot);
      body.append(gateBox);
    } else if (gate) {
      const receipt = el("div", "mc-resolved-receipt", `✓ 已记录门禁裁决 (${gate.status} · rev.${gate.stateRevision})：${gate.resolutionText ?? gate.title}`);
      receipt.title = receipt.textContent ?? "";
      body.append(receipt);
    }

    root.append(body);

    // 3. Footer
    const foot = el("footer", "mc-foot");
    foot.append(
      el(
        "span",
        "mc-muted",
        snapshot.studioUrl
          ? "完整产物见 Studio"
          : `小队标识：${snapshot.squadId}`,
      ),
    );
    if (totalCriteria) foot.append(criteriaFold);
    const refreshBtn = el("button", "mc-btn mc-refresh", "刷新状态");
    refreshBtn.type = "button";
    refreshBtn.disabled = busy;
    refreshBtn.onclick = () =>
      void runOperation(async () => {
        await refresh();
        status = `已读取最新状态 rev.${snapshot!.state.revision}。`;
      });
    foot.append(refreshBtn);
    root.append(foot);

    if (failed) {
      const notice = el("p", "mc-notice is-error", status);
      notice.setAttribute("role", "status");
      root.append(notice);
    }
  };

  const applyHostTheme = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const context = value as {
      theme?: string;
      styles?: { variables?: Record<string, string> };
    };
    if (context.theme === "dark" || context.theme === "light") {
      document.documentElement.dataset.theme = context.theme;
    }
    for (const [key, val] of Object.entries(context.styles?.variables ?? {})) {
      if (
        /^--(?:color|font|border|shadow)-[a-z0-9-]+$/.test(key) &&
        typeof val === "string" &&
        val.length < 512
      ) {
        document.documentElement.style.setProperty(key, val);
      }
    }
  };

  const dispose = () => {
    disposed = true;
    clearTimeout(initialReadTimer);
    resize?.disconnect();
    window.removeEventListener("message", receive);
    window.removeEventListener("openai:set_globals", onGlobals);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("小队卡片连接已关闭。"));
    }
    pending.clear();
  };

  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || !event.data || typeof event.data !== "object") {
      return;
    }
    const msg = event.data as {
      jsonrpc?: string;
      id?: string;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: unknown;
    };
    if (msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && !msg.method) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(msg.error.message || "宿主未完成小队卡片请求。"));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "ui/notifications/tool-input") {
      const rawId = (msg.params as { arguments?: { squadId?: unknown } } | undefined)?.arguments?.squadId;
      if (!boundSquadId && isValidSquadId(rawId)) boundSquadId = rawId;
      scheduleInitialRead();
    } else if (msg.method === "ui/notifications/tool-result") {
      try {
        if (accept(decode(msg.params as ToolResult)) && snapshot) {
          failed = false;
          status = `已同步 STATE rev.${snapshot.state.revision}。`;
        }
      } catch (cause) {
        failed = true;
        status = cause instanceof Error ? cause.message : "小队卡片快照解析失败。";
      }
      render();
    } else if (msg.method === "ui/notifications/host-context-changed") {
      applyHostTheme(msg.params);
    } else if (msg.id !== undefined) {
      const teardown = msg.method === "ui/resource-teardown";
      window.parent.postMessage(
        {
          jsonrpc: "2.0",
          id: msg.id,
          ...(teardown || msg.method === "ping"
            ? { result: {} }
            : { error: { code: -32601, message: "Method not found." } }),
        },
        "*",
      );
      if (teardown) dispose();
    }
  };

  const onGlobals = () => {
    if (disposed) return;
    if (legacy()?.toolInput?.squadId && !boundSquadId && isValidSquadId(legacy()!.toolInput!.squadId)) {
      boundSquadId = legacy()!.toolInput!.squadId!;
    }
    if (legacy()?.toolOutput) accept(legacy()!.toolOutput);
    applyHostTheme({ theme: legacy()?.theme });
    render();
    if (legacy()?.toolInput) scheduleInitialRead();
  };

  window.addEventListener("message", receive);
  window.addEventListener("pagehide", dispose, { once: true });
  window.addEventListener("openai:set_globals", onGlobals);
  onGlobals();

  if (window.parent !== window) {
    void request("ui/initialize", {
      appInfo: { name: "MyCodex squad milestone card", version: "0.2.0" },
      appCapabilities: { availableDisplayModes: ["inline"] },
      protocolVersion: "2026-01-26",
    })
      .then(value => {
        if (disposed) return;
        const initRes = value as {
          hostCapabilities?: Record<string, unknown>;
          hostContext?: unknown;
        };
        connected = true;
        capabilities = initRes.hostCapabilities ?? {};
        applyHostTheme(initRes.hostContext);
        notify("ui/notifications/initialized");
        scheduleInitialRead();
        status = snapshot
          ? `已同步 STATE rev.${snapshot.state.revision}。`
          : "正在读取小队里程碑快照…";
        render();
        let lastWidth = 0;
        let lastHeight = 0;
        resize = new ResizeObserver(() => {
          const box = root.getBoundingClientRect();
          const width = Math.ceil(box.width);
          const height = Math.ceil(box.height);
          if (width !== lastWidth || height !== lastHeight) {
            lastWidth = width;
            lastHeight = height;
            notify("ui/notifications/size-changed", { width, height });
          }
        });
        resize.observe(root);
      })
      .catch(() => {
        if (disposed) return;
        if (legacy()?.callTool) {
          status = "已接入当前对话的小队连接。";
          render();
        } else {
          failed = !snapshot;
          status = snapshot
            ? `显示收到的快照 rev.${snapshot.state.revision}。`
            : "当前宿主尚未完成卡片桥接。";
          render();
        }
      });
  }
}

const SQUAD_CARD_CSS = `
:root, [data-theme="light"] {
  color-scheme: light;
  --sc-bg: #FFFFFF;
  --sc-subtle: #F5F4F0;
  --sc-studio: #F9F9F8;
  --sc-border: #DDDAD2;
  --sc-border-strong: #B9B4A9;
  --sc-text: #17191C;
  --sc-secondary: #4A4F57;
  --sc-muted: #666C76;
  --sc-accent: #1B5488;
  --sc-accent-hover: #14426C;
  --sc-accent-soft: #EBF2F9;
  --sc-accent-border: #B7D1EA;
  --sc-on-accent: #FFFFFF;
  --sc-settled-fg: #16653E;
  --sc-settled-bg: #EAF6F0;
  --sc-settled-border: #B7E1CA;
  --sc-warn-fg: #8D4D08;
  --sc-warn-bg: #FDF4E7;
  --sc-warn-border: #ECC996;
  --sc-err-fg: #9C2B23;
  --sc-err-bg: #FCEEEB;
}
[data-theme="dark"] {
  color-scheme: dark;
  --sc-bg: #1B1F27;
  --sc-subtle: #212631;
  --sc-studio: #161920;
  --sc-border: #2E3543;
  --sc-border-strong: #454E61;
  --sc-text: #ECEFF4;
  --sc-secondary: #ABB3C2;
  --sc-muted: #848D9C;
  --sc-accent: #63A9E5;
  --sc-accent-hover: #7DB9EC;
  --sc-accent-soft: rgba(99, 169, 229, 0.14);
  --sc-accent-border: rgba(99, 169, 229, 0.36);
  --sc-on-accent: #0C1117;
  --sc-settled-fg: #73D1A1;
  --sc-settled-bg: rgba(71, 184, 129, 0.14);
  --sc-settled-border: rgba(71, 184, 129, 0.34);
  --sc-warn-fg: #F2B56B;
  --sc-warn-bg: rgba(229, 153, 62, 0.15);
  --sc-warn-border: rgba(229, 153, 62, 0.38);
  --sc-err-fg: #F28B82;
  --sc-err-bg: rgba(229, 100, 90, 0.15);
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0; background: transparent; color: var(--sc-text);
  font: 13px/1.5 "SF Pro Text", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
}
button, input { font: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--sc-accent); outline-offset: 2px; }
.mono { font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
#squad-card { background: transparent; border: 0; width: 100%; min-width: 0; overflow-wrap: anywhere; padding: 4px 0; }
.mc-head, .mc-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; background: transparent; }
.mc-head { padding: 4px 0 14px; }
.mc-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 10px; min-width: 0; }
.mc-title { margin: 0; font-size: 16px; font-weight: 650; line-height: 1.5; }
.mc-eyebrow { font-size: 10.5px; color: var(--sc-muted); white-space: nowrap; }
.mc-badges { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.mc-badge { font-size: 10px; color: var(--sc-muted); line-height: 1.6; }
.mc-badge.is-settled { color: var(--sc-settled-fg); }
.mc-badge.is-stateful { color: var(--sc-accent); }
.mc-body { display: flex; flex-direction: column; gap: 20px; }
.mc-body:not(:empty) { padding: 2px 0 18px; }
.mc-review-summary { margin: 0; font-size: 15px; line-height: 1.8; font-weight: 600; color: var(--sc-text); }
.mc-review-list { display: flex; flex-direction: column; gap: 20px; }
.mc-review-item + .mc-review-item { border-top: 1px solid var(--sc-border); padding-top: 18px; }
.mc-review-heading { display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px; }
.mc-review-title { margin: 0; font-size: 14px; line-height: 1.6; font-weight: 650; }
.mc-review-kind { font-size: 10px; color: var(--sc-accent); flex-shrink: 0; }
.mc-review-copy { font-size: 13.5px; line-height: 1.9; color: var(--sc-secondary); }
.mc-review-copy p { margin: 0; white-space: pre-wrap; }
.mc-review-copy p + p { margin-top: 10px; }
.md-inline-code { font-family: "SF Mono", Menlo, monospace; font-size: .9em; padding: 1px 4px; border-radius: 3px; background: var(--sc-subtle); white-space: pre-wrap; overflow-wrap: anywhere; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.mc-deliveries { display: flex; flex-direction: column; gap: 14px; }
.mc-section-label { font-size: 10.5px; color: var(--sc-muted); }
.mc-delivery-handle { font-size: 11px; color: var(--sc-secondary); }
.mc-delivery-summary { margin: 4px 0; font-size: 13.5px; line-height: 1.8; }
.mc-delivery-assumption { margin: 4px 0 0; font-size: 11.5px; line-height: 1.7; color: var(--sc-muted); }
.mc-blocker-row { border-left: 2px solid var(--sc-err-fg); padding-left: 10px; color: var(--sc-err-fg); font-size: 12px; line-height: 1.8; }
.mc-gate-box { display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--sc-border); padding-top: 16px; }
.mc-gate-title { font-size: 14px; font-weight: 650; line-height: 1.7; }
.mc-gate-question { font-size: 13px; line-height: 1.8; color: var(--sc-secondary); }
.mc-option-list { display: flex; flex-direction: column; gap: 8px; }
.mc-option { display: flex; align-items: flex-start; gap: 8px; padding: 10px; border-radius: 5px; border: 1px solid var(--sc-border); background: transparent; text-align: left; width: 100%; }
.mc-option:hover:not(:disabled) { border-color: var(--sc-border-strong); }
.mc-option.is-selected { border-color: var(--sc-accent-border); background: var(--sc-accent-soft); }
.mc-radio { font-weight: 700; color: var(--sc-accent); flex-shrink: 0; }
.mc-option-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.mc-option-label { font-size: 12.5px; font-weight: 600; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.mc-option-summary { font-size: 12px; line-height: 1.8; color: var(--sc-secondary); }
.mc-note-input { width: 100%; height: 32px; padding: 0 9px; border-radius: 5px; border: 1px solid var(--sc-border); background: transparent; font-size: 12px; }
.mc-gate-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mc-resolved-receipt { color: var(--sc-settled-fg); font-size: 12px; line-height: 1.8; }
.mc-btn { min-height: 28px; padding: 3px 10px; border-radius: 5px; border: 1px solid var(--sc-border); background: transparent; color: var(--sc-text); font-size: 12px; font-weight: 500; }
.mc-btn.is-primary { background: var(--sc-accent); border-color: var(--sc-accent); color: var(--sc-on-accent); font-weight: 600; }
.mc-btn.is-primary:hover:not(:disabled) { background: var(--sc-accent-hover); border-color: var(--sc-accent-hover); }
.mc-btn.mc-refresh { border: 0; padding-inline: 2px; color: var(--sc-muted); font-size: 11px; font-weight: 400; }
.mc-foot { padding-top: 10px; border-top: 1px solid var(--sc-border); }
.mc-muted { font-size: 11px; color: var(--sc-muted); margin: 0; }
.mc-criteria-fold { font-size: 11px; color: var(--sc-muted); min-width: 0; }
.mc-criteria-fold summary { cursor: pointer; }
.mc-criteria-fold[open] { flex-basis: 100%; }
.mc-criteria-list { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.mc-criterion { display: flex; align-items: flex-start; gap: 7px; font-size: 12px; line-height: 1.8; }
.mc-crit-id { font-size: 10px; font-weight: 400; color: var(--sc-muted); flex-shrink: 0; white-space: nowrap; }
.mc-crit-text { flex: 1; min-width: 0; font-weight: 550; color: var(--sc-text); }
.mc-with-detail { display: block; }
.mc-criterion-summary { display: flex; align-items: flex-start; gap: 7px; cursor: pointer; list-style: none; }
.mc-criterion-summary::-webkit-details-marker { display: none; }
.mc-criterion-summary::before { content: "▸"; color: var(--sc-muted); flex-shrink: 0; }
.mc-with-detail[open] > .mc-criterion-summary::before { content: "▾"; }
.mc-criterion-detail-content { margin: 7px 0 2px 16px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11.5px; line-height: 1.8; color: var(--sc-secondary); }
.mc-notice { margin: 10px 0 0; font-size: 11.5px; color: var(--sc-muted); }
.mc-notice.is-error { color: var(--sc-err-fg); }

`;

/**
 * Inline Milestone Card (Blueprint Card & Convergence Card) resource for MCP App
 * rendering inside the main conversation stream.
 */
export function conversationSquadCardResource() {
  const script = `(${mountConversationSquadCard.toString()})()`.replace(/<\/script/gi, "<\\/script");
  return {
    uri: SQUAD_CARD_URI,
    mimeType: SQUAD_CARD_MIME,
    text: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>协作小队里程碑</title><style>${SQUAD_CARD_CSS}</style></head><body><main id="squad-card" aria-label="协作小队卡片"></main><script type="module">${script}</script></body></html>`,
    _meta: {
      ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } },
      "openai/ui": { availableDisplayModes: ["inline"], preferredDisplayMode: ["inline"][0] },
      "openai/widgetShowCodexWidgetInline": true,
      "openai/widgetDescription": "阶段技术品鉴与 Gate 拍板。展示主会话提炼的方案选型、关键取舍、性能方法与风险。",
      "openai/widgetPrefersBorder": false,
    },
  };
}
