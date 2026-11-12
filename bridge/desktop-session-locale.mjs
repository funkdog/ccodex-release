export function desktopSessionText(value, chinese = true) {
  const pairs = [
    ["Session management", "\u6279\u91cf\u4f1a\u8bdd\u7ba1\u7406"],
    ["Local Codex (Copilot) Desktop / ccodex CLI. Active sessions are protected.",
      "\u672c\u673a Desktop \u4e0e CLI \u5171\u4eab\u5386\u53f2\uff1b\u4f7f\u7528\u4e2d\u7684\u4f1a\u8bdd\u4f1a\u88ab\u4fdd\u62a4\u3002"],
    ["Title, UUID or directory", "\u641c\u7d22\u6807\u9898\u3001\u4f1a\u8bdd ID \u6216\u76ee\u5f55"],
    ["Search sessions", "\u641c\u7d22\u4f1a\u8bdd"],
    ["Session state", "\u4f1a\u8bdd\u72b6\u6001"],
    ["Working directory", "\u5de5\u4f5c\u76ee\u5f55"],
    ["Exact working directory (optional)", "\u7cbe\u786e\u5de5\u4f5c\u76ee\u5f55\uff08\u53ef\u9009\uff09"],
    ["All sessions", "\u6240\u6709\u4f1a\u8bdd"],
    ["Not archived", "\u672a\u5f52\u6863"],
    ["Archived", "\u5df2\u5f52\u6863"],
    ["Refresh", "\u5237\u65b0\u5217\u8868"],
    ["Select all filtered", "\u5168\u9009\u7b5b\u9009\u7ed3\u679c"],
    ["Clear selection", "\u6e05\u7a7a\u9009\u62e9"],
    ["Archive selected", "\u5f52\u6863\u6240\u9009"],
    ["Restore selected", "\u6062\u590d\u6240\u9009"],
    ["Delete selected permanently", "\u6c38\u4e45\u5220\u9664\u6240\u9009"],
    ["Confirm permanent deletion", "\u786e\u8ba4\u6c38\u4e45\u5220\u9664"],
    ["Permanent deletion confirmation", "\u6c38\u4e45\u5220\u9664\u786e\u8ba4\u6587\u5b57"],
    ["Type the exact DELETE phrase", "\u8f93\u5165\u4e0a\u65b9\u5b8c\u6574\u7684 DELETE \u786e\u8ba4\u6587\u5b57"],
    ["Type the exact confirmation below:", "\u8bf7\u8f93\u5165\u4e0b\u9762\u7684\u5b8c\u6574\u786e\u8ba4\u6587\u5b57\uff1a"],
    ["Permanent deletion removes conversation history. Restore cannot undo this.",
      "\u6c38\u4e45\u5220\u9664\u4f1a\u79fb\u9664\u4f1a\u8bdd\u5386\u53f2\uff0c\u4e0d\u80fd\u901a\u8fc7\u201c\u6062\u590d\u5f52\u6863\u201d\u627e\u56de\u3002"],
    ["Only the eligible IDs in this preview will be deleted. Unselected descendants and project files are not targets.",
      "\u53ea\u5220\u9664\u672c\u6b21\u9884\u89c8\u4e2d\u6807\u4e3a\u53ef\u6267\u884c\u7684\u51c6\u786e ID\uff1b\u672a\u9009\u4e2d\u7684\u5b50\u4f1a\u8bdd\u548c\u9879\u76ee\u6587\u4ef6\u4e0d\u662f\u5220\u9664\u76ee\u6807\u3002"],
    ["No sessions deleted. Review the exact IDs, then type the DELETE phrase. This cannot be restored.",
      "\u8fd8\u6ca1\u6709\u5220\u9664\u4efb\u4f55\u4f1a\u8bdd\u3002\u8bf7\u6838\u5bf9\u51c6\u786e ID \u540e\u8f93\u5165 DELETE \u786e\u8ba4\u6587\u5b57\uff1b\u5220\u9664\u4e0d\u53ef\u6062\u590d\u3002"],
    ["Type the exact DELETE phrase before confirming permanent deletion.",
      "\u5fc5\u987b\u8f93\u5165\u5b8c\u5168\u4e00\u81f4\u7684 DELETE \u786e\u8ba4\u6587\u5b57\uff0c\u624d\u80fd\u786e\u8ba4\u6c38\u4e45\u5220\u9664\u3002"],
    ["The preview operation did not match this selection. No sessions changed.",
      "\u9884\u89c8\u64cd\u4f5c\u4e0e\u9009\u62e9\u4e0d\u4e00\u81f4\uff0c\u6ca1\u6709\u4fee\u6539\u4efb\u4f55\u4f1a\u8bdd\u3002"],
    ["Close", "\u5173\u95ed"],
    ["Close session management", "\u5173\u95ed\u4f1a\u8bdd\u7ba1\u7406"],
    ["Previous", "\u4e0a\u4e00\u9875"],
    ["Next", "\u4e0b\u4e00\u9875"],
    ["Cancel preview", "\u53d6\u6d88\u9884\u89c8"],
    ["Confirm exact selection", "\u786e\u8ba4\u6267\u884c\uff08\u4ec5\u9884\u89c8\u4e2d\u7684 ID\uff09"],
    ["Check batch results", "\u67e5\u770b\u6267\u884c\u7ed3\u679c"],
    ["Recheck current history (no replay)", "\u6838\u5bf9\u5f53\u524d\u5386\u53f2\uff08\u4e0d\u91cd\u590d\u6267\u884c\uff09"],
    ["Batch progress", "\u6279\u91cf\u64cd\u4f5c\u8fdb\u5ea6"],
    ["Session", "\u4f1a\u8bdd"],
    ["State", "\u72b6\u6001"],
    ["Modified", "\u4fee\u6539\u65f6\u95f4"],
    ["Sessions", "\u4f1a\u8bdd\u5217\u8868"],
    ["Exact batch preview", "\u51c6\u786e\u6279\u91cf\u64cd\u4f5c\u9884\u89c8"],
    ["Select eligible displayed sessions", "\u4ec5\u9009\u62e9\u5f53\u524d\u9875\u7684\u53ef\u64cd\u4f5c\u4f1a\u8bdd"],
    ["Ready", "\u53ef\u6267\u884c"],
    ["Idle", "\u7a7a\u95f2"],
    ["Spawned / idle", "\u5b50\u4f1a\u8bdd \u00b7 \u7a7a\u95f2"],
    ["In use - protected", "\u4f7f\u7528\u4e2d \u00b7 \u5df2\u4fdd\u62a4"],
    ["Unknown - protected", "\u72b6\u6001\u672a\u77e5 \u00b7 \u5df2\u4fdd\u62a4"],
    ["Unknown", "\u672a\u77e5"],
    ["No sessions match these filters.", "\u6ca1\u6709\u7b26\u5408\u7b5b\u9009\u6761\u4ef6\u7684\u4f1a\u8bdd\u3002"],
    ["Loading sessions...", "\u6b63\u5728\u8bfb\u53d6\u672c\u673a\u4f1a\u8bdd\u2026"],
    ["Loading local sessions...", "\u6b63\u5728\u8bfb\u53d6\u672c\u673a\u4f1a\u8bdd\u2026"],
    ["Selecting all filtered idle sessions...", "\u6b63\u5728\u83b7\u53d6\u8de8\u9875\u5168\u9009\u7ed3\u679c\u2026"],
    ["Checking the exact selection...", "\u6b63\u5728\u68c0\u67e5\u6240\u9009\u4f1a\u8bdd\u2026"],
    ["More than 500 sessions match. Narrow the filter to select all.",
      "\u5339\u914d\u8d85\u8fc7 500 \u6761\uff0c\u8bf7\u7f29\u5c0f\u7b5b\u9009\u8303\u56f4\u540e\u518d\u5168\u9009\u3002"],
    ["More than 500 sessions match. Narrow the filter.",
      "\u5339\u914d\u8d85\u8fc7 500 \u6761\uff0c\u8bf7\u7f29\u5c0f\u7b5b\u9009\u8303\u56f4\u540e\u518d\u5168\u9009\u3002"],
    ["Select sessions, then preview archive or restore. No history changes until you confirm.",
      "\u8fd9\u91cc\u53ea\u9009\u62e9\u4f1a\u8bdd\uff0c\u4e0d\u4f1a\u66f4\u6539\u5386\u53f2\u3002\u786e\u8ba4\u6267\u884c\u524d\u4f1a\u518d\u6b21\u68c0\u67e5\u4f1a\u8bdd\u72b6\u6001\u3002"],
    ["Preview cancelled. No sessions changed.", "\u5df2\u53d6\u6d88\u9884\u89c8\uff0c\u6ca1\u6709\u4fee\u6539\u4efb\u4f55\u4f1a\u8bdd\u3002"],
    ["Session list closed. Reopen to refresh; your selection is preserved.",
      "\u5217\u8868\u5df2\u5173\u95ed\u3002\u91cd\u65b0\u6253\u5f00\u53ef\u5237\u65b0\uff0c\u5df2\u6709\u9009\u62e9\u4f1a\u4fdd\u7559\u3002"],
    ["No sessions changed. Review the exact IDs and titles before confirming.",
      "\u8fd8\u6ca1\u6709\u4fee\u6539\u4f1a\u8bdd\u3002\u8bf7\u6838\u5bf9\u51c6\u786e\u7684 ID \u548c\u6807\u9898\u540e\u518d\u786e\u8ba4\u3002"],
    ["Only the exact IDs below will be changed. Activity and revisions are checked again on apply.",
      "\u53ea\u6709\u4e0b\u9762\u5217\u51fa\u7684\u51c6\u786e ID \u4f1a\u88ab\u4fee\u6539\uff0c\u6267\u884c\u524d\u4f1a\u518d\u6b21\u68c0\u67e5\u4f7f\u7528\u72b6\u6001\u548c\u8bb0\u5f55\u7248\u672c\u3002"],
    ["The Desktop session-management bridge is unavailable.",
      "\u4f1a\u8bdd\u7ba1\u7406\u6865\u63a5\u670d\u52a1\u6682\u4e0d\u53ef\u7528\u3002"],
    ["Session-management request timed out. Refresh or check results; do not repeat a confirmed batch.",
      "\u4f1a\u8bdd\u7ba1\u7406\u8bf7\u6c42\u8d85\u65f6\u3002\u8bf7\u5237\u65b0\u6216\u67e5\u770b\u6267\u884c\u7ed3\u679c\uff0c\u4e0d\u8981\u91cd\u590d\u786e\u8ba4\u540c\u4e00\u6279\u64cd\u4f5c\u3002"],
  ];
  const pair = pairs.find(item => item[chinese ? 0 : 1] === value);
  if (pair) return pair[chinese ? 1 : 0];
  if (!chinese) {
    let match = /^\u5df2\u9009 (\d+) \u6761$/.exec(value);
    if (match) return match[1] + " selected";
    match = /^\u5171 (\d+) \u6761 \u00b7 \u672c\u9875 (\d+) \u6761 \u00b7 \u7b2c (\d+) \u9875$/.exec(value);
    if (match) return `${match[1]} matching / ${match[2]} displayed / page ${match[3]}`;
    return value;
  }
  let match = /^(\d+) selected$/.exec(value);
  if (match) return `\u5df2\u9009 ${match[1]} \u6761`;
  match = /^(\d+) matching \/ (\d+) displayed \/ page (\d+)$/.exec(value);
  if (match) return `\u5171 ${match[1]} \u6761 \u00b7 \u672c\u9875 ${match[2]} \u6761 \u00b7 \u7b2c ${match[3]} \u9875`;
  match = /^(\d+) eligible sessions selected across all filtered pages\. Active sessions were excluded\.$/.exec(value);
  if (match) return `\u5df2\u9009 ${match[1]} \u6761\uff08\u8de8\u6240\u6709\u9875\uff09\uff1b\u4f7f\u7528\u4e2d\u6216\u672a\u77e5\u72b6\u6001\u7684\u4f1a\u8bdd\u5df2\u8df3\u8fc7\u3002`;
  match = /^Processed (\d+) \/ (\d+) sessions\.\.\.$/.exec(value);
  if (match) return `\u5df2\u5904\u7406 ${match[1]} / ${match[2]} \u6761\u4f1a\u8bdd\u2026`;
  match = /^Review (archive|restore|permanent delete): (\d+) eligible \/ (\d+) selected$/.exec(value);
  if (match) return `\u6838\u5bf9${match[1] === "permanent delete" ? "\u6c38\u4e45\u5220\u9664"
    : match[1] === "archive" ? "\u5f52\u6863" : "\u6062\u590d"}\uff1a${match[2]} \u6761\u53ef\u6267\u884c / \u5df2\u9009 ${match[3]} \u6761`;
  match = /^Complete: (\d+); skipped: (\d+); failed: (\d+)([\s\S]*)$/.exec(value);
  if (match) return `\u5b8c\u6210 ${match[1]} \u6761\uff1b\u8df3\u8fc7 ${match[2]} \u6761\uff1b\u5931\u8d25 ${match[3]} \u6761${match[4]}`;
  match = /^Current history verified: (\d+) absent; (\d+) in target state; (\d+) remaining\. The old execution result is unavailable\. Nothing was replayed\.$/.exec(value);
  if (match) return `\u5df2\u6838\u5bf9\u5f53\u524d\u5386\u53f2\uff1a${match[1]} \u6761\u5df2\u4e0d\u5b58\u5728\uff0c${match[2]} \u6761\u5df2\u5904\u4e8e\u76ee\u6807\u72b6\u6001\uff0c${match[3]} \u6761\u4ecd\u4fdd\u7559\u3002\u539f\u6267\u884c\u8bb0\u5f55\u5df2\u4e0d\u53ef\u7528\uff1b\u6ca1\u6709\u91cd\u590d\u6267\u884c\u5220\u9664\u6216\u5f52\u6863\u3002`;
  match = /^Skip: (.+)$/.exec(value);
  if (match) {
    const reasons = {
      session_in_use: "\u4f1a\u8bdd\u6b63\u5728\u4f7f\u7528",
      ownership_unknown: "\u6240\u6709\u6743\u72b6\u6001\u672a\u77e5",
      remote_not_supported: "\u4e0d\u652f\u6301\u8fdc\u7aef\u4f1a\u8bdd",
      operation_not_supported: "\u4e0d\u652f\u6301\u6b64\u64cd\u4f5c",
      not_found: "\u4f1a\u8bdd\u5df2\u4e0d\u5b58\u5728",
      descendants_not_selected: "\u672a\u9009\u9f50\u5b50\u4f1a\u8bdd\uff0c\u4e0d\u81ea\u52a8\u5220\u9664",
      descendants_protected: "\u5b50\u4f1a\u8bdd\u4f7f\u7528\u4e2d\u6216\u4e0d\u53ef\u5220\u9664",
    };
    return "\u8df3\u8fc7\uff1a" + (reasons[match[1]] || match[1]);
  }
  return value;
}

export function buildDesktopSessionLocalePatch() {
  return `(() => {
    ${desktopSessionText.toString()}
    return (${installDesktopSessionLocale.toString()})();
  })()`;
}

// Translate only extension-owned controls, never session titles or native menus.
function installDesktopSessionLocale() {
  if (typeof document === "undefined" || !document.body ||
      typeof MutationObserver !== "function") return "unavailable";
  const previous = globalThis.__codexCopilotSessionLocaleV1;
  if (previous?.revision === 3) { previous.refresh(); return "active"; }
  previous?.dispose?.();
  let root = null;
  const text = node => {
    if (!node) return;
    const chinese = /^zh(?:-|$)/i.test(document.documentElement.lang);
    const translated = desktopSessionText(node.textContent, chinese);
    if (node.textContent !== translated) node.textContent = translated;
  };
  const attribute = (node, name, value) => {
    if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
  };
  const translateAttribute = (node, name) => {
    if (!node?.hasAttribute(name)) return;
    attribute(node, name, desktopSessionText(node.getAttribute(name),
      /^zh(?:-|$)/i.test(document.documentElement.lang)));
  };
  function refresh() {
    const current = document.getElementById("codex-copilot-sessions");
    if (current !== root) {
      contentObserver.disconnect();
      root = current;
      if (root) contentObserver.observe(root, {
        childList: true, characterData: true, subtree: true,
      });
    }
    if (!root) return;
    for (const selector of [
      "#codex-copilot-sessions-title", ".ccs-header .ccs-muted", "[data-action]:not(input)",
      "[data-field=archived] option", "[data-role=list] thead th:not(:first-child)",
      "[data-role=rows] tr td:nth-child(3)", "[data-role=rows] td[colspan]",
      "[data-role=count]", "[data-role=page]",
      "[data-role=status]", "[data-role=preview-title]", "[data-role=preview] .ccs-muted",
      "[data-role=preview-rows] tr td:last-child",
      "[data-role=delete-confirm] strong", "[data-role=delete-confirm] p",
      "[data-role=delete-confirm] label",
    ]) {
      for (const node of root.querySelectorAll(selector)) text(node);
    }
    for (const node of root.querySelectorAll("[data-field], [aria-label], [placeholder]")) {
      translateAttribute(node, "aria-label");
      translateAttribute(node, "placeholder");
    }
    const chinese = /^zh(?:-|$)/i.test(document.documentElement.lang);
    const hints = [
      ["[data-action=select-all]", chinese
        ? "\u8de8\u6240\u6709\u9875\u9009\u4e2d\u53ef\u64cd\u4f5c\u4f1a\u8bdd\uff08\u6700\u591a 500 \u6761\uff09\uff0c\u4f7f\u7528\u4e2d\u6216\u672a\u77e5\u72b6\u6001\u7684\u4f1a\u8bdd\u4f1a\u81ea\u52a8\u8df3\u8fc7\u3002"
        : "Select eligible sessions across all filtered pages, up to 500; active and unknown-owner sessions are excluded."],
      ["[data-action=archive]", chinese
        ? "\u5f52\u6863\u4f1a\u4ece\u201c\u6700\u8fd1\u201d\u9690\u85cf\u4f1a\u8bdd\uff0c\u4f46\u4fdd\u7559\u5386\u53f2\uff0c\u53ef\u968f\u65f6\u6062\u590d\u3002"
        : "Archive hides sessions from Recents without deleting their history; it can be restored."],
      ["[data-action=unarchive]", chinese
        ? "\u53ea\u6062\u590d\u5df2\u5f52\u6863\u4f1a\u8bdd\uff1b\u5f53\u524d\u6240\u9009\u5747\u672a\u5f52\u6863\u65f6\uff0c\u6b64\u6309\u94ae\u4e0d\u53ef\u7528\u3002"
        : "Restore applies only to archived sessions; it is disabled when none of the selections are archived."],
      ["[data-action=delete]", chinese
        ? "\u5220\u9664\u672a\u5f52\u6863\u6216\u5df2\u5f52\u6863\u7684\u6240\u9009\u4f1a\u8bdd\u5386\u53f2\uff0c\u4e0d\u53ef\u6062\u590d\u3002\u5148\u9884\u89c8\u51c6\u786e ID\uff0c\u518d\u8f93\u5165\u786e\u8ba4\u6587\u5b57\u3002"
        : "Permanently remove selected active or archived history. Review exact IDs and type the confirmation before deletion."],
      ["[data-field=cwd]", chinese
        ? "\u53ea\u663e\u793a\u5de5\u4f5c\u76ee\u5f55\u4e0e\u8fd9\u4e2a\u8def\u5f84\u5b8c\u5168\u4e00\u81f4\u7684\u4f1a\u8bdd\u3002"
        : "Match this working directory exactly, not a substring."],
    ];
    for (const [selector, hint] of hints) attribute(root.querySelector(selector), "title", hint);
    let help = root.querySelector("[data-role=help]");
    if (!help) {
      help = document.createElement("p");
      help.dataset.role = "help";
      help.className = "ccs-muted";
      root.insertBefore(help, root.querySelector("[data-role=status]"));
    }
    const helpText = root.querySelector("[data-action=delete]")
      ? chinese
        ? "\u5168\u9009\u8986\u76d6\u6240\u6709\u9875\uff0c\u8868\u5934\u52fe\u9009\u6846\u53ea\u9009\u672c\u9875\u3002\u5f52\u6863\u4fdd\u7559\u5386\u53f2\u4e14\u53ef\u6062\u590d\uff1b\u6c38\u4e45\u5220\u9664\u4e0d\u53ef\u6062\u590d\uff0c\u5fc5\u987b\u9884\u89c8\u5e76\u8f93\u5165\u786e\u8ba4\u6587\u5b57\u3002"
        : "Select all covers every filtered page; the header checkbox selects this page only. Archive keeps history and is reversible. Permanent deletion cannot be restored and requires preview plus typed confirmation."
      : chinese
        ? "\u5168\u9009\u8986\u76d6\u6240\u6709\u9875\uff0c\u8868\u5934\u52fe\u9009\u6846\u53ea\u9009\u672c\u9875\u3002\u5f52\u6863\u53ef\u6062\u590d\uff1b\u6c38\u4e45\u5220\u9664\u8bf7\u7528\u4fa7\u8fb9\u680f\u539f\u751f\u53f3\u952e\u83dc\u5355\uff0c\u6279\u91cf\u9762\u677f\u672a\u542f\u7528\u6c38\u4e45\u5220\u9664\u3002"
        : "Select all covers every filtered page; the header checkbox selects this page only. Archive is reversible. Permanent deletion remains in the native sidebar context menu, not this bulk panel.";
    if (help.textContent !== helpText) help.textContent = helpText;
    for (const cell of root.querySelectorAll("[data-role=rows] tr td:nth-child(3)")) {
      if (cell.textContent === "\u5b50\u4f1a\u8bdd \u00b7 \u7a7a\u95f2" ||
          cell.textContent === "Spawned / idle") {
        attribute(cell, "title", chinese
          ? "\u8fd9\u662f\u5b50\u4ee3\u7406\u751f\u6210\u7684\u5b50\u4f1a\u8bdd\u5386\u53f2\uff0c\u4e0d\u662f\u53e6\u4e00\u4efd\u8f6f\u4ef6\u6216\u6784\u5efa\u6587\u4ef6\u3002"
          : "A saved child-agent conversation, not another software version or build artifact.");
      }
    }
  }
  const contentObserver = new MutationObserver(refresh);
  const mountObserver = new MutationObserver(() => {
    if (!root?.isConnected || document.getElementById("codex-copilot-sessions") !== root) refresh();
  });
  mountObserver.observe(document.body, { childList: true, subtree: true });
  const languageObserver = new MutationObserver(refresh);
  languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  globalThis.__codexCopilotSessionLocaleV1 = {
    revision: 3, refresh,
    dispose() {
      contentObserver.disconnect(); mountObserver.disconnect(); languageObserver.disconnect();
      root?.querySelector("[data-role=help]")?.remove();
      delete globalThis.__codexCopilotSessionLocaleV1;
    },
  };
  refresh();
  return "active";
}
