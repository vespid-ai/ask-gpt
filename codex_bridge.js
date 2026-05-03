const AskGptCodexBridge = (() => {
  const HOST_NAME = "com.ask_gpt.codex_bridge";

  function ping(settings = {}) {
    return send({
      type: "ping",
      codexPath: settings.codexNativePath || "codex"
    });
  }

  function run(prompt, settings = {}) {
    return send({
      type: "codex_run",
      mode: settings.codexNativeMode || "exec",
      prompt,
      codexPath: settings.codexNativePath || "codex",
      acpCommand: settings.codexAcpCommand || "",
      cwd: settings.codexNativeCwd || "",
      model: settings.codexNativeModel || "",
      profile: settings.codexNativeProfile || "",
      sandbox: settings.codexNativeSandbox || "workspace-write",
      approvalPolicy: settings.codexNativeApproval || "never",
      timeoutSeconds: Number(settings.codexNativeTimeout || 900) || 900
    });
  }

  function send(message) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.sendNativeMessage) {
        reject(new Error("当前扩展没有 nativeMessaging 能力。"));
        return;
      }
      chrome.runtime.sendNativeMessage(HOST_NAME, message, (response) => {
        const nativeError = chrome.runtime.lastError?.message;
        if (nativeError) {
          reject(new Error(`${nativeError}。请确认已安装 Ask GPT Codex native host。`));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Codex native bridge failed."));
          return;
        }
        resolve(response);
      });
    });
  }

  return {
    HOST_NAME,
    ping,
    run
  };
})();
