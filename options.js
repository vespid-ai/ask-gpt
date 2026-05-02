const DEFAULT_SETTINGS = {
  authMode: "chatgpt-oauth",
  apiKey: "",
  model: "gpt-4.1-mini",
  codexModel: "gpt-5.4-mini",
  endpoint: "https://api.openai.com/v1/responses",
  includePage: true,
  includeSelection: true
};

const els = {
  form: document.getElementById("settingsForm"),
  authMode: () => document.querySelector("input[name='authMode']:checked")?.value || "chatgpt-oauth",
  authModeInputs: [...document.querySelectorAll("input[name='authMode']")],
  oauthStatus: document.getElementById("oauthStatus"),
  oauthDetail: document.getElementById("oauthDetail"),
  deviceCodePanel: document.getElementById("deviceCodePanel"),
  deviceCodeValue: document.getElementById("deviceCodeValue"),
  copyDeviceCode: document.getElementById("copyDeviceCode"),
  openDevicePage: document.getElementById("openDevicePage"),
  loginChatGPT: document.getElementById("loginChatGPT"),
  logoutChatGPT: document.getElementById("logoutChatGPT"),
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  codexModel: document.getElementById("codexModel"),
  endpoint: document.getElementById("endpoint"),
  includePage: document.getElementById("includePage"),
  includeSelection: document.getElementById("includeSelection"),
  showFloatingButton: document.getElementById("showFloatingButton"),
  testConnection: document.getElementById("testConnection"),
  status: document.getElementById("status")
};

let loginAbortController = null;
let currentDeviceCode = "";
let currentVerificationUrl = "";

load();

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await save();
});

els.testConnection.addEventListener("click", async () => {
  await save(false);
  els.status.textContent = "正在测试...";
  try {
    if (els.authMode() === "chatgpt-oauth") {
      const models = await AskGptAuth.fetchCodexModels();
      const smoke = await AskGptAuth.smokeCodexResponse(els.codexModel.value.trim() || DEFAULT_SETTINGS.codexModel);
      if (!/^ok$/i.test(smoke.trim())) throw new Error(`Codex responses smoke returned unexpected text: ${smoke}`);
      els.status.textContent = `连接正常：${models.length} 个模型，responses 返回 OK。`;
      return;
    } else {
      const response = await fetch(els.endpoint.value.trim(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${els.apiKey.value.trim()}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: els.model.value.trim(),
          input: "Reply with only OK."
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || `${response.status} ${response.statusText}`);
    }
    els.status.textContent = "连接正常。";
  } catch (error) {
    els.status.textContent = `连接失败：${String(error?.message || error)}`;
  }
});

els.loginChatGPT.addEventListener("click", async () => {
  if (loginAbortController) loginAbortController.abort();
  loginAbortController = new AbortController();
  els.loginChatGPT.disabled = true;
  hideDeviceCode();
  els.status.textContent = "正在请求 ChatGPT 登录码...";
  try {
    await AskGptAuth.startDeviceLogin((event) => {
      if (event.phase === "user_code" || event.phase === "polling") {
        showDeviceCode(event.userCode, event.verificationUrl);
        els.oauthStatus.textContent = "请在 OpenAI 页面输入登录码";
        els.oauthDetail.textContent = "授权页已经在后台打开；先复制下面的 9 位代码，再切到授权页粘贴。";
        els.status.textContent = `等待授权完成。登录码：${event.userCode}`;
      }
      if (event.phase === "complete") {
        hideDeviceCode();
        els.status.textContent = "ChatGPT OAuth 登录成功。";
      }
    }, { signal: loginAbortController.signal });
    await save(false);
    const models = await AskGptAuth.fetchCodexModels();
    const smoke = await AskGptAuth.smokeCodexResponse(els.codexModel.value.trim() || DEFAULT_SETTINGS.codexModel);
    if (!/^ok$/i.test(smoke.trim())) throw new Error(`Codex responses smoke returned unexpected text: ${smoke}`);
    await renderOAuthStatus();
    els.status.textContent = `ChatGPT OAuth 登录成功，已验证 ${models.length} 个模型，responses 返回 OK。`;
  } catch (error) {
    els.status.textContent = `登录失败：${String(error?.message || error)}`;
  } finally {
    loginAbortController = null;
    els.loginChatGPT.disabled = false;
  }
});

els.copyDeviceCode.addEventListener("click", async () => {
  if (!currentDeviceCode) return;
  try {
    await navigator.clipboard.writeText(currentDeviceCode.replace(/\s+/g, ""));
    els.status.textContent = `已复制登录码：${currentDeviceCode}`;
  } catch {
    els.status.textContent = `复制失败，请手动复制：${currentDeviceCode}`;
  }
});

els.openDevicePage.addEventListener("click", () => {
  if (!currentVerificationUrl) return;
  chrome.tabs.create({ url: currentVerificationUrl, active: true });
});

els.logoutChatGPT.addEventListener("click", async () => {
  if (loginAbortController) loginAbortController.abort();
  await AskGptAuth.clearOAuth();
  hideDeviceCode();
  await renderOAuthStatus();
  els.status.textContent = "已清除本扩展保存的 ChatGPT OAuth token。";
});

async function load() {
  const local = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const sync = await chrome.storage.sync.get({ showFloatingButton: true });
  for (const input of els.authModeInputs) input.checked = input.value === (local.authMode || DEFAULT_SETTINGS.authMode);
  els.apiKey.value = local.apiKey || "";
  els.model.value = local.model || DEFAULT_SETTINGS.model;
  els.codexModel.value = local.codexModel || DEFAULT_SETTINGS.codexModel;
  els.endpoint.value = local.endpoint || DEFAULT_SETTINGS.endpoint;
  els.includePage.checked = local.includePage !== false;
  els.includeSelection.checked = local.includeSelection !== false;
  els.showFloatingButton.checked = sync.showFloatingButton !== false;
  await renderOAuthStatus();
}

async function save(showStatus = true) {
  await chrome.storage.local.set({
    authMode: els.authMode(),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim() || DEFAULT_SETTINGS.model,
    codexModel: els.codexModel.value.trim() || DEFAULT_SETTINGS.codexModel,
    endpoint: els.endpoint.value.trim() || DEFAULT_SETTINGS.endpoint,
    includePage: els.includePage.checked,
    includeSelection: els.includeSelection.checked
  });
  await chrome.storage.sync.set({
    showFloatingButton: els.showFloatingButton.checked
  });
  if (showStatus) els.status.textContent = "已保存。刷新网页后悬浮按钮设置会生效。";
}

async function renderOAuthStatus() {
  const status = await AskGptAuth.getOAuthStatus();
  if (!status.loggedIn) {
    els.oauthStatus.textContent = "未登录 ChatGPT OAuth";
    els.oauthDetail.textContent = "使用 ChatGPT Pro 账号登录，走 Codex 同款 device-code OAuth。";
    hideDeviceCode();
    return;
  }
  hideDeviceCode();
  els.oauthStatus.textContent = status.label;
  const expires = status.expiresAt ? new Date(status.expiresAt).toLocaleString() : "未知";
  els.oauthDetail.textContent = `已登录。Access token 过期时间：${expires}`;
}

function showDeviceCode(userCode, verificationUrl) {
  currentDeviceCode = String(userCode || "").trim();
  currentVerificationUrl = verificationUrl || "https://auth.openai.com/codex/device";
  els.deviceCodeValue.textContent = currentDeviceCode;
  els.deviceCodePanel.hidden = false;
}

function hideDeviceCode() {
  currentDeviceCode = "";
  currentVerificationUrl = "";
  els.deviceCodeValue.textContent = "";
  els.deviceCodePanel.hidden = true;
}
