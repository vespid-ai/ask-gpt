const AskGptAuth = (() => {
  const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
  const CODEX_ISSUER = "https://auth.openai.com";
  const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
  const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
  const REFRESH_SKEW_SECONDS = 120;

  async function getStoredOAuth() {
    const { codexOAuth = null } = await chrome.storage.local.get({ codexOAuth: null });
    return codexOAuth && typeof codexOAuth === "object" ? codexOAuth : null;
  }

  async function saveOAuth(tokens) {
    const current = (await getStoredOAuth()) || {};
    const next = {
      access_token: String(tokens.access_token || "").trim(),
      refresh_token: String(tokens.refresh_token || current.refresh_token || "").trim(),
      token_type: String(tokens.token_type || current.token_type || "Bearer"),
      last_refresh: new Date().toISOString()
    };
    if (!next.access_token || !next.refresh_token) {
      throw new Error("OAuth token response missing access_token or refresh_token.");
    }
    await chrome.storage.local.set({ codexOAuth: next, authMode: "chatgpt-oauth" });
    return next;
  }

  async function clearOAuth() {
    await chrome.storage.local.remove("codexOAuth");
  }

  function decodeJwtClaims(token) {
    if (!token || typeof token !== "string" || token.split(".").length !== 3) return {};
    try {
      const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
      return JSON.parse(atob(padded));
    } catch {
      return {};
    }
  }

  function isAccessTokenExpiring(accessToken, skewSeconds = REFRESH_SKEW_SECONDS) {
    const exp = decodeJwtClaims(accessToken).exp;
    if (typeof exp !== "number") return true;
    return exp <= Math.floor(Date.now() / 1000) + Math.max(0, Number(skewSeconds) || 0);
  }

  async function refreshOAuth(tokens) {
    if (!tokens?.refresh_token) throw new Error("ChatGPT OAuth refresh token missing. Please sign in again.");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CODEX_CLIENT_ID
    });
    const response = await fetch(CODEX_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = data.error_description || data.message || data.error || `${response.status} ${response.statusText}`;
      throw new Error(`ChatGPT OAuth refresh failed: ${reason}`);
    }
    if (!data.access_token) throw new Error("ChatGPT OAuth refresh response was missing access_token.");
    return saveOAuth(data);
  }

  async function getCodexAccessToken({ forceRefresh = false } = {}) {
    let tokens = await getStoredOAuth();
    if (!tokens?.access_token) throw new Error("Not signed in with ChatGPT OAuth.");
    if (forceRefresh || isAccessTokenExpiring(tokens.access_token)) {
      tokens = await refreshOAuth(tokens);
    }
    return tokens.access_token;
  }

  async function getOAuthStatus() {
    const tokens = await getStoredOAuth();
    if (!tokens?.access_token) return { loggedIn: false, label: "未登录 ChatGPT OAuth" };
    const claims = decodeJwtClaims(tokens.access_token);
    const expMs = typeof claims.exp === "number" ? claims.exp * 1000 : 0;
    return {
      loggedIn: true,
      label: claims.email || claims["https://api.openai.com/profile"]?.email || "ChatGPT OAuth 已登录",
      expiresAt: expMs || null,
      expiring: isAccessTokenExpiring(tokens.access_token)
    };
  }

  async function startDeviceLogin(onUpdate = () => {}, { signal } = {}) {
    const deviceResponse = await fetch(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      signal
    });
    const deviceData = await deviceResponse.json().catch(() => ({}));
    if (!deviceResponse.ok) {
      throw new Error(deviceData.message || `Device code request failed: ${deviceResponse.status}`);
    }

    const userCode = deviceData.user_code || "";
    const deviceAuthId = deviceData.device_auth_id || "";
    const intervalSeconds = Math.max(3, Number(deviceData.interval || 5));
    if (!userCode || !deviceAuthId) throw new Error("Device auth response missing user_code or device_auth_id.");

    const verificationUrl = `${CODEX_ISSUER}/codex/device`;
    onUpdate({ phase: "user_code", userCode, verificationUrl, intervalSeconds });
    chrome.tabs.create({ url: verificationUrl, active: false });

    const startedAt = Date.now();
    while (Date.now() - startedAt < 15 * 60 * 1000) {
      await sleep(intervalSeconds * 1000, signal);
      const pollResponse = await fetch(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        signal
      });
      if (pollResponse.status === 403 || pollResponse.status === 404) {
        onUpdate({ phase: "polling", userCode, verificationUrl });
        continue;
      }
      const pollData = await pollResponse.json().catch(() => ({}));
      if (!pollResponse.ok) {
        throw new Error(pollData.message || `Device auth polling failed: ${pollResponse.status}`);
      }

      const authorizationCode = pollData.authorization_code || "";
      const codeVerifier = pollData.code_verifier || "";
      if (!authorizationCode || !codeVerifier) throw new Error("Device auth response missing authorization code.");

      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
        client_id: CODEX_CLIENT_ID,
        code_verifier: codeVerifier
      });
      const tokenResponse = await fetch(CODEX_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: tokenBody,
        signal
      });
      const tokenData = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok) {
        throw new Error(tokenData.error_description || tokenData.message || `Token exchange failed: ${tokenResponse.status}`);
      }
      if (!tokenData.access_token) throw new Error("Token exchange did not return access_token.");
      const saved = await saveOAuth(tokenData);
      onUpdate({ phase: "complete" });
      return saved;
    }

    throw new Error("ChatGPT OAuth login timed out after 15 minutes.");
  }

  async function fetchCodexModels() {
    const token = await getCodexAccessToken();
    const response = await fetch(`${CODEX_BASE_URL}/models?client_version=1.0.0`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.detail || data.message || `${response.status} ${response.statusText}`);
    }
    return data.models || [];
  }

  async function smokeCodexResponse(model = "gpt-5.4-mini") {
    const token = await getCodexAccessToken();
    const response = await fetch(`${CODEX_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify({
        model,
        instructions: "You are a terse verification assistant.",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Reply with OK only." }]
        }],
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

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }

  return {
    CODEX_BASE_URL,
    getOAuthStatus,
    startDeviceLogin,
    getCodexAccessToken,
    refreshOAuth,
    clearOAuth,
    decodeJwtClaims,
    isAccessTokenExpiring,
    fetchCodexModels,
    smokeCodexResponse
  };
})();
