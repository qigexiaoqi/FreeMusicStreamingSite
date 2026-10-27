#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
免费音乐播放站 — 本地服务端 v2
------------------------------------------------------------------
职责
  1. 静态托管 public/（播放站 + 管理后台）
  2. 反代音乐接口   /api        https://music-api.gdstudio.xyz/api.php
  3. 音频流中转     /stream     支持 HTTP Range（可拖动进度）
  4. 下载中转       /dl         加 Content-Disposition，只落到访问终端
  5. 封面中转       /img
  6. 账号系统       /auth/*     注册 / 登录 / 登出 / 当前用户
  7. 云端同步       /sync       播放队列 / 最近播放 / 偏好设置
  8. 管理后台       /admin/api/* 用户管理 / 概览 / 审计日志

仅使用 Python 标准库，无需 pip install。
"""

import base64
import hashlib
import hmac
import http.cookies
import http.server
import json
import mimetypes
import os
import re
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

# ----------------------------------------------------------------------------
# 配置
# ----------------------------------------------------------------------------
API_BASE = "https://music-api.gdstudio.xyz/api.php"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_ROOT = os.path.join(BASE_DIR, "public")
DATA_DIR = os.path.join(BASE_DIR, "data")
USERS_FILE = os.path.join(DATA_DIR, "users.json")
SECRET_FILE = os.path.join(DATA_DIR, "secret.key")
AUDIT_FILE = os.path.join(DATA_DIR, "audit.log")
SITE_FILE = os.path.join(DATA_DIR, "site.json")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")

DEFAULT_PORT = 7788
APP_NAME = "免费音乐播放站"
TOKEN_MAX_AGE = 60 * 60 * 24 * 30      # 30 天
COOKIE_NAME = "xq_auth"
PBKDF2_ROUNDS = 120000

MAX_QUEUE = 200
MAX_RECENT = 100
MAX_BODY = 1 << 20                     # 1MB

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

TIMEOUT = 20
CACHE = {}
CACHE_LOCK = threading.Lock()
CACHE_MAX = 400

DB_LOCK = threading.RLock()
AUDIT_LOCK = threading.Lock()
AUDIT_MEM = []                         # 最近 500 条

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}

# 站点外观默认值（后台可改）
SITE_DEFAULTS = {
    "siteName": "免费音乐播放站",
    "brandEn": "FREE MUSIC STREAMING",
    "logo": {"mode": "text", "text": "柒", "url": ""},
    "entryKicker": "LOCAL MUSIC STATION",
    "entryTitle": "",
    "entrySub": "搜索 · 试听 · 歌词 · 本机下载",
    "entryBtn": "进入播放站",
    "entryTags": ["多音源", "双音质", "歌词", "账号同步"],
    "entryFoot": "免费音乐播放站 · 本地部署 v2.3 | 数据来自公开音乐接口",
}

SITE_TEXT_LIMITS = {
    "siteName": 24,
    "brandEn": 32,
    "entryKicker": 40,
    "entryTitle": 24,
    "entrySub": 80,
    "entryBtn": 16,
    "entryFoot": 120,
}

UPLOAD_MAX = 2 << 20          # 2MB
UPLOAD_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}

START_TS = time.time()
LOGIN_FAILS = {}                       # ip -> [ts, ...]


def log(msg):
    print("  " + msg, flush=True)


def now_ts():
    return int(time.time())


# ----------------------------------------------------------------------------
# 音乐接口缓存
# ----------------------------------------------------------------------------
def cache_get(key):
    with CACHE_LOCK:
        item = CACHE.get(key)
        if not item:
            return None
        exp, payload = item
        if exp < time.time():
            CACHE.pop(key, None)
            return None
        return payload


def cache_set(key, payload, ttl):
    with CACHE_LOCK:
        if len(CACHE) > CACHE_MAX:
            for k in list(CACHE.keys())[: CACHE_MAX // 3]:
                CACHE.pop(k, None)
        CACHE[key] = (time.time() + ttl, payload)


def http_open(url, extra_headers=None, method="GET"):
    headers = {
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, headers=headers, method=method)
    return urllib.request.urlopen(req, timeout=TIMEOUT)


def safe_filename(name, fallback="music"):
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", name or "").strip()
    name = name.strip(". ")
    return name[:110] or fallback


# ----------------------------------------------------------------------------
# 账号 / 数据存储
# ----------------------------------------------------------------------------
def ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(WEB_ROOT, exist_ok=True)
    os.makedirs(UPLOAD_DIR, exist_ok=True)


# ----------------------------------------------------------------------------
# 站点外观配置
# ----------------------------------------------------------------------------
def _merge_site(raw):
    cfg = {
        "siteName": SITE_DEFAULTS["siteName"],
        "brandEn": SITE_DEFAULTS["brandEn"],
        "logo": dict(SITE_DEFAULTS["logo"]),
        "entryKicker": SITE_DEFAULTS["entryKicker"],
        "entryTitle": SITE_DEFAULTS["entryTitle"],
        "entrySub": SITE_DEFAULTS["entrySub"],
        "entryBtn": SITE_DEFAULTS["entryBtn"],
        "entryTags": list(SITE_DEFAULTS["entryTags"]),
        "entryFoot": SITE_DEFAULTS["entryFoot"],
    }
    if not isinstance(raw, dict):
        return cfg
    for key in SITE_TEXT_LIMITS:
        val = raw.get(key)
        if isinstance(val, str):
            cfg[key] = val
    logo = raw.get("logo")
    if isinstance(logo, dict):
        if logo.get("mode") in ("text", "image"):
            cfg["logo"]["mode"] = logo["mode"]
        if isinstance(logo.get("text"), str):
            cfg["logo"]["text"] = logo["text"]
        if isinstance(logo.get("url"), str) and logo["url"].startswith("/uploads/"):
            cfg["logo"]["url"] = logo["url"]
    tags = raw.get("entryTags")
    if isinstance(tags, list):
        cfg["entryTags"] = [str(t) for t in tags][:8]
    return cfg


def clean_site(data):
    cfg = _merge_site(data)

    for key, limit in SITE_TEXT_LIMITS.items():
        val = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", cfg.get(key) or "").strip()
        if "\n" in val or "\r" in val:
            val = val.replace("\r", " ").replace("\n", " ")
        cfg[key] = val[:limit]

    if not cfg["siteName"]:
        cfg["siteName"] = SITE_DEFAULTS["siteName"]
    if not cfg["entryBtn"]:
        cfg["entryBtn"] = SITE_DEFAULTS["entryBtn"]

    logo = cfg["logo"]
    logo["text"] = (logo.get("text") or "").strip()[:4] or SITE_DEFAULTS["logo"]["text"]
    if logo.get("mode") == "image" and not logo.get("url"):
        logo["mode"] = "text"
    cfg["logo"] = logo

    tags = []
    for t in cfg.get("entryTags") or []:
        t = re.sub(r"\s+", " ", str(t)).strip()[:12]
        if t:
            tags.append(t)
        if len(tags) >= 6:
            break
    cfg["entryTags"] = tags
    return cfg


def load_site():
    if not os.path.exists(SITE_FILE):
        return _merge_site({})
    try:
        with open(SITE_FILE, "r", encoding="utf-8") as fh:
            return _merge_site(json.load(fh))
    except Exception:
        return _merge_site({})


def save_site(cfg):
    tmp = SITE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, SITE_FILE)


def load_secret():
    if os.path.exists(SECRET_FILE):
        with open(SECRET_FILE, "rb") as fh:
            data = fh.read().strip()
            if len(data) >= 32:
                return data
    secret = secrets.token_bytes(32)
    with open(SECRET_FILE, "wb") as fh:
        fh.write(secret)
    return secret


SECRET = b""


def empty_db():
    return {"users": [], "meta": {"created_at": now_ts(), "schema": 2}}


def load_db():
    with DB_LOCK:
        if not os.path.exists(USERS_FILE):
            db = empty_db()
            save_db(db)
            return db
        try:
            with open(USERS_FILE, "r", encoding="utf-8") as fh:
                db = json.load(fh)
        except Exception:
            backup = USERS_FILE + ".broken-%d" % now_ts()
            try:
                os.replace(USERS_FILE, backup)
            except Exception:
                pass
            db = empty_db()
            save_db(db)
            return db
        db.setdefault("users", [])
        db.setdefault("meta", {"created_at": now_ts(), "schema": 2})
        return db


def save_db(db):
    with DB_LOCK:
        tmp = USERS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(db, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, USERS_FILE)


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ROUNDS)
    return salt, digest.hex()


def verify_password(password, salt, expected):
    _, got = hash_password(password, salt)
    return hmac.compare_digest(got, expected)


def bootstrap_admin():
    db = load_db()
    has_admin = any(u.get("role") == "admin" for u in db["users"])
    if has_admin:
        return False
    salt, pwd = hash_password("admin")
    db["users"].append({
        "id": "u_" + secrets.token_hex(6),
        "username": "admin",
        "role": "admin",
        "salt": salt,
        "pwd": pwd,
        "created_at": now_ts(),
        "last_login": None,
        "banned": False,
        "state": {"queue": [], "recent": [], "settings": {}},
    })
    save_db(db)
    audit("system", "bootstrap_admin", "admin", "初始化管理员账号")
    return True


def audit(actor, action, target="", note=""):
    entry = {"ts": now_ts(), "actor": actor, "action": action, "target": target, "note": note}
    with AUDIT_LOCK:
        AUDIT_MEM.append(entry)
        if len(AUDIT_MEM) > 500:
            del AUDIT_MEM[: len(AUDIT_MEM) - 500]
        try:
            with open(AUDIT_FILE, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception:
            pass


def find_user(db, uid=None, username=None):
    for u in db["users"]:
        if uid and u.get("id") == uid:
            return u
        if username and u.get("username", "").lower() == username.lower():
            return u
    return None


def public_user(u):
    if not u:
        return None
    st = u.get("state") or {}
    return {
        "id": u.get("id"),
        "username": u.get("username"),
        "role": u.get("role", "user"),
        "created_at": u.get("created_at"),
        "last_login": u.get("last_login"),
        "queue_count": len(st.get("queue") or []),
        "recent_count": len(st.get("recent") or []),
    }


# ----------------------------------------------------------------------------
# 令牌（无状态签名 cookie）
# ----------------------------------------------------------------------------
def make_token(uid):
    exp = now_ts() + TOKEN_MAX_AGE
    raw = "%s:%d" % (uid, exp)
    sig = hmac.new(SECRET, raw.encode("utf-8"), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(("%s:%s" % (raw, sig)).encode("utf-8")).decode("ascii")


def parse_token(token):
    if not token:
        return None
    try:
        raw = base64.urlsafe_b64decode(token.encode("ascii")).decode("utf-8")
        uid, exp, sig = raw.rsplit(":", 2)
        expect = hmac.new(SECRET, ("%s:%s" % (uid, exp)).encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expect):
            return None
        if int(exp) < now_ts():
            return None
        return uid
    except Exception:
        return None


def validate_username(name):
    if not isinstance(name, str):
        return "用户名格式不正确"
    name = name.strip()
    if not re.fullmatch(r"[A-Za-z0-9_\u4e00-\u9fa5]{3,20}", name):
        return "用户名需 3-20 位，中文/字母/数字/下划线"
    return None


def validate_password(pwd):
    if not isinstance(pwd, str) or len(pwd) < 6 or len(pwd) > 64:
        return "密码长度需 6-64 位"
    return None


def clean_track(t):
    if not isinstance(t, dict):
        return None
    out = {}
    for k in ("id", "name", "artist", "album", "pic_id", "url_id", "lyric_id", "source"):
        v = t.get(k)
        if v is None:
            continue
        if not isinstance(v, (str, int, float)):
            return None
        out[k] = str(v)[:200]
    if not out.get("id"):
        return None
    if not out.get("name"):
        out["name"] = "未知曲目"
    if not out.get("artist"):
        out["artist"] = "未知歌手"
    return out


def clean_track_list(items, cap):
    result = []
    if not isinstance(items, list):
        return result
    seen = set()
    for it in items[: cap * 2]:
        t = clean_track(it)
        if not t:
            continue
        key = t.get("id") + "|" + (t.get("album") or "")
        if key in seen:
            continue
        seen.add(key)
        result.append(t)
        if len(result) >= cap:
            break
    return result


def clean_settings(s):
    if not isinstance(s, dict):
        return {}
    out = {}
    if s.get("source"):
        out["source"] = str(s["source"])[:20]
    for k in ("brPlay", "brDownload"):
        try:
            v = int(s.get(k))
            if v in (128, 192, 320, 740, 999):
                out[k] = v
        except Exception:
            pass
    return out


# ----------------------------------------------------------------------------
# HTTP 处理
# ----------------------------------------------------------------------------
class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "FreeMusicStreamingSite/2.3"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------------ 工具
    def log_message(self, fmt, *args):
        path = self.path.split("?")[0]
        if path.startswith(("/api", "/stream", "/dl", "/img", "/auth", "/sync", "/admin/api")):
            sys.stdout.write("\r  · %s %s\n" % (self.command, path[:70]))
        else:
            sys.stdout.write("\r  · %s %s\n" % (self.command, self.path[:80]))

    def send_payload(self, code, body, ctype, extra=None, cache_seconds=0):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if cache_seconds:
            self.send_header("Cache-Control", "public, max-age=%d" % cache_seconds)
        else:
            self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_json(self, code, obj, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_payload(code, body, "application/json; charset=utf-8", extra)

    def read_body(self, limit=None):
        cap = limit or MAX_BODY
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        if length > cap:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            raise ValueError("请求体不是合法 JSON")
        if not isinstance(data, dict):
            raise ValueError("请求体必须是对象")
        return data

    def client_ip(self):
        return self.client_address[0] if self.client_address else "-"

    def cookie_token(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = http.cookies.SimpleCookie()
        try:
            jar.load(raw)
        except Exception:
            return None
        morsel = jar.get(COOKIE_NAME)
        return morsel.value if morsel else None

    def current_user(self, db=None):
        uid = parse_token(self.cookie_token())
        if not uid:
            return None
        db = db or load_db()
        u = find_user(db, uid=uid)
        if not u or u.get("banned"):
            return None
        return u

    def auth_cookie_header(self, uid):
        token = make_token(uid)
        return {
            "Set-Cookie": "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d"
            % (COOKIE_NAME, token, TOKEN_MAX_AGE)
        }

    def logout_cookie_header(self):
        return {"Set-Cookie": "%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" % COOKIE_NAME}

    # ------------------------------------------------------------------ 路由
    def do_GET(self):
        try:
            parsed = urllib.parse.urlsplit(self.path)
            route = parsed.path
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)

            if route == "/api":
                return self.handle_music_api(parsed.query)
            if route == "/stream":
                return self.handle_stream(query, download=False)
            if route == "/dl":
                return self.handle_stream(query, download=True)
            if route == "/img":
                return self.handle_img(query)
            if route == "/health":
                return self.send_json(200, {"ok": True, "app": APP_NAME, "time": time.time()})

            # ---- 站点外观（公开）----
            if route == "/site":
                return self.send_json(200, {"site": load_site()})
            if route.startswith("/uploads/"):
                return self.handle_upload(route)

            # ---- 账号 ----
            if route == "/auth/me":
                u = self.current_user()
                if u:
                    db = load_db()
                    fresh = find_user(db, uid=u["id"])
                    return self.send_json(200, {"user": public_user(fresh)})
                return self.send_json(200, {"user": None})

            if route == "/sync":
                return self.handle_sync_get()

            # ---- 后台 ----
            if route == "/admin/api/stats":
                return self.handle_admin_stats()
            if route == "/admin/api/users":
                return self.handle_admin_users(query)
            if route == "/admin/api/audit":
                return self.handle_admin_audit(query)
            if route == "/admin/api/site":
                return self.handle_admin_site_get()

            if route in ("/admin", "/admin/"):
                return self.handle_static("/admin.html")

            return self.handle_static(route)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            try:
                self.send_json(500, {"error": str(exc)})
            except Exception:
                pass

    def do_POST(self):
        try:
            parsed = urllib.parse.urlsplit(self.path)
            route = parsed.path
            if route == "/auth/register":
                return self.handle_register()
            if route == "/auth/login":
                return self.handle_login()
            if route == "/auth/logout":
                return self.send_json(200, {"ok": True}, self.logout_cookie_header())
            if route == "/sync":
                return self.handle_sync_put()
            if route == "/admin/api/users":
                return self.handle_admin_user_create()
            if route == "/admin/api/users/update":
                return self.handle_admin_user_update()
            if route == "/admin/api/users/delete":
                return self.handle_admin_user_delete()
            if route == "/admin/api/site":
                return self.handle_admin_site_save()
            if route == "/admin/api/site/logo":
                return self.handle_admin_site_logo()
            if route == "/admin/api/site/reset":
                return self.handle_admin_site_reset()
            return self.send_json(404, {"error": "接口不存在"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            try:
                self.send_json(500, {"error": str(exc)})
            except Exception:
                pass

    def do_PUT(self):
        if urllib.parse.urlsplit(self.path).path == "/sync":
            try:
                return self.handle_sync_put()
            except Exception as exc:  # noqa: BLE001
                return self.send_json(500, {"error": str(exc)})
        self.send_json(404, {"error": "接口不存在"})

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -------------------------------------------------------------- 音乐接口
    def handle_music_api(self, raw_query):
        qs = urllib.parse.parse_qs(raw_query, keep_blank_values=True)
        types = (qs.get("types") or ["search"])[0]
        source = (qs.get("source") or ["netease"])[0]

        ttl = {"url": 240, "search": 300, "lyric": 86400, "pic": 86400}.get(types, 60)
        key = "api:" + raw_query
        if types != "url":
            hit = cache_get(key)
            if hit is not None:
                return self.send_payload(200, hit, "application/json; charset=utf-8", cache_seconds=120)

        upstream = API_BASE + ("?" + raw_query if raw_query else "")
        try:
            with http_open(upstream, {"Accept": "application/json"}) as resp:
                body = resp.read()
        except urllib.error.HTTPError as exc:
            body = exc.read() or b"{}"
            if exc.code != 200:
                return self.send_json(200, {"_error": "上游返回 %s" % exc.code, "source": source})
        except Exception as exc:  # noqa: BLE001
            return self.send_json(200, {"_error": "上游请求失败: %s" % exc, "source": source})

        try:
            json.loads(body.decode("utf-8"))
        except Exception:
            return self.send_json(200, {"_error": "上游返回内容异常", "source": source})

        cache_set(key, body, ttl)
        self.send_payload(200, body, "application/json; charset=utf-8", cache_seconds=60)

    # ------------------------------------------------- 音频流 / 终端下载 / 封面
    def handle_stream(self, query, download=False):
        raw_url = (query.get("url") or [""])[0]
        if not raw_url:
            return self.send_json(400, {"error": "missing url"})
        if not raw_url.startswith(("http://", "https://")):
            return self.send_json(400, {"error": "bad url"})

        want_name = (query.get("name") or ["music"])[0]
        m = re.search(r"\.(mp3|m4a|flac|wav|ogg|aac|ape)(?:$|\?)", raw_url, re.I)
        ext = ("." + m.group(1).lower()) if m else ".mp3"

        headers = {"Accept": "*/*", "Referer": "https://music.163.com/"}
        rng = self.headers.get("Range")
        if rng and not download:
            headers["Range"] = rng

        try:
            resp = http_open(raw_url, headers)
        except Exception as exc:  # noqa: BLE001
            return self.send_json(502, {"error": "音频源不可达: %s" % exc})

        try:
            status = resp.getcode() or 200
            self.send_response(status if status in (200, 206) else 200)
            ctype = resp.headers.get("Content-Type") or "audio/mpeg"
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            length = resp.headers.get("Content-Length")
            if length:
                self.send_header("Content-Length", length)
            crange = resp.headers.get("Content-Range")
            if crange:
                self.send_header("Content-Range", crange)

            if download:
                fname = safe_filename(want_name) + ext
                ascii_name = fname.encode("ascii", "ignore").decode().strip(" -_.")
                if not ascii_name or ascii_name.lower() == ext.strip("."):
                    ascii_name = "FreeMusicStreamingSite" + ext
                quoted = urllib.parse.quote(fname)
                self.send_header(
                    "Content-Disposition",
                    "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (ascii_name, quoted),
                )

            self.send_header("Cache-Control", "no-store")
            if not length:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()

            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                resp.close()
            except Exception:
                pass

    def handle_img(self, query):
        raw_url = (query.get("url") or [""])[0]
        if not raw_url.startswith(("http://", "https://")):
            return self.send_json(400, {"error": "bad url"})

        key = "img:" + raw_url
        hit = cache_get(key)
        if hit is not None:
            body, ctype = hit
            return self.send_payload(200, body, ctype, cache_seconds=86400)

        try:
            with http_open(raw_url, {"Referer": "https://music.163.com/", "Accept": "image/*"}) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type") or "image/jpeg"
            if not ctype.startswith("image/"):
                ctype = "image/jpeg"
            cache_set(key, (body, ctype), 86400 * 3)
            self.send_payload(200, body, ctype, cache_seconds=86400)
        except Exception:
            self.send_payload(404, b"", "image/png")

    # ------------------------------------------------------------------ 静态
    def handle_static(self, route):
        if route in ("/", ""):
            route = "/index.html"
        rel = urllib.parse.unquote(route.lstrip("/"))
        target = os.path.normpath(os.path.join(WEB_ROOT, rel))

        if not target.startswith(WEB_ROOT):
            return self.send_payload(403, b"forbidden", "text/plain; charset=utf-8")
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            target = os.path.join(WEB_ROOT, "index.html")
            if not os.path.isfile(target):
                return self.send_payload(404, b"404 not found", "text/plain; charset=utf-8")

        ext = os.path.splitext(target)[1].lower()
        ctype = MIME.get(ext) or mimetypes.guess_type(target)[0] or "application/octet-stream"
        with open(target, "rb") as fh:
            body = fh.read()
        self.send_payload(200, body, ctype, cache_seconds=0)

    # ------------------------------------------------------------------ 注册登录
    def handle_register(self):
        try:
            data = self.read_body()
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})

        username = (data.get("username") or "").strip()
        password = data.get("password") or ""

        err = validate_username(username) or validate_password(password)
        if err:
            return self.send_json(400, {"error": err})

        db = load_db()
        if find_user(db, username=username):
            return self.send_json(409, {"error": "该用户名已被注册"})
        if len(db["users"]) >= 500:
            return self.send_json(400, {"error": "用户数量已达上限"})

        salt, pwd = hash_password(password)
        user = {
            "id": "u_" + secrets.token_hex(6),
            "username": username,
            "role": "user",
            "salt": salt,
            "pwd": pwd,
            "created_at": now_ts(),
            "last_login": now_ts(),
            "banned": False,
            "state": {"queue": [], "recent": [], "settings": {}},
        }
        db["users"].append(user)
        save_db(db)
        audit(username, "register", username, "注册账号")

        self.send_json(200, {"user": public_user(user)}, self.auth_cookie_header(user["id"]))

    def handle_login(self):
        ip = self.client_ip()
        now = time.time()
        hits = [t for t in LOGIN_FAILS.get(ip, []) if now - t < 300]
        LOGIN_FAILS[ip] = hits
        if len(hits) >= 10:
            return self.send_json(429, {"error": "尝试过于频繁，请 5 分钟后再试"})

        try:
            data = self.read_body()
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})

        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        if not username or not password:
            return self.send_json(400, {"error": "请输入用户名和密码"})

        db = load_db()
        user = find_user(db, username=username)
        if not user or not verify_password(password, user.get("salt", ""), user.get("pwd", "")):
            hits.append(now)
            LOGIN_FAILS[ip] = hits
            return self.send_json(401, {"error": "用户名或密码错误"})
        if user.get("banned"):
            return self.send_json(403, {"error": "该账号已被禁用"})

        user["last_login"] = now_ts()
        save_db(db)
        audit(username, "login", username, "登录成功")
        self.send_json(200, {"user": public_user(user)}, self.auth_cookie_header(user["id"]))

    # ------------------------------------------------------------------ 同步
    def handle_sync_get(self):
        u = self.current_user()
        if not u:
            return self.send_json(401, {"error": "未登录"})
        st = u.get("state") or {}
        self.send_json(200, {
            "queue": st.get("queue") or [],
            "recent": st.get("recent") or [],
            "settings": st.get("settings") or {},
            "saved_at": st.get("saved_at"),
        })

    def handle_sync_put(self):
        u = self.current_user()
        if not u:
            return self.send_json(401, {"error": "未登录"})
        try:
            data = self.read_body()
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})

        db = load_db()
        target = find_user(db, uid=u["id"])
        if not target:
            return self.send_json(401, {"error": "未登录"})

        st = target.get("state") or {}
        if "queue" in data:
            st["queue"] = clean_track_list(data.get("queue"), MAX_QUEUE)
        if "recent" in data:
            st["recent"] = clean_track_list(data.get("recent"), MAX_RECENT)
        if "settings" in data:
            merged = st.get("settings") or {}
            merged.update(clean_settings(data.get("settings")))
            st["settings"] = merged
        st["saved_at"] = now_ts()
        target["state"] = st
        save_db(db)
        self.send_json(200, {"ok": True, "saved_at": st["saved_at"], "queue": len(st.get("queue") or []),
                             "recent": len(st.get("recent") or [])})

    # ------------------------------------------------------------------ 管理后台
    def require_admin(self):
        u = self.current_user()
        if not u:
            self.send_json(401, {"error": "未登录"})
            return None
        if u.get("role") != "admin":
            self.send_json(403, {"error": "需要管理员权限"})
            return None
        return u

    def handle_admin_stats(self):
        if not self.require_admin():
            return
        db = load_db()
        users = db["users"]
        week_ago = now_ts() - 7 * 86400
        queue_total = sum(len((u.get("state") or {}).get("queue") or []) for u in users)
        recent_total = sum(len((u.get("state") or {}).get("recent") or []) for u in users)
        self.send_json(200, {
            "users": len(users),
            "admins": sum(1 for u in users if u.get("role") == "admin"),
            "banned": sum(1 for u in users if u.get("banned")),
            "active_7d": sum(1 for u in users if (u.get("last_login") or 0) >= week_ago),
            "queue_total": queue_total,
            "recent_total": recent_total,
            "uptime": int(time.time() - START_TS),
            "started_at": int(START_TS),
        })

    def handle_admin_users(self, query):
        if not self.require_admin():
            return
        q = (query.get("q") or [""])[0].strip().lower()
        try:
            page = max(1, int((query.get("page") or ["1"])[0]))
        except ValueError:
            page = 1
        try:
            size = min(50, max(5, int((query.get("size") or ["10"])[0])))
        except ValueError:
            size = 10

        db = load_db()
        items = db["users"]
        if q:
            items = [u for u in items if q in u.get("username", "").lower()]
        items = sorted(items, key=lambda u: u.get("created_at") or 0, reverse=True)
        total = len(items)
        start = (page - 1) * size
        page_items = [public_user(u) for u in items[start: start + size]]
        self.send_json(200, {"total": total, "page": page, "size": size, "items": page_items})

    def handle_admin_audit(self, query):
        if not self.require_admin():
            return
        try:
            limit = min(200, max(1, int((query.get("limit") or ["50"])[0])))
        except ValueError:
            limit = 50
        with AUDIT_LOCK:
            items = list(AUDIT_MEM)[-limit:][::-1]
        self.send_json(200, {"items": items})

    # ---------------------------------------------------------- 站点外观设置
    def handle_admin_site_get(self):
        if not self.require_admin():
            return
        self.send_json(200, {"site": load_site(), "defaults": SITE_DEFAULTS})

    def handle_admin_site_save(self):
        admin = self.require_admin()
        if not admin:
            return
        try:
            data = self.read_body()
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})

        payload = data.get("site") if isinstance(data.get("site"), dict) else data
        current = load_site()
        merged = dict(current)
        for key in list(SITE_TEXT_LIMITS) + ["entryTags", "logo"]:
            if key in payload:
                merged[key] = payload[key]

        cfg = clean_site(merged)
        save_site(cfg)
        audit(admin["username"], "site_update", cfg["siteName"], "更新站点外观")
        self.send_json(200, {"site": cfg})

    def handle_admin_site_logo(self):
        admin = self.require_admin()
        if not admin:
            return
        try:
            data = self.read_body(limit=6 << 20)      # 图片 base64 会膨胀，单独放宽
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})

        data_url = data.get("dataUrl") or ""
        m = re.match(r"^data:([\w/+.-]+);base64,(.+)$", data_url, re.S)
        if not m:
            return self.send_json(400, {"error": "图片格式不正确"})

        mime = m.group(1).lower()
        ext = UPLOAD_TYPES.get(mime)
        if not ext:
            return self.send_json(400, {"error": "只支持 PNG / JPG / WEBP / GIF"})

        try:
            raw = base64.b64decode(m.group(2), validate=True)
        except Exception:
            return self.send_json(400, {"error": "图片数据损坏"})
        if len(raw) > UPLOAD_MAX:
            return self.send_json(400, {"error": "图片不能超过 2MB"})

        os.makedirs(UPLOAD_DIR, exist_ok=True)
        name = "logo_%d.%s" % (int(time.time() * 1000), ext)
        with open(os.path.join(UPLOAD_DIR, name), "wb") as fh:
            fh.write(raw)

        # 清理旧 logo（保留最新一张）
        for old in os.listdir(UPLOAD_DIR):
            if old.startswith("logo_") and old != name:
                try:
                    os.remove(os.path.join(UPLOAD_DIR, old))
                except Exception:
                    pass

        cfg = load_site()
        cfg["logo"] = {"mode": "image", "text": cfg["logo"].get("text") or "柒",
                       "url": "/uploads/" + name}
        save_site(cfg)
        audit(admin["username"], "site_logo", cfg["siteName"], "上传站点 Logo")
        self.send_json(200, {"url": cfg["logo"]["url"], "site": cfg})

    def handle_admin_site_reset(self):
        admin = self.require_admin()
        if not admin:
            return
        cfg = clean_site(dict(SITE_DEFAULTS))
        save_site(cfg)
        audit(admin["username"], "site_reset", cfg["siteName"], "恢复默认外观")
        self.send_json(200, {"site": cfg})

    def handle_upload(self, route):
        name = os.path.basename(urllib.parse.unquote(route))
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", name or ""):
            return self.send_payload(404, b"", "text/plain")
        target = os.path.join(UPLOAD_DIR, name)
        if not os.path.isfile(target):
            return self.send_payload(404, b"", "text/plain")
        ext = os.path.splitext(target)[1].lower()
        ctype = MIME.get(ext) or "application/octet-stream"
        with open(target, "rb") as fh:
            body = fh.read()
        self.send_payload(200, body, ctype, cache_seconds=3600)

    def handle_admin_user_create(self):
        admin = self.require_admin()
        if not admin:
            return
        try:
            data = self.read_body()
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})

        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        role = data.get("role") if data.get("role") in ("user", "admin") else "user"

        err = validate_username(username) or validate_password(password)
        if err:
            return self.send_json(400, {"error": err})

        db = load_db()
        if find_user(db, username=username):
            return self.send_json(409, {"error": "该用户名已存在"})

        salt, pwd = hash_password(password)
        user = {
            "id": "u_" + secrets.token_hex(6),
            "username": username,
            "role": role,
            "salt": salt,
            "pwd": pwd,
            "created_at": now_ts(),
            "last_login": None,
            "banned": False,
            "state": {"queue": [], "recent": [], "settings": {}},
        }
        db["users"].append(user)
        save_db(db)
        audit(admin["username"], "admin_create_user", username, "创建用户 role=%s" % role)
        self.send_json(200, {"user": public_user(user)})

    def handle_admin_user_update(self):
        admin = self.require_admin()
        if not admin:
            return
        try:
            data = self.read_body()
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})

        uid = data.get("id")
        db = load_db()
        target = find_user(db, uid=uid)
        if not target:
            return self.send_json(404, {"error": "用户不存在"})

        changes = []
        if "role" in data:
            role = data.get("role")
            if role not in ("user", "admin"):
                return self.send_json(400, {"error": "角色不合法"})
            if target["id"] == admin["id"] and role != "admin":
                return self.send_json(400, {"error": "不能取消自己的管理员权限"})
            if target.get("role") != role:
                target["role"] = role
                changes.append("role=" + role)

        if "banned" in data:
            banned = bool(data.get("banned"))
            if target["id"] == admin["id"] and banned:
                return self.send_json(400, {"error": "不能禁用自己"})
            if target.get("banned") != banned:
                target["banned"] = banned
                changes.append("banned=%s" % banned)

        if data.get("password"):
            err = validate_password(data["password"])
            if err:
                return self.send_json(400, {"error": err})
            salt, pwd = hash_password(data["password"])
            target["salt"] = salt
            target["pwd"] = pwd
            changes.append("password")

        for key in ("queue", "recent"):
            if key in data:
                cap = MAX_QUEUE if key == "queue" else MAX_RECENT
                st = target.get("state") or {}
                st[key] = clean_track_list(data.get(key), cap)
                target["state"] = st
                changes.append(key + "=clear")

        save_db(db)
        audit(admin["username"], "admin_update_user", target["username"], ",".join(changes) or "无变化")
        self.send_json(200, {"user": public_user(target)})

    def handle_admin_user_delete(self):
        admin = self.require_admin()
        if not admin:
            return
        try:
            data = self.read_body()
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})

        uid = data.get("id")
        db = load_db()
        target = find_user(db, uid=uid)
        if not target:
            return self.send_json(404, {"error": "用户不存在"})
        if target["id"] == admin["id"]:
            return self.send_json(400, {"error": "不能删除自己"})
        if target.get("role") == "admin":
            admins = [u for u in db["users"] if u.get("role") == "admin"]
            if len(admins) <= 1:
                return self.send_json(400, {"error": "至少保留一个管理员"})

        db["users"] = [u for u in db["users"] if u.get("id") != uid]
        save_db(db)
        audit(admin["username"], "admin_delete_user", target["username"], "删除用户")
        self.send_json(200, {"ok": True})


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def pick_port(start, host="127.0.0.1"):
    for port in range(start, start + 30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    return start


def main():
    global SECRET
    ensure_dirs()
    SECRET = load_secret()
    created = bootstrap_admin()

    # 监听地址：默认只给本机；容器里用 XQ_HOST=0.0.0.0
    host = (os.environ.get("XQ_HOST") or "127.0.0.1").strip() or "127.0.0.1"

    port = DEFAULT_PORT
    try:
        port = int(os.environ.get("XQ_PORT") or DEFAULT_PORT)
    except ValueError:
        port = DEFAULT_PORT
    for arg in sys.argv[1:]:
        if arg.isdigit():
            port = int(arg)
    port = pick_port(port, host)

    shown_host = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host
    url = "http://%s:%d" % (shown_host, port)

    banner = r"""
  ==================================================================
     FreeMusicStreamingSite  ·  免费音乐播放站
     本地音乐播放站 · 搜索 / 试听 / 歌词 / 下载 / 账号同步
  ==================================================================
"""
    print(banner)
    print("  " + "=" * 60)
    print("   监听地址 : %s:%d" % (host, port))
    print("   访问地址 : " + url)
    print("   管理后台 : " + url + "/admin")
    print("   数据目录 : " + DATA_DIR)
    if created:
        print("   已初始化管理员账号 : admin / admin   (请尽快修改密码)")
    else:
        print("   管理员账号 : admin")
    print("   关闭窗口即可停止服务")
    print("  " + "=" * 60 + "\n")

    no_browser = ("--no-browser" in sys.argv) or \
        (os.environ.get("XQ_NO_BROWSER", "").strip().lower() in ("1", "true", "yes", "on"))
    if not no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    httpd = Server((host, port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
