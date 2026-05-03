#!/usr/bin/env python3
import json
import os
import select
import shlex
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

MAX_MESSAGE_BYTES = 4 * 1024 * 1024
MAX_PROMPT_CHARS = 500_000
MAX_RESPONSE_CHARS = 700_000


def main():
    try:
        request = read_native_message()
        response = handle_request(request)
    except Exception as exc:
        response = {"ok": False, "error": str(exc)}
    write_native_message(response)


def read_native_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) != 4:
        raise ValueError("Native message length header missing.")
    length = struct.unpack("<I", raw_length)[0]
    if length <= 0 or length > MAX_MESSAGE_BYTES:
        raise ValueError("Native message size is invalid.")
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise ValueError("Native message payload was truncated.")
    return json.loads(payload.decode("utf-8"))


def write_native_message(message):
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def handle_request(request):
    msg_type = request.get("type")
    if msg_type == "ping":
        codex_path = clean_text(request.get("codexPath") or "codex", 400)
        version = run_version(codex_path)
        return {"ok": True, "version": version}
    if msg_type == "codex_run":
        prompt = clean_text(request.get("prompt") or "", MAX_PROMPT_CHARS)
        if not prompt:
            raise ValueError("Prompt is empty.")
        mode = request.get("mode") or "exec"
        if mode == "acp":
            return run_acp(request, prompt)
        return run_codex_exec(request, prompt)
    raise ValueError(f"Unsupported native bridge message type: {msg_type}")


def run_version(codex_path):
    result = subprocess.run(
        [codex_path, "--version"],
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "codex --version failed").strip())
    return (result.stdout or result.stderr).strip()


def run_codex_exec(request, prompt):
    codex_path = clean_text(request.get("codexPath") or "codex", 400)
    cwd = normalize_cwd(request.get("cwd") or "")
    timeout = normalize_timeout(request.get("timeoutSeconds"), 900)

    with tempfile.NamedTemporaryFile("w+", encoding="utf-8", delete=False, suffix=".txt") as out_file:
        output_path = out_file.name

    command = [
        codex_path,
        "exec",
        "--color",
        "never",
        "--skip-git-repo-check",
        "--output-last-message",
        output_path,
    ]
    if cwd:
        command.extend(["--cd", str(cwd)])
    model = clean_text(request.get("model") or "", 200)
    if model:
        command.extend(["--model", model])
    profile = clean_text(request.get("profile") or "", 200)
    if profile:
        command.extend(["--profile", profile])
    sandbox = request.get("sandbox") or "workspace-write"
    if sandbox in {"read-only", "workspace-write", "danger-full-access"}:
        command.extend(["--sandbox", sandbox])
    approval = request.get("approvalPolicy") or "never"
    if approval in {"never", "on-request", "untrusted"}:
        command.extend(["-c", f'approval_policy="{approval}"'])
    command.append("-")

    env = os.environ.copy()
    env["NO_COLOR"] = "1"
    try:
        result = subprocess.run(
            command,
            input=prompt,
            text=True,
            capture_output=True,
            cwd=str(cwd) if cwd else None,
            env=env,
            timeout=timeout,
            check=False,
        )
        text = read_file(output_path).strip() or extract_last_text(result.stdout).strip()
        if result.returncode != 0:
            raise RuntimeError(format_process_error(result, text))
        return {
            "ok": True,
            "mode": "exec",
            "text": limit_response(text),
            "stderr": tail(result.stderr),
            "stdout": tail(result.stdout),
        }
    finally:
        try:
            os.unlink(output_path)
        except OSError:
            pass


def run_acp(request, prompt):
    acp_command = clean_text(request.get("acpCommand") or "", 1000)
    if not acp_command:
        raise ValueError("ACP command is empty.")
    argv = shlex.split(acp_command)
    if not argv:
        raise ValueError("ACP command is empty.")
    cwd = normalize_cwd(request.get("cwd") or "")
    timeout = normalize_timeout(request.get("timeoutSeconds"), 900)

    process = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        cwd=str(cwd) if cwd else None,
    )
    client = AcpClient(process, timeout)
    try:
        initialize = client.request("initialize", {
            "protocolVersion": 1,
            "clientCapabilities": {},
        })
        session = client.request("session/new", {
            "cwd": str(cwd) if cwd else str(Path.home()),
        })
        session_id = session.get("sessionId") or session.get("id")
        params = {
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": prompt}],
        }
        result = client.request("session/prompt", params, collect_until_response=True)
        text = (client.output_text or result.get("text") or result.get("message") or "").strip()
        return {
            "ok": True,
            "mode": "acp",
            "text": limit_response(text),
            "initialize": initialize,
            "stderr": tail(client.stderr_text),
        }
    finally:
        terminate_process(process)


class AcpClient:
    def __init__(self, process, timeout):
        self.process = process
        self.timeout = timeout
        self.next_id = 1
        self.output_text = ""
        self.stderr_text = ""

    def request(self, method, params, collect_until_response=False):
        request_id = self.next_id
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        return self.read_until_response(request_id, collect_until_response)

    def send(self, message):
        if not self.process.stdin:
            raise RuntimeError("ACP process stdin is closed.")
        self.process.stdin.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
        self.process.stdin.flush()

    def read_until_response(self, request_id, collect_until_response=False):
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            self.read_stderr_nonblocking()
            line = self.readline_with_timeout(max(0.1, min(1, deadline - time.monotonic())))
            if line is None:
                continue
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "method" in message and "id" in message:
                self.handle_client_request(message)
                continue
            if "method" in message:
                self.handle_notification(message)
                continue
            if message.get("id") == request_id:
                if "error" in message:
                    error = message.get("error") or {}
                    raise RuntimeError(error.get("message") or str(error))
                return message.get("result") or {}
            if collect_until_response:
                self.handle_notification(message)
        raise TimeoutError("ACP request timed out.")

    def readline_with_timeout(self, timeout):
        if not self.process.stdout:
            return None
        readable, _, _ = select.select([self.process.stdout], [], [], timeout)
        if not readable:
            return None
        return self.process.stdout.readline()

    def read_stderr_nonblocking(self):
        if not self.process.stderr:
            return
        readable, _, _ = select.select([self.process.stderr], [], [], 0)
        if readable:
            chunk = self.process.stderr.read(4096)
            if chunk:
                self.stderr_text += chunk

    def handle_client_request(self, message):
        method = message.get("method")
        request_id = message.get("id")
        if method == "session/request_permission":
            self.send({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"outcome": {"outcome": "allow", "optionId": "allow_once"}},
            })
            return
        self.send({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": f"Unsupported ACP client method: {method}"},
        })

    def handle_notification(self, message):
        params = message.get("params") or message.get("result") or {}
        self.collect_text(params)

    def collect_text(self, value):
        if isinstance(value, str):
            self.output_text += value
            return
        if isinstance(value, list):
            for item in value:
                self.collect_text(item)
            return
        if not isinstance(value, dict):
            return
        for key in ("text", "delta", "content"):
            if isinstance(value.get(key), str):
                self.output_text += value[key]
        for key in ("message", "update", "content", "parts", "chunks"):
            if key in value and not isinstance(value.get(key), str):
                self.collect_text(value[key])


def normalize_cwd(value):
    value = clean_text(value or "", 1000)
    if not value:
        return None
    path = Path(value).expanduser()
    if not path.exists() or not path.is_dir():
        raise ValueError(f"Codex working directory does not exist: {path}")
    return path


def normalize_timeout(value, default):
    try:
        seconds = int(value or default)
    except (TypeError, ValueError):
        seconds = default
    return max(30, min(seconds, 3600))


def clean_text(value, max_length):
    text = str(value or "")
    if len(text) > max_length:
        raise ValueError("Input is too long.")
    return text


def read_file(path):
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError:
        return ""


def extract_last_text(stdout):
    lines = [line.strip() for line in (stdout or "").splitlines() if line.strip()]
    return lines[-1] if lines else ""


def format_process_error(result, text):
    details = tail(result.stderr or result.stdout)
    if text:
        details = f"{text}\n{details}".strip()
    return details or f"codex exec failed with exit code {result.returncode}"


def tail(text, limit=6000):
    text = str(text or "")
    return text[-limit:]


def limit_response(text):
    text = str(text or "")
    if len(text) <= MAX_RESPONSE_CHARS:
        return text
    return text[:MAX_RESPONSE_CHARS] + "\n\n[Ask GPT truncated the local Codex response.]"


def terminate_process(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()


if __name__ == "__main__":
    main()
