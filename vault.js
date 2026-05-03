const AskGptVault = (() => {
  const DB_NAME = "ask-gpt-vault";
  const DB_VERSION = 1;
  const STORE_NAME = "handles";
  const HANDLE_KEY = "obsidianVault";
  const DEFAULT_FOLDER = "Ask GPT";
  const MAX_NOTE_CHARS = 120000;

  function isSupported() {
    return Boolean(window.showDirectoryPicker && window.indexedDB);
  }

  async function pickVault() {
    if (!isSupported()) throw new Error("当前 Chrome 环境不支持本地目录授权。");
    const handle = await window.showDirectoryPicker({
      id: "ask-gpt-obsidian-vault",
      mode: "readwrite"
    });
    const permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") throw new Error("没有获得 Obsidian vault 写入权限。");
    await saveHandle(handle);
    return handle;
  }

  async function clearVault() {
    const db = await openDb();
    await requestToPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(HANDLE_KEY));
    db.close();
  }

  async function getStatus() {
    if (!isSupported()) {
      return { supported: false, configured: false, permission: "unsupported", name: "" };
    }
    const handle = await getHandle();
    if (!handle) return { supported: true, configured: false, permission: "missing", name: "" };
    const permission = await handle.queryPermission({ mode: "readwrite" }).catch(() => "prompt");
    return {
      supported: true,
      configured: true,
      permission,
      name: handle.name || "Obsidian vault"
    };
  }

  async function writeMarkdownNote(action, { promptIfNeeded = false } = {}) {
    const reviewed = reviewSaveNoteAction(action);
    if (!reviewed.ok) throw new Error(reviewed.reason);

    const handle = await ensureWritableHandle({ promptIfNeeded });
    const folderHandle = await ensureFolder(handle, reviewed.folder);
    const fileName = await nextAvailableFileName(folderHandle, `${reviewed.fileTitle}.md`);
    const fileHandle = await folderHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(reviewed.content);
    await writable.close();

    return {
      fileName,
      folder: reviewed.folder.join("/"),
      vaultName: handle.name || "Obsidian vault",
      title: reviewed.title
    };
  }

  function reviewSaveNoteAction(action) {
    if (!action || typeof action !== "object") return { ok: false, reason: "缺少保存请求。" };
    if (action.type !== "save_note") return { ok: false, reason: `不支持的保存动作：${action.type}` };

    const title = normalizeLine(action.title || "当前页面解释").slice(0, 120);
    const content = normalizeContent(action.content || "");
    if (!content) return { ok: false, reason: "保存请求里没有 Markdown 内容。" };
    if (content.length > MAX_NOTE_CHARS) return { ok: false, reason: "Markdown 内容过长，已拒绝自动保存。" };

    const rawFolder = String(action.folder || DEFAULT_FOLDER);
    if (isUnsafeFolder(rawFolder)) return { ok: false, reason: "目标目录必须是 vault 内的相对路径。" };

    if (action.fileName && /[\\/]/.test(String(action.fileName))) {
      return { ok: false, reason: "文件名不能包含路径分隔符。" };
    }

    const folder = normalizeFolder(rawFolder);
    const fileTitle = sanitizeFileName(action.fileName || title || "Ask GPT Note").replace(/\.md$/i, "");
    if (!fileTitle) return { ok: false, reason: "文件名为空或不安全。" };

    return {
      ok: true,
      title,
      fileTitle: fileTitle.slice(0, 96),
      folder,
      content: content.endsWith("\n") ? content : `${content}\n`
    };
  }

  async function ensureWritableHandle({ promptIfNeeded = false } = {}) {
    let handle = await getHandle();
    if (!handle) {
      if (!promptIfNeeded) throw new Error("还没有选择 Obsidian vault。");
      handle = await pickVault();
    }

    let permission = await handle.queryPermission({ mode: "readwrite" }).catch(() => "prompt");
    if (permission !== "granted" && promptIfNeeded) {
      permission = await handle.requestPermission({ mode: "readwrite" });
    }
    if (permission !== "granted") {
      throw new Error("Obsidian vault 写入权限尚未授权。");
    }
    return handle;
  }

  async function ensureFolder(root, segments) {
    let current = root;
    for (const segment of segments) {
      current = await current.getDirectoryHandle(segment, { create: true });
    }
    return current;
  }

  async function nextAvailableFileName(folderHandle, preferredName) {
    const safeName = sanitizeFileName(preferredName || "Ask GPT Note.md");
    const base = safeName.replace(/\.md$/i, "");
    const ext = ".md";
    for (let index = 0; index < 100; index += 1) {
      const candidate = index === 0 ? `${base}${ext}` : `${base}-${index + 1}${ext}`;
      try {
        await folderHandle.getFileHandle(candidate, { create: false });
      } catch {
        return candidate;
      }
    }
    return `${base}-${Date.now()}${ext}`;
  }

  function normalizeFolder(value) {
    const segments = String(value || DEFAULT_FOLDER)
      .split(/[\\/]+/)
      .map((segment) => sanitizeFileName(segment).replace(/\.md$/i, ""))
      .filter((segment) => segment && segment !== "." && segment !== "..")
      .slice(0, 6);
    return segments.length ? segments : [DEFAULT_FOLDER];
  }

  function isUnsafeFolder(value) {
    const raw = String(value || "").trim();
    if (/^(\/|~\/|[a-zA-Z]:[\\/])/.test(raw)) return true;
    return raw.split(/[\\/]+/).some((segment) => segment.trim() === "..");
  }

  function sanitizeFileName(value) {
    return normalizeLine(value)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/^\.+$/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  function normalizeLine(value) {
    return String(value || "").replace(/[\r\n]+/g, " ").trim();
  }

  function normalizeContent(value) {
    return String(value || "").replace(/\r/g, "\n").trim();
  }

  async function saveHandle(handle) {
    const db = await openDb();
    await requestToPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(handle, HANDLE_KEY));
    db.close();
  }

  async function getHandle() {
    const db = await openDb();
    const handle = await requestToPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(HANDLE_KEY));
    db.close();
    return handle || null;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("打开本地授权数据库失败。"));
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("本地授权数据库操作失败。"));
    });
  }

  return {
    DEFAULT_FOLDER,
    clearVault,
    getStatus,
    isSupported,
    pickVault,
    reviewSaveNoteAction,
    writeMarkdownNote
  };
})();
