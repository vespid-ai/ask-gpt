const MAX_TEXT = 18000;
const MAX_ITEMS = 80;

initFloatingButton();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ASK_GPT_COLLECT_CONTEXT") {
    sendResponse({ ok: true, context: collectPageContext() });
    return false;
  }

  if (message?.type === "ASK_GPT_PAGE_ACTION") {
    try {
      const result = runPageAction(message.action || {});
      sendResponse({ ok: true, result });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
    return false;
  }

  return false;
});

function initFloatingButton() {
  if (window.top !== window || document.getElementById("ask-gpt-launcher")) return;

  chrome.storage.sync.get({ showFloatingButton: true }, ({ showFloatingButton }) => {
    if (!showFloatingButton || document.getElementById("ask-gpt-launcher")) return;

    const button = document.createElement("button");
    button.id = "ask-gpt-launcher";
    button.className = "ask-gpt-launcher";
    button.type = "button";
    button.setAttribute("aria-label", "问问 ChatGPT");
    button.innerHTML = `<span class="ask-gpt-launcher__mark">◎</span><span>问问 ChatGPT</span>`;
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openAskGptFromFloatingButton(button);
    });
    document.documentElement.appendChild(button);
  });
}

function openAskGptFromFloatingButton(button) {
  if (button.dataset.opening === "true") return;
  button.dataset.opening = "true";
  button.classList.remove("ask-gpt-launcher--error");
  button.classList.add("ask-gpt-launcher--opening");

  chrome.runtime.sendMessage(
    {
      type: "ASK_GPT_OPEN",
      source: "floating-button",
      selection: window.getSelection()?.toString() || ""
    },
    (response) => {
      const error = chrome.runtime.lastError?.message || response?.error || "";
      button.dataset.opening = "false";
      button.classList.remove("ask-gpt-launcher--opening");
      if (!response?.ok || error) {
        button.classList.add("ask-gpt-launcher--error");
        button.title = `打开失败：${error || "未知错误"}`;
        setTimeout(() => button.classList.remove("ask-gpt-launcher--error"), 1800);
        if (String(error).includes("sidePanel.open")) toggleEmbeddedPanel();
        return;
      }
      button.title = "";
    }
  );
}

function toggleEmbeddedPanel() {
  const existing = document.getElementById("ask-gpt-embedded-panel");
  if (existing) {
    existing.remove();
    return;
  }

  const panel = document.createElement("aside");
  panel.id = "ask-gpt-embedded-panel";
  panel.className = "ask-gpt-embedded-panel";
  panel.setAttribute("aria-label", "问问 ChatGPT 内嵌侧栏");

  const close = document.createElement("button");
  close.className = "ask-gpt-embedded-panel__close";
  close.type = "button";
  close.setAttribute("aria-label", "关闭问问 ChatGPT");
  close.textContent = "×";
  close.addEventListener("click", () => panel.remove());

  const frame = document.createElement("iframe");
  frame.className = "ask-gpt-embedded-panel__frame";
  frame.title = "问问 ChatGPT";
  frame.src = chrome.runtime.getURL("sidepanel.html?embedded=1");

  panel.append(close, frame);
  document.documentElement.appendChild(panel);
}

function collectPageContext() {
  const selection = window.getSelection()?.toString().trim() || "";
  const text = extractReadableText();

  return {
    title: document.title,
    url: location.href,
    selection: selection.slice(0, 6000),
    text: text.slice(0, MAX_TEXT),
    interactive: collectInteractiveElements(),
    canReadPage: true,
    capturedAt: new Date().toISOString()
  };
}

function extractReadableText() {
  const special = extractSpecialPageText();
  if (special) return special;

  const clone = document.body?.cloneNode(true);
  const metadata = extractPageMetadata();
  if (!clone) return metadata;

  for (const node of clone.querySelectorAll("script, style, noscript, svg, canvas, iframe, video, audio, nav, footer")) {
    node.remove();
  }

  const preferred = clone.querySelector("main, article, [role='main'], .content, #content");
  const raw = (preferred || clone).innerText || (preferred || clone).textContent || "";
  return [metadata, normalizeBlockText(raw)].filter(Boolean).join("\n\n");
}

function extractSpecialPageText() {
  if (isXStatusPage()) return extractXStatusText();
  return "";
}

function isXStatusPage() {
  if (!["x.com", "twitter.com", "www.x.com", "www.twitter.com"].includes(location.hostname)) return false;
  return /\/status\/\d+/.test(location.pathname);
}

function extractXStatusText() {
  const metadata = extractPageMetadata();
  const articles = Array.from(document.querySelectorAll("article")).filter(isVisible);
  const primaryArticle =
    articles.find((article) => article.querySelector("[data-testid='tweetText']")) ||
    articles[0];

  const parts = ["页面类型：X/Twitter 帖子", metadata].filter(Boolean);
  if (!primaryArticle) return parts.join("\n\n");

  const tweetText = uniqueStrings(
    Array.from(primaryArticle.querySelectorAll("[data-testid='tweetText']"))
      .map((node) => normalizeBlockText(node.innerText || node.textContent))
      .filter(Boolean)
  ).join("\n\n");

  const articleText = normalizeBlockText(primaryArticle.innerText || primaryArticle.textContent);
  const mediaDescriptions = uniqueStrings(
    Array.from(primaryArticle.querySelectorAll("img[alt]"))
      .map((img) => normalizeText(img.getAttribute("alt")))
      .filter((alt) => alt && !/^Image$|^头像$|^Profile picture$/i.test(alt))
  );
  const links = uniqueStrings(
    Array.from(primaryArticle.querySelectorAll("a[href]"))
      .map((anchor) => anchor.href)
      .filter((href) => href && !href.startsWith(`${location.origin}${location.pathname}`))
  ).slice(0, 12);

  if (tweetText) parts.push(`主帖正文：\n${tweetText}`);
  if (articleText && articleText !== tweetText) parts.push(`主帖可见文本：\n${articleText}`);
  if (mediaDescriptions.length) parts.push(`媒体说明：\n${mediaDescriptions.join("\n")}`);
  if (links.length) parts.push(`主帖相关链接：\n${links.join("\n")}`);
  return parts.join("\n\n");
}

function extractPageMetadata() {
  const title = normalizeText(document.title);
  const description = normalizeText(
    getMetaContent("meta[property='og:description']") ||
      getMetaContent("meta[name='description']") ||
      getMetaContent("meta[name='twitter:description']")
  );
  const ogTitle = normalizeText(
    getMetaContent("meta[property='og:title']") ||
      getMetaContent("meta[name='twitter:title']")
  );
  const canonical = document.querySelector("link[rel='canonical']")?.href || location.href;
  const headings = uniqueStrings(
    Array.from(document.querySelectorAll("h1, h2"))
      .filter(isVisible)
      .map((heading) => normalizeText(heading.innerText || heading.textContent))
      .filter(Boolean)
  ).slice(0, 8);

  const parts = [];
  if (title) parts.push(`标题：${title}`);
  if (ogTitle && ogTitle !== title) parts.push(`页面标题：${ogTitle}`);
  parts.push(`URL：${canonical}`);
  if (description) parts.push(`摘要：${description}`);
  if (headings.length) parts.push(`页面标题层级：\n${headings.join("\n")}`);
  return parts.join("\n");
}

function getMetaContent(selector) {
  return document.querySelector(selector)?.getAttribute("content") || "";
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

function collectInteractiveElements() {
  const selectors = [
    "a[href]",
    "button",
    "input:not([type='hidden'])",
    "textarea",
    "select",
    "[role='button']",
    "[contenteditable='true']"
  ];

  const items = [];
  for (const el of document.querySelectorAll(selectors.join(","))) {
    if (!isVisible(el)) continue;
    const label = getElementLabel(el);
    if (!label && !el.getAttribute("aria-label")) continue;
    items.push({
      tag: el.tagName.toLowerCase(),
      label: label.slice(0, 140),
      href: el instanceof HTMLAnchorElement ? el.href : "",
      name: el.getAttribute("name") || "",
      placeholder: el.getAttribute("placeholder") || "",
      role: el.getAttribute("role") || ""
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

function runPageAction(action) {
  if (!action || typeof action !== "object") throw new Error("Missing action.");

  if (action.type === "scroll") {
    const amount = Number(action.amount || window.innerHeight * 0.8);
    const direction = action.direction === "up" ? -1 : 1;
    window.scrollBy({ top: amount * direction, behavior: "smooth" });
    return { message: `Scrolled ${action.direction === "up" ? "up" : "down"}.` };
  }

  if (action.type === "click") {
    const element = findElement(action);
    if (!element) throw new Error("Could not find a visible clickable element.");
    element.click();
    return { message: `Clicked: ${getElementLabel(element) || action.text || action.selector}` };
  }

  if (action.type === "fill") {
    const element = findElement(action, true);
    if (!element) throw new Error("Could not find a visible input element.");
    const value = String(action.value || "");
    setElementValue(element, value);
    return { message: `Filled: ${getElementLabel(element) || action.selector || action.text}` };
  }

  throw new Error(`Unsupported action: ${action.type}`);
}

function findElement(action, wantsInput = false) {
  if (action.selector) {
    try {
      const selected = document.querySelector(action.selector);
      if (selected && isVisible(selected)) return selected;
    } catch {
      // Ignore invalid selectors and fall through to text matching.
    }
  }

  const selector = wantsInput
    ? "input:not([type='hidden']), textarea, [contenteditable='true']"
    : "button, a[href], [role='button'], input[type='button'], input[type='submit']";
  const needle = normalizeText(String(action.text || action.label || action.name || "")).toLowerCase();
  if (!needle) return null;

  for (const el of document.querySelectorAll(selector)) {
    if (!isVisible(el)) continue;
    const haystack = normalizeText([
      getElementLabel(el),
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("name"),
      el.getAttribute("title")
    ].filter(Boolean).join(" ")).toLowerCase();
    if (haystack.includes(needle) || needle.includes(haystack)) return el;
  }
  return null;
}

function setElementValue(element, value) {
  if (element.isContentEditable) {
    element.focus();
    element.textContent = value;
  } else {
    element.focus();
    element.value = value;
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function getElementLabel(el) {
  const id = el.getAttribute("id");
  const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.innerText : "";
  return normalizeText(
    label ||
      el.getAttribute("aria-label") ||
      el.getAttribute("alt") ||
      el.getAttribute("title") ||
      el.innerText ||
      el.textContent ||
      el.value ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      ""
  );
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeBlockText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .join("\n");
}
