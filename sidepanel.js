const DEFAULT_SETTINGS = {
  authMode: "chatgpt-oauth",
  apiKey: "",
  model: "gpt-4.1-mini",
  codexModel: "gpt-5.4-mini",
  endpoint: "https://api.openai.com/v1/responses",
  includePage: true,
  includeSelection: true,
  showFloatingButton: true
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  context: null,
  messages: [],
  pendingAction: null,
  isSending: false,
  recognition: null
};

const els = {
  pageStatus: document.getElementById("pageStatus"),
  pageTitle: document.getElementById("pageTitle"),
  pageUrl: document.getElementById("pageUrl"),
  usePage: document.getElementById("usePage"),
  useSelection: document.getElementById("useSelection"),
  agentMode: document.getElementById("agentMode"),
  messages: document.getElementById("messages"),
  prompt: document.getElementById("prompt"),
  sendButton: document.getElementById("sendButton"),
  micButton: document.getElementById("micButton"),
  clearChat: document.getElementById("clearChat"),
  refreshContext: document.getElementById("refreshContext"),
  openOptions: document.getElementById("openOptions"),
  composer: document.getElementById("composer")
};

let eventsWired = false;

bootstrap().catch((error) => {
  console.error("Ask GPT side panel failed to initialize.", error);
  addMessage("system", `侧边栏初始化失败：${String(error?.message || error)}`);
});

async function bootstrap() {
  wireEvents();
  try {
    await loadSettings();
    els.usePage.checked = state.settings.includePage;
    els.useSelection.checked = state.settings.includeSelection;
  } catch (error) {
    console.error("Ask GPT settings load failed.", error);
    addMessage("system", `读取设置失败，已使用默认设置：${String(error?.message || error)}`);
  }

  await refreshContext();
  renderMessages();
}

function wireEvents() {
  if (eventsWired) return;
  eventsWired = true;

  els.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendPrompt(els.prompt.value.trim());
  });

  els.prompt.addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      await sendPrompt(els.prompt.value.trim());
    }
  });

  document.querySelectorAll(".quick-actions button").forEach((button) => {
    button.addEventListener("click", () => {
      els.prompt.value = button.dataset.prompt || "";
      els.prompt.focus();
    });
  });

  els.refreshContext.addEventListener("click", () => refreshContext());
  els.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.clearChat.addEventListener("click", () => {
    if (state.recognition) {
      state.recognition.stop();
      state.recognition = null;
      els.micButton.classList.remove("listening");
    }
    els.prompt.value = "";
    state.messages = [];
    state.pendingAction = null;
    renderMessages();
    els.prompt.focus();
  });

  els.usePage.addEventListener("change", persistContextToggles);
  els.useSelection.addEventListener("change", persistContextToggles);
  els.micButton.addEventListener("click", toggleVoiceInput);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "ASK_GPT_CONTEXT_SOURCE_CHANGED") {
      refreshContext({ preservePrompt: true });
    }
  });
}

async function loadSettings() {
  const local = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const sync = await chrome.storage.sync.get({ showFloatingButton: true });
  state.settings = { ...DEFAULT_SETTINGS, ...local, showFloatingButton: sync.showFloatingButton };
}

async function persistContextToggles() {
  state.settings.includePage = els.usePage.checked;
  state.settings.includeSelection = els.useSelection.checked;
  await chrome.storage.local.set({
    includePage: state.settings.includePage,
    includeSelection: state.settings.includeSelection
  });
}

async function refreshContext(options = {}) {
  els.pageStatus.textContent = "正在读取当前页面...";
  try {
    const response = await chrome.runtime.sendMessage({ type: "ASK_GPT_GET_ACTIVE_TAB_CONTEXT" });
    if (!response?.ok) throw new Error(response?.error || "Cannot read tab context.");
    state.context = response.context;
    renderContext();
    if (!options.preservePrompt && response.context.pendingPrompt) {
      els.prompt.value = response.context.pendingPrompt;
      els.prompt.focus();
    }
  } catch (error) {
    state.context = null;
    els.pageStatus.textContent = String(error?.message || error);
    els.pageTitle.textContent = "无法读取当前页面";
    els.pageUrl.textContent = "";
  }
}

function renderContext() {
  const page = state.context?.page || {};
  els.pageTitle.textContent = page.title || "当前页面";
  els.pageUrl.textContent = page.url || "";
  if (page.canReadPage) {
    els.pageStatus.textContent = `${countWords(page.text)} 字上下文 · ${page.interactive?.length || 0} 个可操作元素`;
  } else if (page.url) {
    els.pageStatus.textContent = "只能使用标题和 URL；正文不可读或内容脚本未注入";
  } else {
    els.pageStatus.textContent = "Chrome 内部页或受保护页面，无法读取正文";
  }
}

async function sendPrompt(prompt) {
  if (!prompt || state.isSending) return;
  if (state.settings.authMode === "api-key" && !state.settings.apiKey) {
    addMessage("system", "还没有设置 OpenAI API Key。点击右上角设置，填入 API Key 后再发送。");
    chrome.runtime.openOptionsPage();
    return;
  }
  if (state.settings.authMode === "chatgpt-oauth") {
    const status = await AskGptAuth.getOAuthStatus();
    if (!status.loggedIn) {
      addMessage("system", "还没有登录 ChatGPT OAuth。点击右上角设置，用 ChatGPT Pro 账号登录后再发送。");
      chrome.runtime.openOptionsPage();
      return;
    }
  }

  state.isSending = true;
  els.sendButton.disabled = true;
  els.prompt.value = "";
  state.messages.push({ role: "user", content: prompt });
  renderMessages();

  try {
    const answer = await callOpenAI(prompt);
    const { visibleText, action } = extractAction(answer);
    state.messages.push({ role: "assistant", content: visibleText || answer });
    state.pendingAction = action;
  } catch (error) {
    state.messages.push({ role: "system", content: `请求失败：${String(error?.message || error)}` });
  } finally {
    state.isSending = false;
    els.sendButton.disabled = false;
    renderMessages();
  }
}

async function callOpenAI(prompt) {
  if (state.settings.authMode === "chatgpt-oauth") {
    return callCodexResponses(prompt);
  }
  return callOpenAIResponses(prompt);
}

async function callOpenAIResponses(prompt) {
  const page = state.context?.page || {};
  const contextText = buildContextText(page);
  const agentInstruction = els.agentMode.checked
    ? `\nAgent mode is enabled. If the user explicitly asks you to operate the page, you may propose exactly one safe action using this exact tag after your answer: <askgpt-action>{"type":"click|fill|scroll|navigate","text":"visible text","selector":"optional css selector","value":"text for fill","url":"https://example.com","direction":"down","amount":600,"reason":"why this action is needed"}</askgpt-action>. Never propose purchase, payment, login, delete, submit, or irreversible actions.`
    : "\nAgent mode is disabled. Do not propose page actions.";

  const input = [
    {
      role: "system",
      content: `You are ChatGPT inside a Chrome side panel, matching ChatGPT Atlas' Ask ChatGPT behavior. Answer in the user's language. Use the page context when it is relevant, cite page facts as "页面中提到..." when useful, and stay concise unless asked for detail.${agentInstruction}`
    },
    ...state.messages.slice(-8).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    })),
    {
      role: "user",
      content: `${contextText}\n\n用户问题：${prompt}`
    }
  ];

  const response = await fetch(state.settings.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.settings.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: state.settings.model,
      input,
      temperature: 0.2
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return extractOutputText(data);
}

async function callCodexResponses(prompt) {
  const page = state.context?.page || {};
  const contextText = buildContextText(page);
  const accessToken = await AskGptAuth.getCodexAccessToken();
  const instructions = `You are ChatGPT inside a Chrome side panel, matching ChatGPT Atlas' Ask ChatGPT behavior. Answer in the user's language. Use the page context when it is relevant, cite page facts as "页面中提到..." when useful, and stay concise unless asked for detail.${els.agentMode.checked
    ? `\nAgent mode is enabled. If the user explicitly asks you to operate the page, you may propose exactly one safe action using this exact tag after your answer: <askgpt-action>{"type":"click|fill|scroll|navigate","text":"visible text","selector":"optional css selector","value":"text for fill","url":"https://example.com","direction":"down","amount":600,"reason":"why this action is needed"}</askgpt-action>. Never propose purchase, payment, login, delete, submit, or irreversible actions.`
    : "\nAgent mode is disabled. Do not propose page actions."}`;

  const input = [
    ...state.messages.slice(-8).map((message) => ({
      type: "message",
      role: message.role === "assistant" ? "assistant" : "user",
      content: [{
        type: message.role === "assistant" ? "output_text" : "input_text",
        text: message.content
      }]
    })),
    {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `${contextText}\n\n用户问题：${prompt}`
      }]
    }
  ];

  const response = await fetch(`${AskGptAuth.CODEX_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    },
    body: JSON.stringify({
      model: state.settings.codexModel,
      instructions,
      input,
      stream: true,
      store: false
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `${response.status} ${response.statusText}`);
  }
  return readSseOutputText(response);
}

async function readSseOutputText(response) {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let doneText = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      let event;
      try {
        event = JSON.parse(dataLine.slice(6));
      } catch {
        continue;
      }
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") output += event.delta;
      if (event.type === "response.output_text.done" && typeof event.text === "string") doneText = event.text;
      if (event.type === "response.failed" || event.type === "error") {
        throw new Error(event.error?.message || event.message || "Codex response failed.");
      }
    }
  }

  return (doneText || output).trim();
}

function buildContextText(page) {
  const chunks = [
    "当前网页上下文：",
    `标题：${page.title || "未知"}`,
    `URL：${page.url || "未知"}`
  ];

  if (els.useSelection.checked && page.selection) {
    chunks.push(`用户选中的文本：\n${page.selection}`);
  }

  if (els.usePage.checked && page.text) {
    chunks.push(`页面正文摘录：\n${page.text}`);
  }

  if (els.agentMode.checked && page.interactive?.length) {
    chunks.push(`可见可操作元素：\n${page.interactive.map((item, index) => `${index + 1}. ${item.tag}: ${item.label}${item.href ? ` (${item.href})` : ""}`).join("\n")}`);
  }

  return chunks.join("\n\n");
}

function extractOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  if (Array.isArray(data.output)) {
    return data.output.flatMap((item) => {
      if (Array.isArray(item.content)) {
        return item.content.map((part) => part.text || part.output_text || "").filter(Boolean);
      }
      return item.text || "";
    }).filter(Boolean).join("\n");
  }
  if (Array.isArray(data.choices)) {
    return data.choices.map((choice) => choice.message?.content || choice.text || "").filter(Boolean).join("\n");
  }
  return JSON.stringify(data, null, 2);
}

function extractAction(answer) {
  const match = answer.match(/<askgpt-action>([\s\S]*?)<\/askgpt-action>/i);
  if (!match) return { visibleText: answer.trim(), action: null };
  let action = null;
  try {
    action = JSON.parse(match[1]);
  } catch {
    action = null;
  }
  return {
    visibleText: answer.replace(match[0], "").trim(),
    action
  };
}

function renderMessages() {
  els.messages.innerHTML = "";
  if (!state.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "我会带着当前页面和选中文本来回答。打开 Agent 后，页面动作会先生成确认卡，再由你决定是否执行。";
    els.messages.appendChild(empty);
  }

  for (const message of state.messages) {
    const bubble = document.createElement("article");
    bubble.className = `message ${message.role}`;
    bubble.textContent = message.content;
    els.messages.appendChild(bubble);
  }

  if (state.pendingAction) renderActionCard(state.pendingAction);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderActionCard(action) {
  const card = document.createElement("section");
  card.className = "action-card";
  const label = action.reason || describeAction(action);
  card.innerHTML = `
    <strong>Agent 建议执行页面动作</strong>
    <p></p>
    <div class="action-buttons">
      <button class="run" type="button">执行</button>
      <button class="dismiss" type="button">忽略</button>
    </div>
  `;
  card.querySelector("p").textContent = label;
  card.querySelector(".run").addEventListener("click", () => executePendingAction(action));
  card.querySelector(".dismiss").addEventListener("click", () => {
    state.pendingAction = null;
    renderMessages();
  });
  els.messages.appendChild(card);
}

async function executePendingAction(action) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "ASK_GPT_RUN_PAGE_ACTION", action });
    if (!response?.ok) throw new Error(response?.error || "Action failed.");
    addMessage("system", response.result?.message || "页面动作已执行。");
    state.pendingAction = null;
    await refreshContext();
  } catch (error) {
    addMessage("system", `页面动作失败：${String(error?.message || error)}`);
  }
}

function addMessage(role, content) {
  state.messages.push({ role, content });
  renderMessages();
}

function describeAction(action) {
  if (action.type === "navigate") return `打开 ${action.url}`;
  if (action.type === "click") return `点击 ${action.text || action.selector || "页面元素"}`;
  if (action.type === "fill") return `填写 ${action.text || action.selector || "输入框"}`;
  if (action.type === "scroll") return `滚动页面 ${action.direction || "down"}`;
  return "执行受限页面动作";
}

async function toggleVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    addMessage("system", "当前 Chrome 环境不支持 Web Speech 语音输入。");
    return;
  }

  if (state.recognition) {
    state.recognition.stop();
    state.recognition = null;
    els.micButton.classList.remove("listening");
    return;
  }

  try {
    await ensureMicrophonePermission();
  } catch (error) {
    addMessage("system", microphoneErrorMessage(error));
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = navigator.language || "zh-CN";
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.onresult = (event) => {
    const text = Array.from(event.results).map((result) => result[0]?.transcript || "").join("");
    els.prompt.value = text;
  };
  recognition.onend = () => {
    state.recognition = null;
    els.micButton.classList.remove("listening");
  };
  recognition.onerror = (event) => {
    const reason = event?.error || "unknown";
    state.recognition = null;
    els.micButton.classList.remove("listening");
    if (reason === "aborted" || reason === "no-speech") return;
    addMessage("system", microphoneErrorMessage(new Error(reason)));
  };
  state.recognition = recognition;
  els.micButton.classList.add("listening");
  try {
    recognition.start();
  } catch (error) {
    state.recognition = null;
    els.micButton.classList.remove("listening");
    addMessage("system", microphoneErrorMessage(error));
  }
}

async function ensureMicrophonePermission() {
  await allowExtensionMicrophone();

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("media-devices-unavailable");
  }

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    throw error;
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

async function allowExtensionMicrophone() {
  if (!chrome.contentSettings?.microphone) return;

  const primaryPattern = `${location.origin}/*`;
  try {
    await chrome.contentSettings.microphone.set({
      primaryPattern,
      setting: "allow"
    });
  } catch (error) {
    console.warn("Could not set extension microphone permission.", error);
  }
}

function microphoneErrorMessage(error) {
  const raw = String(error?.name || error?.message || error || "");
  const reason = raw.toLowerCase();
  if (reason.includes("notallowed") || reason.includes("permission") || reason.includes("not-allowed")) {
    return "麦克风权限被拒绝。请在 Chrome 的麦克风设置里允许此扩展，或在 macOS 系统设置的“隐私与安全性 > 麦克风”里允许 Chrome，然后重新加载扩展。";
  }
  if (reason.includes("notfound") || reason.includes("devicesnotfound") || reason.includes("audio-capture")) {
    return "没有检测到可用麦克风。请确认系统里有输入设备，并且 Chrome 可以访问它。";
  }
  if (reason.includes("notreadable") || reason.includes("trackstarterror")) {
    return "麦克风当前不可读，可能正被其他应用占用。关闭占用麦克风的应用后再试。";
  }
  if (reason.includes("network")) {
    return "语音识别服务连接失败。麦克风权限可能已正常，但 Chrome 的 Web Speech 服务当前不可用。";
  }
  if (reason.includes("media-devices-unavailable")) {
    return "当前页面无法调用麦克风授权接口。请重新加载扩展后再试。";
  }
  return `语音输入启动失败：${raw || "未知错误"}`;
}

function countWords(text) {
  return String(text || "").length.toLocaleString();
}
