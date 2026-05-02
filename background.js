const MENU_ITEMS = [
  { id: "ask-selection", title: "问问 ChatGPT：选中文本", contexts: ["selection"] },
  { id: "summarize-page", title: "用 ChatGPT 总结当前页面", contexts: ["page", "selection"] },
  { id: "explain-page", title: "解释这个页面", contexts: ["page", "selection"] },
  { id: "extract-page", title: "提取重点和待办", contexts: ["page", "selection"] },
  { id: "draft-reply", title: "帮我基于页面起草回复", contexts: ["page", "selection", "editable"] }
];

const PROMPTS = {
  "ask-selection": "请解释我选中的内容，并指出它和当前网页上下文的关系。",
  "summarize-page": "请总结当前页面，先给结论，再列关键事实和可能的下一步。",
  "explain-page": "请用清晰的工程化方式解释当前页面内容，指出背景、机制和影响。",
  "extract-page": "请从当前页面提取重点、实体、日期、数字、风险和待办事项。",
  "draft-reply": "请基于当前页面内容帮我起草一段可直接发送的回复。"
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const item of MENU_ITEMS) chrome.contextMenus.create(item);
  });

  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  rememberContextTab(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
    if (tab.active) rememberContextTab(tabId, tab).catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  await stagePrompt({
    tabId: tab.id,
    prompt: PROMPTS[info.menuItemId] || "请分析当前页面。",
    source: info.selectionText ? "selection" : "page",
    selection: info.selectionText || ""
  });
  await openPanel(tab.id);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  await stagePrompt({ tabId: tab.id, prompt: "", source: "action", selection: "" });
  await openPanel(tab.id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ASK_GPT_OPEN") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "No active tab found." });
      return false;
    }
    const staged = {
      tabId,
      prompt: message.prompt || "",
      source: message.source || "floating-button",
      selection: message.selection || ""
    };

    // Keep sidePanel.open close to the originating page click. Content-script
    // clicks may still be rejected by Chrome, but staging must complete so the
    // embedded fallback can load the same page context.
    const openPromise = openPanel(tabId)
      .then(() => ({ ok: true }))
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));

    stagePrompt(staged)
      .then(() => openPromise)
      .then((result) => sendResponse(result.ok ? { ok: true } : { ok: false, error: result.error }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "ASK_GPT_GET_ACTIVE_TAB_CONTEXT") {
    getActiveTabContext()
      .then((context) => sendResponse({ ok: true, context }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "ASK_GPT_RUN_PAGE_ACTION") {
    runPageAction(message.action)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  return false;
});

async function stagePrompt(payload) {
  await chrome.storage.session.set({
    askGptPendingPrompt: {
      ...payload,
      createdAt: Date.now()
    },
    askGptSourceTabId: payload.tabId
  });
}

async function openPanel(tabId) {
  if (!chrome.sidePanel?.open) return;
  if (chrome.sidePanel?.setOptions) {
    await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
  }
  await chrome.sidePanel.open({ tabId });
}

async function getActiveTabContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const stored = await chrome.storage.session.get(["askGptPendingPrompt", "askGptSourceTabId"]);
  const staged = stored.askGptPendingPrompt || {};
  const recentPrompt = Date.now() - (staged.createdAt || 0) < 10 * 60 * 1000;
  const sourceTabId = recentPrompt ? staged.tabId : stored.askGptSourceTabId;
  const sourceTab = await resolveContextTab(sourceTabId, tab);
  if (!sourceTab?.id) throw new Error("No active tab.");

  let page = {
    title: sourceTab.title || "",
    url: sourceTab.url || "",
    selection: staged.selection || "",
    text: "",
    interactive: [],
    canReadPage: false
  };

  try {
    const response = await chrome.tabs.sendMessage(sourceTab.id, { type: "ASK_GPT_COLLECT_CONTEXT" });
    if (response?.ok && response.context) page = { ...page, ...response.context, canReadPage: true };
  } catch {
    page.canReadPage = false;
  }

  if (staged.selection && !page.selection) page.selection = staged.selection;
  return {
    tabId: sourceTab.id,
    sourceTabId: sourceTab.id,
    page,
    pendingPrompt: recentPrompt ? staged.prompt || "" : "",
    pendingSource: staged.source || "action"
  };
}

async function rememberContextTab(tabId, knownTab) {
  const tab = knownTab || await chrome.tabs.get(tabId);
  if (!tab?.id || !isContextUrl(tab.url)) return;
  await chrome.storage.session.set({ askGptSourceTabId: tab.id });
  chrome.runtime.sendMessage({ type: "ASK_GPT_CONTEXT_SOURCE_CHANGED", tabId: tab.id }).catch(() => {});
}

async function resolveContextTab(tabId, activeTab) {
  if (tabId) {
    try {
      const source = await chrome.tabs.get(tabId);
      if (source?.id && isContextUrl(source.url)) return source;
    } catch {
      // Fall through to active tab.
    }
  }
  if (activeTab?.id && isContextUrl(activeTab.url)) {
    await chrome.storage.session.set({ askGptSourceTabId: activeTab.id });
    return activeTab;
  }
  const [fallback] = await chrome.tabs.query({ active: true, currentWindow: true });
  return fallback;
}

function isContextUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

async function runPageAction(action) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");

  if (action?.type === "navigate") {
    const url = normalizeUrl(action.url);
    if (!url) throw new Error("Invalid URL.");
    await chrome.tabs.update(tab.id, { url });
    return { message: `Navigated to ${url}` };
  }

  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "ASK_GPT_PAGE_ACTION",
    action
  });
  if (!response?.ok) throw new Error(response?.error || "Action failed.");
  return response.result;
}

function normalizeUrl(url) {
  if (typeof url !== "string") return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.href;
  } catch {
    return "";
  }
}
