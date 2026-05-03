const DEFAULT_SETTINGS = {
  authMode: "chatgpt-oauth",
  apiKey: "",
  model: "gpt-4.1-mini",
  codexModel: "gpt-5.4-mini",
  endpoint: "https://api.openai.com/v1/responses",
  codexNativeMode: "exec",
  codexNativePath: "codex",
  codexAcpCommand: "codex acp",
  codexNativeCwd: "",
  codexNativeModel: "",
  codexNativeProfile: "",
  codexNativeSandbox: "workspace-write",
  codexNativeApproval: "never",
  codexNativeTimeout: 900,
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
  codexNativeMode: document.getElementById("codexNativeMode"),
  codexNativePath: document.getElementById("codexNativePath"),
  codexAcpCommand: document.getElementById("codexAcpCommand"),
  codexNativeCwd: document.getElementById("codexNativeCwd"),
  codexNativeModel: document.getElementById("codexNativeModel"),
  codexNativeProfile: document.getElementById("codexNativeProfile"),
  codexNativeSandbox: document.getElementById("codexNativeSandbox"),
  codexNativeApproval: document.getElementById("codexNativeApproval"),
  codexNativeTimeout: document.getElementById("codexNativeTimeout"),
  includePage: document.getElementById("includePage"),
  includeSelection: document.getElementById("includeSelection"),
  showFloatingButton: document.getElementById("showFloatingButton"),
  vaultStatus: document.getElementById("vaultStatus"),
  selectVault: document.getElementById("selectVault"),
  clearVault: document.getElementById("clearVault"),
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
    }
    if (els.authMode() === "codex-native") {
      const result = await AskGptCodexBridge.ping(readNativeSettingsFromForm());
      els.status.textContent = `本机 Codex Bridge 正常：${result.version || "codex 可用"}`;
      return;
    }
    {
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

els.selectVault.addEventListener("click", async () => {
  els.status.textContent = "正在请求 Obsidian vault 目录授权...";
  try {
    await AskGptVault.pickVault();
    await renderVaultStatus();
    els.status.textContent = "已保存 Obsidian vault 授权。";
  } catch (error) {
    els.status.textContent = `Vault 授权失败：${String(error?.message || error)}`;
    await renderVaultStatus();
  }
});

els.clearVault.addEventListener("click", async () => {
  await AskGptVault.clearVault();
  await renderVaultStatus();
  els.status.textContent = "已清除 Obsidian vault 授权。";
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
  els.codexNativeMode.value = local.codexNativeMode || DEFAULT_SETTINGS.codexNativeMode;
  els.codexNativePath.value = local.codexNativePath || DEFAULT_SETTINGS.codexNativePath;
  els.codexAcpCommand.value = local.codexAcpCommand || DEFAULT_SETTINGS.codexAcpCommand;
  els.codexNativeCwd.value = local.codexNativeCwd || DEFAULT_SETTINGS.codexNativeCwd;
  els.codexNativeModel.value = local.codexNativeModel || DEFAULT_SETTINGS.codexNativeModel;
  els.codexNativeProfile.value = local.codexNativeProfile || DEFAULT_SETTINGS.codexNativeProfile;
  els.codexNativeSandbox.value = local.codexNativeSandbox || DEFAULT_SETTINGS.codexNativeSandbox;
  els.codexNativeApproval.value = local.codexNativeApproval || DEFAULT_SETTINGS.codexNativeApproval;
  els.codexNativeTimeout.value = local.codexNativeTimeout || DEFAULT_SETTINGS.codexNativeTimeout;
  els.includePage.checked = local.includePage !== false;
  els.includeSelection.checked = local.includeSelection !== false;
  els.showFloatingButton.checked = sync.showFloatingButton !== false;
  await renderOAuthStatus();
  await renderVaultStatus();
}

async function save(showStatus = true) {
  await chrome.storage.local.set({
    authMode: els.authMode(),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim() || DEFAULT_SETTINGS.model,
    codexModel: els.codexModel.value.trim() || DEFAULT_SETTINGS.codexModel,
    endpoint: els.endpoint.value.trim() || DEFAULT_SETTINGS.endpoint,
    ...readNativeSettingsFromForm(),
    includePage: els.includePage.checked,
    includeSelection: els.includeSelection.checked
  });
  await chrome.storage.sync.set({
    showFloatingButton: els.showFloatingButton.checked
  });
  if (showStatus) els.status.textContent = "已保存。刷新网页后悬浮按钮设置会生效。";
}

function readNativeSettingsFromForm() {
  return {
    codexNativeMode: els.codexNativeMode.value || DEFAULT_SETTINGS.codexNativeMode,
    codexNativePath: els.codexNativePath.value.trim() || DEFAULT_SETTINGS.codexNativePath,
    codexAcpCommand: els.codexAcpCommand.value.trim() || DEFAULT_SETTINGS.codexAcpCommand,
    codexNativeCwd: els.codexNativeCwd.value.trim(),
    codexNativeModel: els.codexNativeModel.value.trim(),
    codexNativeProfile: els.codexNativeProfile.value.trim(),
    codexNativeSandbox: els.codexNativeSandbox.value || DEFAULT_SETTINGS.codexNativeSandbox,
    codexNativeApproval: els.codexNativeApproval.value || DEFAULT_SETTINGS.codexNativeApproval,
    codexNativeTimeout: Number(els.codexNativeTimeout.value || DEFAULT_SETTINGS.codexNativeTimeout)
  };
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

async function renderVaultStatus() {
  const status = await AskGptVault.getStatus();
  els.selectVault.disabled = !status.supported;
  els.clearVault.disabled = !status.supported || !status.configured;

  if (!status.supported) {
    els.vaultStatus.textContent = "当前 Chrome 环境不支持本地目录授权，无法自动保存 Obsidian 笔记。";
    return;
  }
  if (!status.configured) {
    els.vaultStatus.textContent = "未选择 vault。Agent 保存笔记前需要先授权一个本地目录。";
    return;
  }
  if (status.permission === "granted") {
    els.vaultStatus.textContent = `已选择 ${status.name}，Agent 可在自动审查通过后保存 Markdown 笔记。`;
    return;
  }
  els.vaultStatus.textContent = `已选择 ${status.name}，但 Chrome 需要在下次保存时重新确认写入权限。`;
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
