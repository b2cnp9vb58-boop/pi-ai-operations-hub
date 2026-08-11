#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""微信在线守护：定期检查 weixin-control 状态，掉线/恢复时发 Telegram 通知。
状态变化才告警（去重），不会每次重复打扰。
"""
import json
import os
import subprocess
import sys
import time

STATE_FILE = "/var/lib/pi-control/shared/weixin-guard.json"
CHAT_ID = "6267411779"


def read_env(key):
    """从 /etc/pi-control/telegram.env 读变量值。"""
    path = "/etc/pi-control/telegram.env"
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        return None
    return None


def service_active():
    r = subprocess.run(["systemctl", "is-active", "weixin-control"],
                       capture_output=True, text=True)
    return r.stdout.strip() == "active"


def recently_expired():
    """检查最近日志是否有 session expired / not authenticated。"""
    r = subprocess.run(["journalctl", "-u", "weixin-control", "-n", "30", "--no-pager"],
                       capture_output=True, text=True)
    text = r.stdout
    return ("session expired" in text) or ("not authenticated" in text)


def send_telegram(text):
    token = read_env("TELEGRAM_BOT_TOKEN")
    if not token:
        return False
    import urllib.request
    url = "https://api.telegram.org/bot%s/sendMessage" % token
    data = "chat_id=%s&text=%s" % (CHAT_ID, urllib.parse.quote(text, safe=""))
    # Telegram 需要走代理
    proxy = os.environ.get("HTTPS_PROXY") or "http://127.0.0.1:7897"
    import urllib.request
    handler = urllib.request.ProxyHandler({"https": proxy, "http": proxy})
    opener = urllib.request.build_opener(handler)
    req = urllib.request.Request(url, data=data.encode("utf-8"),
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        resp = opener.open(req, timeout=20)
        body = resp.read().decode("utf-8", "replace")
        return '"ok":true' in body or '"ok": true' in body
    except Exception:
        return False


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(state):
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
    except OSError:
        pass


def main():
    import urllib.parse  # noqa

    active = service_active()
    # 服务没起，或起了但一直 session expired -> 视为掉线
    online = active and not recently_expired()

    state = load_state()
    prev_online = state.get("online")

    changed = prev_online is None or prev_online != online

    if changed:
        if online:
            msg = "✅ 微信已恢复在线（守护已接管）。"
        else:
            detail = "服务未运行" if not active else "会话已过期"
            msg = ("⚠️ 微信掉线了（%s）。\n"
                   "恢复方法：回复「微信重登」，我会发登录链接给你，点开即可。"
                   % detail)
        ok = send_telegram(msg)
        state["online"] = online
        state["last_changed"] = int(time.time())
        state["notified"] = ok
        save_state(state)
        print("状态变化: %s -> %s, 通知%s" %
              ("在线" if prev_online else "掉线", "在线" if online else "掉线",
               "已发送" if ok else "发送失败"))
        return 0

    print("状态未变化: %s（不打扰）" % ("在线" if online else "掉线"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
