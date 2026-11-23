# -*- coding: utf-8 -*-
"""YOLO 智能检测平台 · Flask 后端主应用（通用目标检测可视化服务）。"""
import os
import json
import time
import uuid
import functools
import shutil
import threading
import queue
import socket
import subprocess
import pymysql
from datetime import timedelta as _timedelta
import base64
import io
import random
import string
from PIL import Image, ImageDraw, ImageFont, ImageFilter

from flask import (Flask, request, jsonify, send_from_directory, session, Response,
                   stream_with_context, send_file)
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename

import db
import config
from config import (
    SECRET_KEY, HOST, PORT, MODELS_DIR,
    UPLOAD_DIR, UPLOAD_IMAGES, UPLOAD_BOXES, UPLOAD_VIDEOS, UPLOAD_TMP,
    ALLOWED_IMAGE_EXT, ALLOWED_VIDEO_EXT, DEFAULT_CONF, PROJECT_DIR,
    MAX_UPLOAD_MB, MAX_IMAGE_MB, MAX_VIDEO_FRAMES, MAX_VIDEO_SECONDS, MIN_FREE_DISK_MB,
    MAX_CONCURRENT_STREAMS, STREAM_REAP_SILENT_SEC,
    MIN_FREE_VRAM_MB, META_REFRESH_STRICT, INFER_ACTIVE_WINDOW_SEC,
)
from detector import detector

# ==================== 日志系统 ====================
import logging
from logging.handlers import TimedRotatingFileHandler
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
os.makedirs(LOG_DIR, exist_ok=True)
_log_fmt = logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
_file_handler = TimedRotatingFileHandler(
    os.path.join(LOG_DIR, "app.log"), when="midnight", interval=1,
    backupCount=30, encoding="utf-8"
)
_file_handler.setFormatter(_log_fmt)
_file_handler.suffix = "%Y-%m-%d"
_console_handler = logging.StreamHandler()
_console_handler.setFormatter(_log_fmt)
logging.basicConfig(level=logging.INFO, handlers=[_file_handler, _console_handler])
logger = logging.getLogger("helmet")
logging.getLogger("werkzeug").setLevel(logging.INFO)
# 捕获未处理异常
import sys, traceback as _tb
def _excepthook(exc_type, exc_value, exc_tb):
    logger.error("未捕获异常: %s\n%s", exc_value, "".join(_tb.format_exception(exc_type, exc_value, exc_tb)))
sys.excepthook = _excepthook
logger.info("===== 后端启动 =====")

# 本服务所有网络请求都面向本机/局域网（MySQL、串口、YOLO、摄像头与网络流），
# 永远不应走系统代理：代理对局域网地址常直接拒绝（403/502），且 ffmpeg 会读
# http_proxy 环境变量把流请求也交给代理。启动即清掉，杜绝"开着代理软件流就挂"。
for _k in ("http_proxy", "https_proxy", "all_proxy",
           "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
    os.environ.pop(_k, None)

app = Flask(__name__, static_folder=None)
app.secret_key = SECRET_KEY
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
# 登录态 cookie 的存活上限：与后端 SESSION_MAX_SECONDS（30 天绝对上限）对齐。
# cookie 本身每次响应都会滚动续期；真正的"闲置失效 / 30 天强制重登"由后端双闸门判定，
# 这里的值只保证 cookie 不会先于后端判定把会话悄悄掐掉（避免无提示的裸 401）。
app.config["PERMANENT_SESSION_LIFETIME"] = _timedelta(days=30)


# 413：请求体超过 MAX_CONTENT_LENGTH（全局单个请求体上限，主要服务于视频）。
# 默认 Flask 会返回 HTML，这里改为明确 JSON，让前端能解析并给出友好提示。
@app.errorhandler(413)
def _too_large(e):
    gb = MAX_UPLOAD_MB // 1024
    hint = f"{MAX_UPLOAD_MB} MB（{gb} GB）" if gb >= 1 else f"{MAX_UPLOAD_MB} MB"
    return jsonify({
        "ok": False,
        "msg": f"文件过大，单个文件不能超过 {hint}",
    }), 413

# 全局 JSON 序列化：datetime 统一为 "YYYY-MM-DD HH:MM:SS" 中文格式
from flask.json.provider import DefaultJSONProvider
class CNJSONProvider(DefaultJSONProvider):
    def default(self, o):
        import datetime
        if isinstance(o, (datetime.datetime, datetime.date)):
            return o.strftime("%Y-%m-%d %H:%M:%S")
        return super().default(o)
app.json = CNJSONProvider(app)

# 静态目录：uploads/images 原图、uploads/videos 原视频、uploads/boxes 框数据、uploads/feedback 反馈图
# （旧的 uploads/results/{images,videos} 已合并为 uploads/boxes —— 磁盘上不再保存任何带框文件）
# 下载临时目录（不提供静态访问，只给 send_file 用）
os.makedirs(UPLOAD_TMP, exist_ok=True)
for sub, url, d in [("images", "/uploads/images", UPLOAD_IMAGES),
                    ("videos", "/uploads/videos", UPLOAD_VIDEOS),
                    ("boxes", "/uploads/boxes", UPLOAD_BOXES),
                    ("feedback", "/uploads/feedback", os.path.join(UPLOAD_DIR, "feedback"))]:
    os.makedirs(d, exist_ok=True)
    app.add_url_rule(
        f"{url}/<path:filename>",
        endpoint=f"static_{sub}",
        view_func=lambda filename, _dir=d: send_from_directory(_dir, filename),
    )

def _serve_frontend(filename, subdir):
    """提供前端静态文件，强制 no-cache —— 否则浏览器会缓存 app.js/css 长达 12 小时，
    导致改了前端用户却一直跑旧版本（历史踩坑：下载看门狗上线后用户仍卡旧前端）。"""
    base = os.path.join(PROJECT_DIR, subdir) if subdir else PROJECT_DIR
    resp = send_from_directory(base, filename)
    resp.headers["Cache-Control"] = "no-cache"
    return resp

# 服务前端文件（index.html / css / js / assets）
@app.get("/")
def index_page():
    return _serve_frontend("index.html", "")

for sub in ["css", "js", "assets"]:
    app.add_url_rule(
        f"/{sub}/<path:filename>",
        endpoint=f"frontend_{sub}",
        view_func=lambda filename, _sub=sub: _serve_frontend(filename, _sub),
    )


# 前端版本自检：app.js 内置 APP_VERSION，加载时与这里比对，不一致就自动硬刷新，
# 彻底杜绝“浏览器一直跑旧 JS、下载逻辑永远不更新”这类玄学报错。
APP_VERSION = "20261029a1"


@app.get("/api/version")
def api_version():
    # 前端每 5 秒探活一次；页面开着即视为用户在线，顺延会话的闲置计时。
    _renew_session_soft()
    resp = jsonify({"version": APP_VERSION})
    # 汇报 PPT（file:// 协议，origin 为 null）要用这个接口探测后端是否在线。
    # no-cors 探测分不清"连上了"和"连不上"，所以这里显式放开 CORS，
    # 让 PPT 能拿到真实响应、从而准确判断在线状态。
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Cache-Control"] = "no-store"
    return resp

# ---------- 工具 ----------
# 登录有效期 = 「滑动续期 + 绝对上限」双闸门：
#   · 闲置窗口 SESSION_IDLE_SECONDS：连续这么久没有任何认证请求即失效。
#     每次通过认证校验的请求都会把 session.last_active 顺延到当前时间（滑动续期），
#     所以天天在用的用户不会被踢下线；完全不用系统超过 3 天才会失效（保持原有安全姿态）。
#   · 绝对上限 SESSION_MAX_SECONDS：单次登录最长存活 30 天，到期强制重新登录一次。
#     login_ts 记录的就是首次登录时刻，全程不改动，不受续期影响。
SESSION_IDLE_SECONDS = 3 * 24 * 3600    # 闲置 3 天未操作 → 登录失效
SESSION_MAX_SECONDS = 30 * 24 * 3600    # 单次登录最长 30 天 → 强制重新登录


# 全局在线状态（内存，不写 DB）：{user_id: last_active_ts}
ONLINE_MAP = {}  # {user_id: {"ts": float, "device": str}}


def _parse_device():
    """从 User-Agent 解析设备名，如 'iPhone 15 Pro'、'Windows Chrome'。"""
    try:
        ua = request.headers.get("User-Agent", "") or ""
    except Exception:
        return "未知设备"
    s = ua
    if "iPhone" in s:
        # 尝试取具体型号，如 iPhone16,2
        import re as _re
        m = _re.search(r"iPhone(\d+),(\d+)", s)
        base = "iPhone"
        if m:
            base = "iPhone " + m.group(1)
        # 浏览器
        br = "Safari"
        if "CriOS" in s:
            br = "Chrome"
        elif "EdgiOS" in s:
            br = "Edge"
        return base + "（" + br + "）"
    if "iPad" in s:
        return "iPad（Safari）"
    if "Android" in s:
        import re as _re
        m = _re.search(r"Android [^;]+;\s([^;)+/]+)", s)
        dev = m.group(1).strip() if m else "Android"
        br = "Chrome"
        if "EdgA" in s:
            br = "Edge"
        elif "MiuiBrowser" in s or "XiaoMi/MiuiBrowser" in s:
            br = "小米浏览器"
        return dev[:24] + "（" + br + "）"
    if "Windows" in s:
        br = "Chrome"
        if "Edg/" in s:
            br = "Edge"
        elif "Firefox/" in s:
            br = "Firefox"
        elif "OPR/" in s:
            br = "Opera"
        return "Windows（" + br + "）"
    if "Macintosh" in s or "Mac OS X" in s:
        br = "Chrome"
        if "Edg/" in s:
            br = "Edge"
        elif "Firefox/" in s:
            br = "Firefox"
        return "Mac（" + br + "）"
    if "Linux" in s:
        return "Linux"
    return "未知设备"


# 内存态清理：每 60 秒最多执行一次，避免每个请求都遍历字典
_LAST_PURGE_TS = 0.0
_PURGE_INTERVAL_SEC = 60
# 在线状态超过该秒数视为离线（前端 5s 轮询，留足余量）
ONLINE_TTL_SECONDS = 120


def _purge_memory_state():
    """清理内存态中的过期条目：验证码、在线状态、密码失败锁、Bark 验证码、流统计。

    这些字典原本只增不减（验证码未被校验即永不释放），长时间运行会缓慢增长。
    """
    now = time.time()
    for cid in [k for k, v in list(_CAPTCHA_STORE.items()) if v[1] < now]:
        _CAPTCHA_STORE.pop(cid, None)
    for uid in [k for k, v in list(ONLINE_MAP.items()) if now - v.get("ts", 0) > ONLINE_TTL_SECONDS]:
        ONLINE_MAP.pop(uid, None)
    for phone in [k for k, v in list(PW_FAILS.items())
                  if v.get("locked_until") and v["locked_until"] < now]:
        PW_FAILS.pop(phone, None)
    for phone in [k for k, v in list(BARK_CODES.items()) if v.get("expires", 0) < now]:
        BARK_CODES.pop(phone, None)
    for sid in [k for k, v in list(STREAM_STATS.items()) if now - v.get("ts", now) > 300]:
        STREAM_STATS.pop(sid, None)


def _maybe_purge():
    global _LAST_PURGE_TS
    now = time.time()
    if now - _LAST_PURGE_TS < _PURGE_INTERVAL_SEC:
        return
    _LAST_PURGE_TS = now
    try:
        _purge_memory_state()
    except Exception as e:
        logger.debug("[purge] 内存态清理失败: %s", e)


def _session_time_gate(now):
    """会话的「时间维度」闸门（不含 DB 校验、不清 session）。返回 (ok, reason)。

    · 绝对上限：距首次登录（login_ts）超过 SESSION_MAX_SECONDS → "max_age"，强制重新登录一次。
      login_ts 是首次登录时刻，全程不改动，不受滑动续期影响。
    · 闲置窗口：距上次活跃（last_active）超过 SESSION_IDLE_SECONDS → "expired"。
      last_active 每次认证请求都会顺延，所以天天在用的用户不会被踢下线。
    · 旧会话兼容：升级前签发的 cookie 没有 last_active，退化用 login_ts 兜底。
    """
    login_ts = session.get("login_ts", 0)
    if not login_ts:
        return False, "expired"
    if (now - login_ts) > SESSION_MAX_SECONDS:
        return False, "max_age"
    last_active = session.get("last_active") or login_ts
    if (now - last_active) > SESSION_IDLE_SECONDS:
        return False, "expired"
    return True, ""


def _renew_session_soft():
    """轻量续期：只做时间闸门判断，不查 DB、也不清 session。

    供 /api/version 心跳使用——前端每 5 秒探活一次，页面开着就代表用户还在线，
    应当顺延 last_active，避免"页面一直开着却因闲置窗口被踢下线"。
    已过期时这里不清 session，把精确的失效原因留给受保护接口给出（前端提示更准确）。
    """
    if "user_id" not in session:
        return
    now = time.time()
    ok, _reason = _session_time_gate(now)
    if not ok:
        return
    last_active = session.get("last_active") or session.get("login_ts", 0)
    if (now - last_active) >= 60:
        session["last_active"] = now


def _check_session_valid():
    """校验当前 session 是否仍有效。有效返回 (True, '')，否则 (False, reason)。

    有效期为「滑动续期 + 绝对上限」双闸门（时间维度见 _session_time_gate）：
      · 闲置 3 天未操作 → expired（每次认证请求顺延 last_active，天天用就永不触发）
      · 登录满 30 天 → max_age（强制重新登录一次，与是否活跃无关）
      · 另叠加 DB 侧校验：账号被删除 / 被禁用 / 被改密踢下线（session_version 不匹配）。
    """
    _maybe_purge()
    if "user_id" not in session:
        return False, "未登录"
    now = time.time()
    # 1) 时间闸门：闲置过期 / 满 30 天强制退出
    ok, reason = _session_time_gate(now)
    if not ok:
        session.clear()
        return False, reason
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT session_version, status FROM users WHERE id=%s", (session["user_id"],))
            row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    if not row:
        session.clear()
        return False, "deleted"
    if row.get("status") == "disabled":
        session.clear()
        return False, "disabled"
    if (row["session_version"] or 0) != session.get("sv", 0):
        session.clear()
        return False, "kicked"
    # 滑动续期：本次请求即为"活跃"，把 last_active 顺延到当前时间。
    # 只在距上次续期超过 1 分钟时才写 session（避免高频请求反复重签 cookie）。
    last_active = session.get("last_active") or session.get("login_ts", 0)
    if (now - last_active) >= 60:
        session["last_active"] = now
    # 更新内存在线状态（不写 DB，避免频繁 UPDATE）
    uid = session["user_id"]
    cur = ONLINE_MAP.get(uid)
    if cur:
        cur["ts"] = time.time()
    else:
        ONLINE_MAP[uid] = {"ts": time.time(), "device": _parse_device()}
    return True, ""


_KICK_MSGS = {
    "expired": "登录已过期，请重新登录",
    "max_age": "登录已过期，请重新登录",
    "deleted": "账号已被删除，请重新注册",
    "disabled": "账号已被禁用，请联系管理员",
    "kicked": "账号信息已变更，请重新登录",
    "未登录": "登录已失效，请重新登录",
}


def login_required(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        ok, reason = _check_session_valid()
        if not ok:
            return jsonify({"ok": False, "msg": _KICK_MSGS.get(reason, "登录已失效，请重新登录"),
                            "reason": reason}), 401
        return fn(*args, **kwargs)
    return wrapper


def admin_required(fn):
    """管理员权限校验。

    先做与 login_required 一致的会话有效性校验（登录过期 / 账号禁用 / 被改密踢下线 /
    账号已删除），再判断角色 —— 避免失效会话仍能访问管理接口。
    """
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        ok, reason = _check_session_valid()
        if not ok:
            return jsonify({"ok": False, "msg": _KICK_MSGS.get(reason, "登录已失效，请重新登录"),
                            "reason": reason}), 401
        if session.get("role") != "admin":
            return jsonify({"ok": False, "msg": "需要管理员权限"}), 403
        return fn(*args, **kwargs)
    return wrapper


def _request_device_id():
    """从当前请求中提取设备标识（JSON body / 表单 / query 均可）。"""
    try:
        data = request.get_json(silent=True) or {}
        if isinstance(data, dict) and data.get('device_id'):
            return str(data['device_id'])
    except Exception:
        pass
    return request.form.get('device_id') or request.args.get('device_id') or ''


def _has_industrial_access(uid):
    """是否拥有工业控制模块访问权限：管理员恒有，其余查 ext_module_access。"""
    if session.get('role') == 'admin':
        return True
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM ext_module_access WHERE module_name='industrial' AND user_id=%s", (uid,))
            return cur.fetchone() is not None
    finally:
        conn.close()


def arm_page_lock_required(fn):
    """工控页写操作校验：当前用户必须是页面占用者。

    请求若携带 device_id，则同时校验设备标识（与 page_enter 的"同设备放行"语义一致）；
    未携带时退化为仅校验用户，兼容未升级的调用方。
    """
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        uid = session.get('user_id')
        did = _request_device_id()
        info = arm.page_lock_info()
        if not info or info.get('user_id') != uid:
            return jsonify({"ok": False, "msg": "您无该页面的操作权限，请先进入页面获取控制权"}), 403
        locked_did = info.get('device_id') or ''
        if did and locked_did and did != locked_did:
            return jsonify({"ok": False, "msg": "当前设备无操作权限，请重新进入页面获取控制权"}), 403
        return fn(*args, **kwargs)
    return wrapper


def _batch_delete_rows(conn, table, id_key, ids):
    """按 id 列表批量删除行（纯行删除场景），返回删除行数。

    仅用于「选 id → 删行」这一最简单的一类批量删除；
    需要先清理磁盘文件或带额外过滤条件的场景不在此复用。
    """
    fmt = ",".join(["%s"] * len(ids))
    with conn.cursor() as cur:
        cur.execute(f"DELETE FROM {table} WHERE {id_key} IN ({fmt})", ids)
        return cur.rowcount


def _parse_bark_key(raw):
    """从 Bark Key 或完整推送 URL 中提取 key。

    支持两种输入：
      - 纯 key：``AbCdEfGh``
      - 完整 URL：``https://api.day.app/KEY/title/body?group=x`` 或 ``api.day.app/KEY``
    提取失败（长度不在 8-64）返回空字符串，由调用方决定报错文案。
    """
    raw = (raw or "").strip()
    if "://" in raw:
        after = raw.split("://", 1)[1]          # api.day.app/KEY/title/body?...
        parts = after.split("/")                 # ['api.day.app', 'KEY', 'title', ...]
        raw = parts[1] if len(parts) >= 2 else ""
    else:
        parts = raw.split("/")
        raw = parts[-1] if parts else ""
    if 8 <= len(raw) <= 64:
        return raw
    return ""


def _mask_bark_key(key):
    """把 Bark Key 掩码为「前 4 位 + 星号」，避免明文离开后端。"""
    if not key:
        return ""
    if len(key) <= 4:
        return "****"
    return key[:4] + "*" * max(len(key) - 4, 8)


def _paging():
    """从 query 参数解析分页（page/limit），返回 (page, limit, offset)。"""
    def _int(name, default):
        try:
            return int(request.args.get(name, default))
        except (TypeError, ValueError):
            return default
    page = max(1, _int("page", 1))
    limit = min(200, max(1, _int("limit", 20)))
    return page, limit, (page - 1) * limit


def _user_dict(row):
    return {"id": row["id"], "username": row["username"], "role": row["role"],
            "user_code": row.get("user_code", ""), "phone": row.get("phone", "") or ""}


def _gen_user_code(conn):
    """生成 8 位纯数字用户编号，首位非 0，保证不重复（委托 db.gen_user_code）。"""
    return db.gen_user_code(conn.cursor())


# ---------- 启动初始化 ----------
_DERIVED_TASK_SUFFIXES = ("-pose", "-seg", "-cls", "-obb")


def _pick_default_model(files):
    """首次初始化时挑「当前模型」：显式默认 > 常规检测模型 > 字典序第一个。

    历史坑：以前直接取 sorted(files)[0]，而 '-'（45）< '.'（46），
    yolo26m-pose.pt 永远排在 yolo26m.pt 前面 —— 清库重建后当前模型就变成
    姿态估计权重（类别是人体关键点），业务侧自然"检测不出东西"。
    现在优先 config.DEFAULT_MODEL（可用 HELMET_DEFAULT_MODEL 覆盖），
    再不行就跳过 -pose/-seg/-cls/-obb 这些衍生任务权重。
    """
    if not files:
        return None
    preferred = (getattr(config, "DEFAULT_MODEL", "") or "").strip()
    if preferred and preferred in files:
        return preferred
    if preferred:
        logger.warning("[models] 配置的默认模型 %s 不在 models_lib，按常规检测模型挑选", preferred)
    plain = [
        f for f in files
        if not os.path.splitext(f)[0].lower().endswith(_DERIVED_TASK_SUFFIXES)
    ]
    return (plain or files)[0]


def init_models_db():
    """扫描 models_lib，同步到 models 表；选一个当前模型。"""
    files = detector.scan_models()
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, file_name, is_current FROM models")
            existing = {r["file_name"]: r for r in cur.fetchall()}
            # 新增扫描到的模型
            for f in files:
                if f not in existing:
                    size = os.path.getsize(detector.model_path(f))
                    cur.execute(
                        "INSERT INTO models (name, file_name, size_bytes, status) "
                        "VALUES (%s, %s, %s, 'ready')",
                        (os.path.splitext(f)[0], f, size),
                    )
            # 设置当前模型
            cur.execute("SELECT id FROM models WHERE is_current=1")
            cur_existing = cur.fetchone()
            if not cur_existing and files:
                chosen = _pick_default_model(files)
                cur.execute(
                    "UPDATE models SET is_current=1 WHERE file_name=%s", (chosen,)
                )
                detector.set_current(chosen)
                logger.info("[models] 首次初始化当前模型：%s（候选 %d 个）", chosen, len(files))
            elif cur_existing:
                with conn.cursor() as cur2:
                    cur2.execute(
                        "SELECT file_name FROM models WHERE is_current=1"
                    )
                    r = cur2.fetchone()
                    if r:
                        detector.current_file = r["file_name"]
        conn.commit()
    finally:
        conn.close()


def init_admin():
    """若 users 表为空，创建默认 admin/admin 账号，并预置 user_code 与管理员手机号。

    - user_code：前端个人资料页/用户列表展示的 8 位用户编号，创建时一并写入。
    - phone（管理员手机号）：来自 config.ADMIN_PHONE（默认值见 config.py，可由
      环境变量 HELMET_ADMIN_PHONE 或打包 config.env 覆盖）。创建时一并写入，
      对「已存在但 phone 为空」的历史 admin 也幂等补写，绝不覆盖页面上改过的号码。
      这样开发环境（无 config.env、无打包启动器补写步骤）也能拿到正确手机号。
    """
    phone = (config.ADMIN_PHONE or "").strip()
    if len(phone) != 11 or not phone.isdigit() or not phone.startswith("1"):
        phone = ""  # 非法则留空，不写入脏值
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS c FROM users")
            if cur.fetchone()["c"] == 0:
                code = db.gen_user_code()
                cur.execute(
                    "INSERT INTO users (username, password_hash, role, user_code, phone) "
                    "VALUES (%s, %s, 'admin', %s, %s)",
                    ("admin", generate_password_hash("admin"), code, phone),
                )
            elif phone:
                # 历史库：管理员手机号缺失时幂等补写（不覆盖已设置的号码）
                cur.execute(
                    "UPDATE users SET phone=%s "
                    "WHERE role='admin' AND (phone IS NULL OR phone='')",
                    (phone,),
                )
        conn.commit()
    finally:
        conn.close()


# ==================== 认证 ====================
# ==================== 图形验证码 ====================
_CAPTCHA_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"  # 排除 0/O、1/l/I
_CAPTCHA_STORE = {}  # cid -> (code, expire_ts)

def _gen_captcha():
    code = "".join(random.choice(_CAPTCHA_CHARS) for _ in range(4))
    w, h = 120, 44
    img = Image.new("RGB", (w, h), (245, 247, 250))
    draw = ImageDraw.Draw(img)
    # 噪点
    for _ in range(120):
        draw.point((random.randint(0, w), random.randint(0, h)),
                   fill=(random.randint(150, 220), random.randint(150, 220), random.randint(150, 220)))
    # 干扰线
    for _ in range(4):
        draw.line([(random.randint(0, w//2), random.randint(0, h)),
                   (random.randint(w//2, w), random.randint(0, h))],
                  fill=(random.randint(120, 180), random.randint(120, 180), random.randint(120, 180)), width=1)
    # 字符（轻微旋转）
    try:
        font = ImageFont.truetype("arial.ttf", 26)
    except Exception:
        font = ImageFont.load_default()
    x = 14
    for ch in code:
        ch_img = Image.new("RGBA", (28, 34), (0, 0, 0, 0))
        ch_draw = ImageDraw.Draw(ch_img)
        ch_draw.text((2, 2), ch, font=font, fill=(random.randint(30, 90), random.randint(30, 90), random.randint(30, 90)))
        ch_img = ch_img.rotate(random.randint(-25, 25), expand=1)
        img.paste(ch_img, (x, random.randint(2, 8)), ch_img)
        x += 26
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return code, base64.b64encode(buf.getvalue()).decode()

@app.get("/api/captcha")
def get_captcha():
    cid = uuid.uuid4().hex
    code, b64 = _gen_captcha()
    _CAPTCHA_STORE[cid] = (code, time.time() + 300)  # 5 分钟有效
    return jsonify({"ok": True, "cid": cid, "img": "data:image/png;base64," + b64})

def _check_captcha(data):
    cid = data.get("captcha_id") or ""
    user_code = (data.get("captcha_code") or "").strip()
    rec = _CAPTCHA_STORE.pop(cid, None)
    if not rec:
        return False, "验证码已过期，请刷新后重试"
    if time.time() > rec[1]:
        return False, "验证码已过期，请刷新后重试"
    if not user_code or user_code.lower() != rec[0].lower():
        return False, "验证码错误，请重新输入"
    return True, ""


@app.post("/api/register")
def register():
    data = request.get_json(force=True)
    ok, msg = _check_captcha(data)
    if not ok:
        return jsonify({"ok": False, "msg": msg}), 400
    phone = (data.get("phone") or "").strip()
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    # 手机号必填且格式校验
    if not phone or len(phone) != 11 or not phone.isdigit() or not phone.startswith("1"):
        return jsonify({"ok": False, "msg": "请输入正确的 11 位手机号"}), 400
    if len(password) < 6:
        return jsonify({"ok": False, "msg": "密码至少 6 位"}), 400
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE phone=%s", (phone,))
            if cur.fetchone():
                return jsonify({"ok": False, "msg": "该手机号已注册"}), 400
            # 用户名为空则自动生成
            if not username:
                username = "user_" + "".join(random.choices(string.digits, k=6))
            else:
                cur.execute("SELECT id FROM users WHERE username=%s", (username,))
                if cur.fetchone():
                    return jsonify({"ok": False, "msg": "用户名已存在"}), 400
            code = _gen_user_code(conn)
            cur.execute(
                "INSERT INTO users (username, password_hash, role, user_code, phone) "
                "VALUES (%s, %s, 'user', %s, %s)",
                (username, generate_password_hash(password), code, phone),
            )
            uid = cur.lastrowid
        conn.commit()
        # 注册即登录：补齐完整会话字段（login_ts 缺失会导致下一个请求被判 expired 踢回登录页）
        now = time.time()
        session["user_id"] = uid
        session["username"] = username
        session["role"] = "user"
        session["login_ts"] = now      # 首次登录时刻：绝对上限（30 天）的锚点
        session["last_active"] = now   # 滑动续期的锚点
        session["sv"] = 0              # 新用户 session_version 为 0
        session.permanent = True       # 持久化 cookie，关浏览器不丢
        return jsonify({"ok": True, "user": {"id": uid, "username": username, "role": "user", "user_code": code, "phone": phone}})
    finally:
        conn.close()


@app.post("/api/login")
def login():
    data = request.get_json(force=True)
    phone = (data.get("phone") or "").strip()
    password = data.get("password") or ""
    if not phone:
        return jsonify({"ok": False, "msg": "请输入手机号"}), 400
    now = time.time()
    # 检查锁定状态
    with _pw_lock:
        rec = PW_FAILS.get(phone)
        if rec and rec.get("locked_until", 0) > now:
            remain = int(rec["locked_until"] - now)
            return jsonify({"ok": False, "msg": "密码错误次数过多，账号已锁定，请 %d 分钟后再试" % (remain // 60 + 1)}), 429
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE phone=%s", (phone,))
            row = cur.fetchone()
        if not row:
            return jsonify({"ok": False, "msg": "该手机号未注册，请先注册"}), 404
        if not check_password_hash(row["password_hash"], password):
            # 密码错误：记录失败次数
            with _pw_lock:
                f = PW_FAILS.get(phone, {"fails": 0, "locked_until": 0})
                f["fails"] += 1
                if f["fails"] >= PW_MAX_FAILS:
                    f["locked_until"] = now + PW_LOCK_SECONDS
                    f["fails"] = 0
                    PW_FAILS[phone] = f
                    return jsonify({"ok": False, "msg": "密码错误次数过多，账号已锁定 10 分钟"}), 429
                PW_FAILS[phone] = f
                left = PW_MAX_FAILS - f["fails"]
                return jsonify({"ok": False, "msg": "密码错误，还可尝试 %d 次" % left}), 401
        # 密码正确：清除失败记录
        with _pw_lock:
            PW_FAILS.pop(phone, None)
        if row.get("status") == "disabled":
            return jsonify({"ok": False, "msg": "账号已被禁用，请联系管理员"}), 403
        session["user_id"] = row["id"]
        session["username"] = row["username"]
        session["role"] = row["role"]
        session["login_ts"] = time.time()   # 首次登录时刻：绝对上限（30 天）的锚点，不随续期滚动
        session["last_active"] = time.time()  # 滑动续期的锚点，每次认证请求顺延
        session["sv"] = row["session_version"] or 0
        session.permanent = True  # 持久化 cookie，关浏览器不丢
        # 注：cookie 有效期统一由 app.config["PERMANENT_SESSION_LIFETIME"]（30 天）控制，
        # 此处不再逐次覆盖，否则会把全局 30 天改回旧值。
        ONLINE_MAP[row["id"]] = {"ts": time.time(), "device": _parse_device()}
        # 上线时不写 DB，仅记录内存态；last_seen 在真正下线时由 /api/offline 写一次
        return jsonify({"ok": True, "user": _user_dict(row)})
    finally:
        conn.close()


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/me")
@login_required
def me():
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, username, role, created_at, user_code, phone, status, bark_key FROM users WHERE id=%s",
                        (session["user_id"],))
            row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        return jsonify({"ok": False, "msg": "未登录"}), 401
    # 敏感字段：bark_key 仅回传掩码串，明文永不离后端
    real = row.pop("bark_key") or ""
    row["bark_key"] = _mask_bark_key(real)
    row["has_bark"] = bool(real)
    return jsonify({"ok": True, "user": row})


# ==================== 模型管理 ====================
def _parse_classes(v):
    """把 models.classes（JSON 字符串或已是数组）解析为类别名数组。"""
    if not v:
        return []
    if isinstance(v, list):
        return v
    try:
        return json.loads(v)
    except Exception:
        return []


@app.get("/api/models")
@login_required
def list_models():
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM models ORDER BY is_current DESC, id")
            rows = cur.fetchall()
        result = []
        loaded = list(detector._models.keys())  # 内存里已加载的
        for r in rows:
            cached_classes = _parse_classes(r.get("classes"))
            # 懒回填真实元信息：tags 与 classes 都为空时才加载模型读类别数/参数量。
            # （两者任一有值就够展示，避免「classes 已写好、tags 为空」的旧库反复加载模型）
            # 与 refresh-meta 同样的保护：显存预检 + 读后即卸，避免列表接口拖垮显存
            if not r["tags"] and not cached_classes:
                ok, free = _vram_ok()
                if not ok:
                    logger.warning("[models] 跳过 %s 元信息回填：显存不足（剩余 %sMB）",
                                   r["file_name"], free)
                else:
                    was_loaded = r["file_name"] in detector._models
                    try:
                        info = detector.get_model_info(r["file_name"])
                        with conn.cursor() as cur2:
                            cur2.execute(
                                "UPDATE models SET tags=%s, params=%s, classes=%s WHERE id=%s",
                                (info["names"], f'{info["params_m"]} M',
                                 json.dumps(info.get("names_list") or [], ensure_ascii=False),
                                 r["id"]),
                            )
                        r["tags"] = info["names"]
                        cached_classes = info.get("names_list") or []
                        r["params"] = f'{info["params_m"]} M'
                    except Exception as e:
                        logger.warning("[models] 读取 %s 元信息失败: %s", r['file_name'], e)
                    finally:
                        # 读完即卸：不动当前模型，也不动本来就在缓存里的模型
                        if not was_loaded and r["file_name"] != detector.get_current():
                            detector.unload(r["file_name"])
            tags_list = r["tags"].split(",") if r["tags"] else list(cached_classes)
            size_mb = round(r["size_bytes"] / 1024 / 1024, 1)
            result.append({
                "id": r["id"],
                "name": r["name"],
                "file_name": r["file_name"],
                "desc": r["description"],
                "tags": tags_list,
                # 具体类别名（供"查看类别"使用）：优先 classes 列，回落用 tags 拆出来的
                "classes": cached_classes or tags_list,
                "map": float(r["map_val"]) if r["map_val"] else None,
                "params": r["params"],
                "size": f"{size_mb} MB",
                "status": "current" if r["is_current"] else ("loaded" if r["file_name"] in loaded else "unloaded"),
                "note": r["note"],
            })
        conn.commit()
        return jsonify({"ok": True, "models": result,
                        "current": detector.get_current()})
    finally:
        conn.close()


@app.get("/api/models/current-name")
@login_required
def current_model_name():
    """轻量接口：只返回当前模型的显示名，**不触发任何模型加载**。

    检测页（VIEW_LOADERS['detect']）每 5 秒轮询会调用它。此前用的是全量 /api/models，
    而 /api/models 会对 tags 为空的模型回填元信息从而加载模型，代价过大且可能被高频轮询放大。
    需要类别名等完整信息请用 /api/models/current（工控页在用）。
    """
    cur = detector.get_current()
    if not cur:
        return jsonify({"ok": True, "file_name": None, "name": None})
    conn = db.get_db()
    try:
        with conn.cursor() as c:
            c.execute("SELECT name FROM models WHERE file_name=%s", (cur,))
            row = c.fetchone()
    finally:
        conn.close()
    return jsonify({"ok": True, "file_name": cur,
                    "name": (row["name"] if row and row["name"] else cur)})


@app.get("/api/detect/config")
def detect_config():
    """公共轻量接口：暴露检测相关的可调整默认值（供前端预填，避免把默认值写死在前端）。

    目前只暴露 default_conf（置信度默认值），其值来自 config.DEFAULT_CONF，
    运维可直接改 config.py 调整，无需动前端代码。
    """
    return jsonify({"ok": True, "default_conf": DEFAULT_CONF})


@app.get("/api/models/current")
@login_required
def current_model():
    """返回当前使用的模型信息（含类别名）。

    类别名**优先读库**（models.classes），读不到才加载模型取，并顺手回写库，
    避免每次都触发模型加载（冷启动会卡 1~2 秒）。
    """
    cur = detector.get_current()
    if not cur:
        return jsonify({"ok": True, "model": None})
    conn = db.get_db()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT * FROM models WHERE file_name=%s", (cur,))
            row = cursor.fetchone()
        if row:
            names_list = _parse_classes(row.get("classes"))
            if not names_list:
                # 库里没有 -> 加载一次并把类别名写回库，后续就不用再加载
                try:
                    names_dict = detector.current_names()
                    names_list = [str(names_dict.get(i, i)) for i in sorted(names_dict.keys())]
                    with conn.cursor() as cur2:
                        cur2.execute(
                            "UPDATE models SET classes=%s WHERE id=%s",
                            (json.dumps(names_list, ensure_ascii=False), row["id"]),
                        )
                    conn.commit()
                except Exception as e:
                    logger.warning("[models] 读取/回写类别名失败: %s", e)
                    names_list = []
            return jsonify({"ok": True, "model": {
                "id": row["id"], "name": row["name"],
                "file_name": row["file_name"], "description": row["description"],
                "classes": names_list, "class_count": len(names_list),
            }})
        names_dict = detector.current_names()
        names_list = [str(names_dict.get(i, i)) for i in sorted(names_dict.keys())]
        return jsonify({"ok": True, "model": {"file_name": cur, "name": cur,
                                              "classes": names_list,
                                              "class_count": len(names_list)}})
    finally:
        conn.close()


@app.post("/api/models/refresh-meta")
@admin_required
def refresh_models_meta():
    """扫描 models_lib 文件夹：新文件自动入库；然后重新加载所有模型，
    把真实类别数/参数量回填数据库。

    三道闸（避免批量加载挤爆显存 / 挤出他人正在用的模型）：
      1) _META_LOCK 非阻塞加锁：已有刷新在跑则直接 429，不叠加；
      2) 逐个加载前查剩余显存，低于 MIN_FREE_VRAM_MB 则跳过该模型并记入 failed；
      3) 读完元信息即刻卸载「非当前模型且刷新前不在缓存」的模型，收尾再 empty_cache()。
    严格模式 META_REFRESH_STRICT=True 时，检测到活跃推理会直接拒绝刷新。
    """
    # 闸 1：防并发叠加
    if not _META_LOCK.acquire(blocking=False):
        return jsonify({"ok": False, "msg": "已有刷新任务在进行中，请稍后再试"}), 429
    busy = _has_active_inference()
    if busy and META_REFRESH_STRICT:
        _META_LOCK.release()
        return jsonify({"ok": False, "msg": "当前有检测任务在运行，请稍后再刷新"}), 429
    conn = db.get_db()
    added = 0
    try:
        # 1) 扫描文件夹，把 DB 里没有的模型文件插入
        with conn.cursor() as cur:
            cur.execute("SELECT file_name FROM models")
            known = {r["file_name"] for r in cur.fetchall()}
        for fname in os.listdir(MODELS_DIR):
            if not fname.lower().endswith((".pt", ".onnx", ".engine")):
                continue
            if fname in known:
                continue
            size = os.path.getsize(os.path.join(MODELS_DIR, fname))
            display_name = os.path.splitext(fname)[0]
            with conn.cursor() as cur2:
                cur2.execute(
                    "INSERT INTO models (name, file_name, size_bytes) VALUES (%s, %s, %s)",
                    (display_name, fname, size),
                )
            added += 1

        # 2) 重新读所有模型的真实元信息
        with conn.cursor() as cur:
            cur.execute("SELECT id, file_name FROM models")
            rows = cur.fetchall()
        updated, failed = 0, []
        for r in rows:
            fname = r["file_name"]
            # 闸 2：显存预检
            ok, free = _vram_ok()
            if not ok:
                failed.append(f"{fname}: 显存不足（剩余 {free}MB < {MIN_FREE_VRAM_MB}MB），已跳过")
                logger.warning("[meta] 跳过 %s：显存不足（剩余 %sMB）", fname, free)
                continue
            was_loaded = fname in detector._models      # 刷新前是否已在缓存（不可卸）
            try:
                info = detector.get_model_info(fname)
                size = os.path.getsize(detector.model_path(fname))
                with conn.cursor() as cur2:
                    cur2.execute(
                        "UPDATE models SET tags=%s, params=%s, size_bytes=%s, classes=%s"
                        " WHERE id=%s",
                        (info["names"], f'{info["params_m"]} M', size,
                         json.dumps(info.get("names_list") or [], ensure_ascii=False), r["id"]),
                    )
                updated += 1
            except Exception as e:
                failed.append(f"{fname}: {e}")
            finally:
                # 闸 3：读完即卸（不动当前模型，也不动刷新前就在用的模型）
                if not was_loaded and fname != detector.get_current():
                    detector.unload(fname)
        conn.commit()
    finally:
        conn.close()
        _release_vram_cache()
        _META_LOCK.release()
    return jsonify({"ok": True, "added": added, "updated": updated, "failed": failed,
                    "busy": busy})


@app.post("/api/models/switch")
@admin_required
def switch_model():
    data = request.get_json(force=True)
    file_name = data.get("file_name")
    if not file_name:
        return jsonify({"ok": False, "msg": "缺少 file_name"}), 400
    try:
        detector.set_current(file_name)
    except Exception as e:
        return jsonify({"ok": False, "msg": str(e)}), 400
    # ① 只做模型标记，短事务快速提交
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE models SET is_current=0")
            cur.execute(
                "UPDATE models SET is_current=1 WHERE file_name=%s", (file_name,)
            )
        conn.commit()
    finally:
        conn.close()

    # ② 清理"按类别"的配置（旧模型类别名失效），放在**独立短事务**里：
    #    - 只更新"确实有内容"的行，缩小锁范围，避免全表 UPDATE 长时间持锁；
    #    - 失败也不影响切换结果（仅记日志），防止锁等待把整个请求拖垮。
    #    保留：放置位列表、标定值、动作组与途经点卡片、分拣记录（按 model_name 区分）。
    conn2 = db.get_db()
    try:
        with conn2.cursor() as cur:
            cur.execute(
                "UPDATE users SET normal_class_map='{}' "
                "WHERE normal_class_map IS NOT NULL AND normal_class_map <> '{}'"
            )
            cur.execute(
                "UPDATE users SET class_group_map='{}' "
                "WHERE class_group_map IS NOT NULL AND class_group_map <> '{}'"
            )
            cur.execute(
                "UPDATE users SET selected_classes=NULL WHERE selected_classes IS NOT NULL"
            )
            cur.execute("UPDATE arm_config SET class_area_map='{}', selected_classes=NULL WHERE id=1")
        conn2.commit()
    except Exception as e:
        logger.warning("[arm] 切换模型后清理类别配置失败（不影响切换）: %s", e)
        try:
            conn2.rollback()
        except Exception:
            pass
    finally:
        conn2.close()

    # ③ 事务外再重载分拣配置（内部会再取连接，绝不能放在事务里嵌套持锁）
    try:
        sorter.reload_config(session.get('user_id'))
    except Exception as e:
        logger.warning("[arm] 切换模型后重载分拣映射失败: %s", e)
    return jsonify({"ok": True, "current": file_name,
                    "cleaned": "已清空所有人的类别映射（放置位/动作组）与选中类别"})


@app.post("/api/models/unload-all")
@admin_required
def unload_all_models():
    """一键卸载所有模型，保留当前正在用的那个。"""
    cur_file = detector.get_current()
    unloaded = []
    for fn in list(detector._models.keys()):
        if fn == cur_file:
            continue
        detector.unload(fn)
        unloaded.append(fn)
    return jsonify({"ok": True, "unloaded": len(unloaded)})


@app.post("/api/models/<file_name>/unload")
@admin_required
def unload_model(file_name):
    """把指定模型从内存缓存卸载（不删文件）。当前使用中的模型禁止卸载。"""
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT is_current FROM models WHERE file_name=%s", (file_name,))
            row = cur.fetchone()
        if row and row["is_current"]:
            return jsonify({"ok": False, "msg": "当前使用中的模型不可卸载"}), 400
    finally:
        conn.close()
    try:
        detector.unload(file_name)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "msg": str(e)}), 500


@app.delete("/api/models/<int:mid>")
@admin_required
def delete_model(mid):
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT file_name, is_current FROM models WHERE id=%s", (mid,))
            row = cur.fetchone()
            if not row:
                return jsonify({"ok": False, "msg": "模型不存在"}), 404
            if row["is_current"]:
                return jsonify({"ok": False, "msg": "不能删除当前使用的模型"}), 400
            path = detector.model_path(row["file_name"])
            detector.unload(row["file_name"])
            if os.path.exists(path):
                os.remove(path)
            cur.execute("DELETE FROM models WHERE id=%s", (mid,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.post("/api/models/upload")
@admin_required
def upload_model():
    if "file" not in request.files:
        return jsonify({"ok": False, "msg": "缺少模型文件"}), 400
    f = request.files["file"]
    orig_filename = f.filename or "model.pt"
    ext = os.path.splitext(orig_filename)[1].lower()
    if ext not in (".pt", ".onnx", ".engine"):
        return jsonify({"ok": False, "msg": "仅支持 .pt/.onnx/.engine"}), 400
    # 磁盘文件名用 UUID，避免中文/特殊字符/重名；原始名仅作显示
    disk_name = uuid.uuid4().hex + ext
    dest = os.path.join(MODELS_DIR, disk_name)
    f.save(dest)
    size = os.path.getsize(dest)
    # 显示名：用户填的 name 优先，否则用原始文件名（保留中文，去扩展名）
    display_name = request.form.get("name") or os.path.splitext(orig_filename)[0]
    tags = request.form.get("tags", "")
    note = request.form.get("note", "")
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO models (name, file_name, tags, note, size_bytes) "
                "VALUES (%s, %s, %s, %s, %s)",
                (display_name, disk_name, tags, note, size),
            )
        conn.commit()
        return jsonify({"ok": True, "file_name": disk_name})
    finally:
        conn.close()


# ==================== 图片检测 ====================
def _train_locked_response():
    """训练期间的推理守卫。

    所有推理接口统一调用：训练进行中就拒绝，避免与训练抢 GPU／显存。
    返回 (响应, 状态码) —— 放行时返回 (None, None)。
    """
    try:
        _lk = trainer.lock_status()
        if _lk.get("locked"):
            return jsonify({"ok": False,
                            "msg": "训练任务进行中，推理功能已锁定（%s）"
                                   % (_lk.get("job_name") or "")}), 403
    except Exception:
        pass
    return None, None


@app.post("/api/detect/image")
@login_required
def detect_image():
    _gl = _train_locked_response()
    if _gl[0]:
        return _gl
    if "file" not in request.files:
        return jsonify({"ok": False, "msg": "请上传图片"}), 400
    f = request.files["file"]
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ALLOWED_IMAGE_EXT:
        return jsonify({"ok": False, "msg": "不支持的图片格式"}), 400

    import cv2
    import numpy as np
    # 读原图
    raw = f.read()
    # 单张图片独立上限（防止整张解码后 OOM）：超限直接拒绝，不解码
    if len(raw) > MAX_IMAGE_MB * 1024 * 1024:
        return jsonify({"ok": False, "msg": f"图片过大，单张不能超过 {MAX_IMAGE_MB} MB"}), 400
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return jsonify({"ok": False, "msg": "图片解析失败"}), 400

    # 保存原图
    uid = uuid.uuid4().hex[:12]
    orig_name = f"{uid}{ext}"
    orig_path = os.path.join(UPLOAD_IMAGES, orig_name)
    cv2.imwrite(orig_path, img)

    # 中断约定（与视频一致）：落到一半用户刷新/关页面 → 不推理、不留文件、不落库
    if _client_gone():
        _discard_uploaded([orig_path], f.filename)
        return jsonify({"ok": False, "msg": "已取消"}), 200

    conf = float(request.form.get("conf", DEFAULT_CONF))
    try:
        # plot=False：不再生成带框结果图（落盘只留原图 + 框数据），框一律前端现场绘制
        _plotted, boxes, stats, elapsed = detector.detect_image(img, conf=conf, plot=False)
    except Exception as e:
        _discard_uploaded([orig_path], f.filename)   # 推理失败：原图没人引用，别留孤儿
        return jsonify({"ok": False, "msg": f"推理失败: {e}"}), 500

    # 推理期间断开（图片也可能要几秒，尤其首次加载模型）：结果用户看不到 → 不落库、不留文件
    if _client_gone():
        _discard_uploaded([orig_path], f.filename)
        return jsonify({"ok": False, "msg": "已取消"}), 200

    # 保存框数据（JSON）：这是本次检测唯一额外落盘的东西，体积可以忽略
    boxes_url = ""
    boxes_path = ""
    try:
        bh, bw = img.shape[:2]
        tl_name = f"{uid}_boxes.json"
        boxes_path = os.path.join(UPLOAD_BOXES, tl_name)
        with open(boxes_path, "w", encoding="utf-8") as tf:
            json.dump({"width": int(bw), "height": int(bh),
                       "names": {str(b.get("cls")): b.get("cls_name") for b in (boxes or [])},
                       "boxes": boxes},
                      tf, ensure_ascii=False, separators=(",", ":"))
        boxes_url = f"/uploads/boxes/{tl_name}"
    except Exception as e:
        logger.warning("[detect] 图片框数据写入失败（不影响主流程）: %s", e)

    # 落库前最后探一次：此时断开的话，原图和框数据都要一起收走
    if _client_gone():
        _discard_uploaded([orig_path, boxes_path], f.filename)
        return jsonify({"ok": False, "msg": "已取消"}), 200

    # 结论（通用：按类别汇总，不绑定具体业务；类别名以模型权重内置 names 为准）
    total = sum(stats.values())
    if total > 0:
        detail = "、".join(f"{k}×{v}" for k, v in sorted(stats.items()))
        conclusion = f"检测到 {total} 个目标（{detail}）"
    else:
        conclusion = "未检测到目标"

    # 落库
    conn = db.get_db()
    record_id = None
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO detection_records "
                "(user_id, username, image_name, image_url, result_url, boxes_url, media_type, "
                " conclusion, stats_json, boxes_json, model_name, duration_ms) "
                "VALUES (%s,%s,%s,%s,%s,%s,'image',%s,%s,%s,%s,%s)",
                (session["user_id"], session["username"], f.filename,
                 f"/uploads/images/{orig_name}",
                 f"/uploads/images/{orig_name}",   # result_url：不再有结果图，指向原图（框由前端画）
                 boxes_url or "",
                 conclusion, json.dumps(stats, ensure_ascii=False),
                 json.dumps(boxes, ensure_ascii=False),
                 detector.get_current(), elapsed),
            )
            record_id = cur.lastrowid
        conn.commit()
    finally:
        conn.close()

    return jsonify({
        "ok": True,
        "record_id": record_id,
        "image_url": f"/uploads/images/{orig_name}",
        "result_url": f"/uploads/images/{orig_name}",   # 不再生成结果图：展示一律原图 + 前端框
        "boxes_url": boxes_url,
        "boxes": boxes,
        "stats": stats,
        "conclusion": conclusion,
        "duration_ms": elapsed,
    })


# 注：旧的 /api/detect/image/save-result（前端合成整图回存归档）已删除。
# 落盘策略改为「只存原图 + 框数据 JSON」，前端不再回传合成图，带框图片改由下载接口现场绘制。


# ==================== 实时摄像头帧推理（不落库） ====================
@app.post("/api/detect/warmup")
@login_required
def detect_warmup():
    """开启实时推理前预热模型：把"读盘+载入显存+CUDA 初始化"这几秒挪到有提示的阶段，
    避免点「开启推理」后首帧卡住且没有任何反馈。"""
    ok, msg = detector.ensure_loaded()
    return jsonify({"ok": ok, "msg": msg})


@app.post("/api/detect/frame")
@login_required
def detect_frame():
    """接收一帧 JPEG（multipart 字段 frame），返回标注后的 JPEG base64 + stats。"""
    # 训练期间禁止推理：与智能检测页的锁定逻辑对齐。
    # 工控页的摄像头推理走的也是本接口，不拦的话训练时能继续推理抢 GPU。
    _gl = _train_locked_response()
    if _gl[0]:
        return _gl
    if "frame" not in request.files:
        return jsonify({"ok": False, "msg": "缺少帧数据"}), 400
    import cv2
    import numpy as np
    raw = request.files["frame"].read()
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return jsonify({"ok": False, "msg": "帧解析失败"}), 400
    conf = float(request.form.get("conf", DEFAULT_CONF))
    # want_frame=0：只回结构化结果，不回标注图（工控页已改为前端 canvas 画框，
    # 省掉绘图 + JPEG 编码 + base64 传输约 70KB/帧）。检测页摄像头仍走默认（要图）。
    want_frame = request.form.get("want_frame", "1") != "0"
    try:
        plotted, boxes, stats, elapsed = detector.detect_image(img, conf=conf, plot=want_frame)
    except Exception as e:
        return jsonify({"ok": False, "msg": f"推理失败: {e}"}), 500
    frame_data = None
    if want_frame:
        ok2, buf = cv2.imencode(".jpg", plotted, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        if not ok2:
            return jsonify({"ok": False, "msg": "结果编码失败"}), 500
        frame_data = "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()
    # 每个类别的最大置信度（供分拣取置信度最大类别）
    class_conf = {}
    for b in boxes:
        cn = b["cls_name"]
        if b["conf"] > class_conf.get(cn, 0):
            class_conf[cn] = round(b["conf"], 4)
    return jsonify({
        "ok": True,
        "frame": frame_data,
        # 框坐标（相对**本次上传的画面**：ROI 模式下是裁剪图坐标，前端自行加 ROI 偏移）
        "boxes": boxes,
        "stats": stats,
        "class_conf": class_conf,
        "total": sum(stats.values()),
        "duration_ms": elapsed,
    })


# 网络流最新统计：sid -> dict，供前端轮询（MJPEG 帧本身无法携带结构化数据）
STREAM_STATS = {}
# 网络流运行时置信度：sid -> float，供「运行时实时修改」使用；
# 连接建立时写入初始值，前端失焦改值时调用接口更新，gen() 每帧读最新值。
STREAM_CONF = {}

# ==================== 网络流实时检测（MJPEG 推流，不落库） ====================
_FONT_CANDIDATES = ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf",
                    "C:/Windows/Fonts/simsun.ttc", "/System/Library/Fonts/PingFang.ttc")


def _pick_pil_fonts(big_size, small_size):
    """按候选列表加载中文字体，返回 (大字体, 小字体)；都不可用时退回默认字体。

    OpenCV 的 cv2.putText 不支持中文，绘制中文提示帧统一走 PIL。
    """
    for fp in _FONT_CANDIDATES:
        if os.path.exists(fp):
            try:
                return ImageFont.truetype(fp, big_size), ImageFont.truetype(fp, small_size)
            except Exception as e:
                logger.debug("[frame] 字体不可用，尝试下一个: %s (%s)", fp, e)
    default = ImageFont.load_default()
    return default, default


def _error_frame_jpeg(title, subtitle=""):
    """生成中文错误提示帧（OpenCV 不支持中文，改用 PIL 绘制）。"""
    import cv2
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
    W, H = 640, 360
    img = Image.new("RGB", (W, H), (32, 32, 32))
    d = ImageDraw.Draw(img)
    ft, fs = _pick_pil_fonts(30, 18)

    def _center(text, font, y, fill):
        b = d.textbbox((0, 0), text, font=font)
        tw = b[2] - b[0]
        d.text(((W - tw) / 2, y), text, fill=fill, font=font)

    _center(title, ft, 140, (255, 160, 80))
    if subtitle:
        _center(subtitle, fs, 198, (200, 200, 200))
    bgr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode(".jpg", bgr)
    return buf.tobytes() if ok else b""


def _end_frame_jpeg(lines):
    """播放正常结束帧：中性完成色，lines 为 [(text, size, color), ...]。"""
    import cv2
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
    W, H = 640, 360
    img = Image.new("RGB", (W, H), (28, 32, 38))
    d = ImageDraw.Draw(img)
    ft, fs = _pick_pil_fonts(34, 18)
    y = 90
    for text, size, color in lines:
        font = ft if size == "big" else fs
        b = d.textbbox((0, 0), text, font=font)
        tw = b[2] - b[0]
        d.text(((W - tw) / 2, y), text, fill=color, font=font)
        y += 56 if size == "big" else 34
    bgr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode(".jpg", bgr)
    return buf.tobytes() if ok else b""


# 网络流并发控制 + 注册表 + 看门狗
# _STREAM_SLOTS: 当前占用的名额令牌集合（用集合而非计数，释放天然幂等，防重复 release）
# _STREAM_REGISTRY: sid -> {"thread": 线程, "token": 名额令牌, "start": 启动时间}
#   这是 H3 短方案要求的「sid→线程 注册表」，配合看门狗在流异常退出/卡死时强制回收名额，
#   避免 4 路槽位被泄漏的连接永久占满（否则后续连接会被误判为超限 429）。
_STREAM_SLOTS = set()
_STREAM_SLOTS_LOCK = threading.Lock()
_STREAM_REGISTRY = {}
_STREAM_REGISTRY_LOCK = threading.Lock()


def _acquire_stream_slot():
    """占用一个网络流名额，已满返回 None。申请前先回收已泄漏的名额。"""
    with _STREAM_SLOTS_LOCK, _STREAM_REGISTRY_LOCK:
        _reap_locked()
        if len(_STREAM_SLOTS) >= MAX_CONCURRENT_STREAMS:
            return None
        token = uuid.uuid4().hex
        _STREAM_SLOTS.add(token)
        return token


def _release_stream_slot(token):
    """归还一个网络流名额（幂等）。"""
    if not token:
        return
    with _STREAM_SLOTS_LOCK:
        _STREAM_SLOTS.discard(token)


def _register_stream(sid, token):
    """把 sid 与其所属线程/名额登记进注册表（看门狗据此回收）。"""
    if not sid:
        return
    with _STREAM_REGISTRY_LOCK:
        _STREAM_REGISTRY[sid] = {"thread": threading.current_thread(),
                                 "token": token, "start": time.time()}


def _unregister_stream(sid):
    if not sid:
        return
    with _STREAM_REGISTRY_LOCK:
        _STREAM_REGISTRY.pop(sid, None)
        STREAM_CONF.pop(sid, None)   # 顺手清理运行时置信度缓存


def _reap_dead_streams():
    """看门狗对外入口：回收已退出或卡死流所占的名额。"""
    with _STREAM_SLOTS_LOCK, _STREAM_REGISTRY_LOCK:
        _reap_locked()


def _reap_locked():
    """看门狗核心：必须在持有 _STREAM_SLOTS_LOCK 与 _STREAM_REGISTRY_LOCK 时调用。"""
    now = time.time()
    for sid in list(_STREAM_REGISTRY.keys()):
        rec = _STREAM_REGISTRY[sid]
        th = rec["thread"]
        token = rec["token"]
        st = STREAM_STATS.get(sid)
        ts = st.get("ts") if st else None
        dead = not th.is_alive()
        silent = (now - ts) if ts is not None else 0
        if dead or (ts is not None and silent > STREAM_REAP_SILENT_SEC):
            # 强制回收：名额令牌 + 注册表 + 统计
            _STREAM_SLOTS.discard(token)
            _STREAM_REGISTRY.pop(sid, None)
            STREAM_STATS.pop(sid, None)
            STREAM_CONF.pop(sid, None)
            if dead:
                logger.warning("[stream] 看门狗回收已退出的流名额 sid=%s", sid)
            else:
                logger.warning("[stream] 看门狗回收卡死/静默超时的流名额 sid=%s (静默 %.0fs)",
                               sid, silent)


# ---------- 批量读元信息的保护（三道闸） ----------
# 1) _META_LOCK：同一时刻只允许一个批量刷新，防止多个管理员同时点刷新导致叠加加载。
# 2) 显存预检 MIN_FREE_VRAM_MB：加载下一个模型前查剩余显存，不足则跳过该模型。
# 3) 读完即卸：非当前模型、且刷新前不在缓存的模型，读完元信息立刻卸载，避免显存堆积。
_META_LOCK = threading.Lock()


def _free_vram_mb():
    """返回 GPU 剩余显存(MB)；非 CUDA 或读取失败返回 None（视为不限制）。"""
    try:
        import torch
        if not torch.cuda.is_available():
            return None
        free, _total = torch.cuda.mem_get_info()   # 单位 byte
        return int(free / 1024 / 1024)
    except Exception as e:
        logger.debug("[meta] 读取显存信息失败（不限制）: %s", e)
        return None


def _has_active_inference():
    """是否有活跃推理。

    两条判据取或：① 有网络流占用名额；② 最近 INFER_ACTIVE_WINDOW_SEC 秒内发生过推理。
    判据②由 detector 服务层在 detect_image / detect_video 里打时间戳，
    因此**图片、视频、网络流全部检测类型都能覆盖**（此前只看流槽位，漏了图片/视频）。
    """
    with _STREAM_SLOTS_LOCK:
        if _STREAM_SLOTS:
            return True
    return (time.time() - detector.last_infer_ts()) <= INFER_ACTIVE_WINDOW_SEC


def _vram_ok():
    """显存是否够加载下一个模型，返回 (ok, 剩余MB 或 None)。"""
    free = _free_vram_mb()
    if free is None or free >= MIN_FREE_VRAM_MB:
        return True, free
    return False, free


def _release_vram_cache():
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception as e:
        logger.debug("[meta] 释放显存缓存失败（可忽略）: %s", e)


_VIDEO_FILE_EXT = (".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".m4v", ".3gp",
                   ".mpg", ".mpeg", ".ts", ".m2ts", ".webm", ".mjpeg", ".mjpg")


def _classify_source(url):
    """判定画面源类型，统一给两处入口（检测页 / 工控页）做直连前校验。

    返回: 'net' 网络流直连 / 'file' 本地视频文件 / 'img' 图片文件 / '' 不支持。
    只认「可直连」的东西：网络协议流，或本机真实存在的视频文件；其余一律拒绝。
    """
    raw = (url or "").strip()
    low = raw.lower()
    if low.startswith(("rtsp://", "rtmp://", "http://", "https://")):
        return "net"
    path = raw
    if low.startswith("file://"):
        path = raw[7:]
    if os.path.isfile(path):
        return "file" if path.lower().endswith(_VIDEO_FILE_EXT) else "img"
    return ""


def _source_fps(cap):
    """取源帧率，取不到或不合理（0/NaN/超大）返回 0.0（= 不限速，交给源自身的到达节奏）。

    注意：cv2 在本文件里都是**函数内局部 import**（模块级没有 cv2 这个名字），
    所以这里必须自己 import，否则会抛 NameError 被 except 吞掉、永远返回 0（限速形同虚设）。
    """
    import cv2
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    except Exception as e:
        logger.debug("[pacer] 读取源帧率失败（按不限速处理）: %s(%s)", type(e).__name__, e)
        return 0.0
    if not (1.0 <= fps <= 120):
        return 0.0
    return fps


class _FramePacer:
    """按源帧率限速，保证本地视频按 1 倍速播放。

    网络流本身由"帧到达"节奏限速，即便限速也是无操作（解码慢于源帧率时同样不追赶）。
    """

    def __init__(self, fps):
        self.interval = 1.0 / fps if fps else 0.0
        self.next_t = time.time()

    def reset(self, fps):
        self.interval = 1.0 / fps if fps else 0.0
        self.next_t = time.time()

    def wait(self):
        if not self.interval:
            return
        delay = self.next_t - time.time()
        if delay > 0:
            time.sleep(delay)
        self.next_t += self.interval
        if self.next_t < time.time():
            # 处理速度跟不上源帧率：不追赶，直接把基准挪到现在，避免越睡越偏
            self.next_t = time.time() + self.interval


def _open_network_capture(url):
    """仅支持视频直连：网络流（RTSP/RTMP/HLS/可直连的 http(s)）或本地视频文件路径。

    不做下载、不做兜底、不支持图片：连不上（isOpened 为 False）直接返回 None，
    由调用方提示「无法连接视频流」，让用户自行换可直连的流地址。
    本地视频文件走同一条路径——OpenCV 对文件路径同样直连解码，无需落盘任何临时文件。"""
    import cv2
    cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)
    if not cap.isOpened():
        try:
            cap.release()
        except Exception:
            pass
        return None
    return cap


@app.get("/api/detect/stream")
@login_required
def detect_stream():
    _gl = _train_locked_response()
    if _gl[0]:
        return _gl
    import cv2
    stream_url = (request.args.get("url") or "").strip()
    if not stream_url:
        return jsonify({"ok": False, "msg": "缺少流地址"}), 400
    conf = float(request.args.get("conf", DEFAULT_CONF))
    sid = (request.args.get("sid") or "").strip()

    # 并发路数上限：避免多路流同时推理吃满线程与显存
    slot_token = _acquire_stream_slot()
    if not slot_token:
        logger.warning("[stream] 并发流已达上限 %s，拒绝新连接", MAX_CONCURRENT_STREAMS)
        return jsonify({"ok": False, "msg": f"当前检测流已达上限（{MAX_CONCURRENT_STREAMS} 路），请先断开一路"}), 429

    def gen():
        nonlocal conf   # 内部循环会实时改写 conf，声明为外层变量，避免 UnboundLocalError
        boundary = b"--frame\r\n"
        cap = None
        keep_stats = False  # 统计需保留供前端轮询
        _register_stream(sid, slot_token)
        if sid:
            STREAM_CONF[sid] = conf   # 记录初始置信度，供运行时实时修改
        try:
            # 仅视频直连：网络流或本地视频文件；不支持图片、不做兜底下载
            if not _classify_source(stream_url):
                err = _error_frame_jpeg("不支持的画面源",
                                        "仅支持 rtsp://、rtmp://、http(s):// 视频流，或本地视频文件的完整路径")
                yield (boundary + b"Content-Type: image/jpeg\r\n\r\n" + err + b"\r\n")
                if sid:
                    STREAM_STATS[sid] = {"error": "不支持的画面源", "ts": time.time()}
                keep_stats = True
                return
            cap = _open_network_capture(stream_url)
            if cap is None:
                err = _error_frame_jpeg("无法连接视频流，请检查地址", "请确认流地址、摄像头账号密码及网络是否正常")
                yield (boundary + b"Content-Type: image/jpeg\r\n\r\n" + err + b"\r\n")
                if sid:
                    STREAM_STATS[sid] = {"error": "无法连接视频流，请检查地址", "ts": time.time()}
                keep_stats = True
                return
            fail = 0
            frame_idx = 0
            infer_cnt = 0
            t0_play = None      # 墙钟锚点：首帧读到的时刻（本地文件追帧按它算“该播到哪一帧”）
            last_iter_t = None  # 上一轮时刻（直播流增量排空用，不依赖累计墙钟）
            is_live = _classify_source(stream_url) == 'net'
            last_frame = None
            last_stats = {}
            cum_stats = {}
            cum_conf = {}   # 每类置信度累加和（用于播放完成后图表的平均置信度）
            src_fps = _source_fps(cap)
            pacer = _FramePacer(src_fps)   # 按源帧率限速：本地视频保持 1 倍速
            while True:
                pacer.wait()
                # 运行时实时读取最新置信度（前端失焦改值后即时生效，无需重连）
                if sid:
                    conf = STREAM_CONF.get(sid, conf)
                ret, frame = cap.read()
                if not ret or frame is None:
                    # 检测页**不循环**：放一遍就结束，出"播放结束"汇总帧并落累计统计
                    # （累计检测数是这一路的最终结论，循环会让它一直累加、永远出不来汇总）
                    fail += 1
                    if fail >= 10:
                        if frame_idx == 0:
                            # 一帧都没读到：真·连接失败
                            err = _error_frame_jpeg("无法连接视频流，请检查地址", "请确认流地址、摄像头账号密码及网络是否正常")
                            yield (boundary + b"Content-Type: image/jpeg\r\n\r\n" + err + b"\r\n")
                            if sid:
                                STREAM_STATS[sid] = {"error": "无法连接视频流，请检查地址", "ts": time.time()}
                        else:
                            # 已正常出帧后读完：播放结束
                            total = sum(cum_stats.values())
                            lines = [
                                ("播放结束", "big", (90, 200, 160)),
                                ("视频已播放完毕，可点击“断开连接”后重新连接", "small", (180, 180, 180)),
                                ("共播放 %d 帧 · 推理 %d 帧" % (frame_idx, infer_cnt), "small", (200, 200, 200)),
                            ]
                            end_img = _end_frame_jpeg(lines)
                            yield (boundary + b"Content-Type: image/jpeg\r\n\r\n" + end_img + b"\r\n")
                            if sid:
                                STREAM_STATS[sid] = {"ended": True, "total": total,
                                                     "stats": cum_stats, "conf_sum": cum_conf,
                                                     "frames": frame_idx, "infer": infer_cnt,
                                                     "dur_ms": int((time.time() - t0_play) * 1000) if t0_play else 0,
                                                     "ts": time.time()}
                        keep_stats = True
                        break
                    time.sleep(0.1)
                    continue
                fail = 0
                frame_idx += 1
                if t0_play is None:
                    t0_play = time.time()
                    last_iter_t = t0_play
                try:
                    # 限制推理宽度，降低单帧耗时、提高实时覆盖率（坐标随后还原到原始帧空间）。
                    # 640 是该模型更常见的训练尺度，且单帧推理更快——画面仍是原始全分辨率帧，
                    # 仅模型吃进去的尺寸变小，清晰度与框位置不受影响（_inv 还原坐标）。
                    h0, w0 = frame.shape[:2]
                    infer = frame
                    _inv = 1.0
                    if w0 > 640:
                        scale = 640.0 / w0
                        infer = cv2.resize(frame, (640, int(h0 * scale)))
                        _inv = w0 / 640.0
                    # plot=False：不回后端标注图，原始帧直接出 MJPEG，框交由前端 canvas 绘制
                    _, boxes, stats, elapsed = detector.detect_image(infer, conf=conf, plot=False)
                    if _inv != 1.0:
                        for b in boxes:
                            b["x1"] *= _inv; b["y1"] *= _inv
                            b["x2"] *= _inv; b["y2"] *= _inv
                    last_stats = stats
                    infer_cnt += 1
                    for _k, _v in stats.items():
                        cum_stats[_k] = cum_stats.get(_k, 0) + _v
                    for _b in boxes:
                        cum_conf[_b["cls_name"]] = cum_conf.get(_b["cls_name"], 0.0) + float(_b["conf"])
                    if sid:
                        STREAM_STATS[sid] = {"stats": stats, "total": sum(stats.values()),
                                             "duration_ms": elapsed, "boxes": boxes,
                                             "frame_w": w0, "frame_h": h0, "ts": time.time()}
                    last_frame = frame
                except Exception as e:
                    logger.warning("[stream] 推理失败，回退原帧: %s", e)
                    last_frame = frame
                # q85：与工控页中继一致，输出保持码流原始分辨率并提高画质（画面高清优先）
                ok, buf = cv2.imencode(".jpg", last_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
                if ok:
                    yield (boundary + b"Content-Type: image/jpeg\r\n\r\n" + buf.tobytes() + b"\r\n")
                # 追帧保持实时：读帧+推理+编码总耗时长于源帧间隔时（如 60fps 源配 35ms 处理），
                # 不处理会把播放拖成 0.5 倍速慢放。两类源分开处理：
                # · 本地文件：帧全在磁盘上，grab() 是瞬时解码跳帧——按“从首帧起累计的墙钟”直接对齐播放位置；
                # · 直播/网络流：帧是实时到达的，**不能用累计墙钟**（元数据帧率≠实际到达率时 grab 会阻塞等待，
                #   等待期间墙钟继续涨→下一轮要跳更多→永远在追=快进失控）。
                #   改用「本轮处理耗时内到达的帧数」做增量排空：只丢已缓冲到达的帧，到达不足时 grab
                #   自然阻塞在实时边缘、自动对齐真实帧率——不快进也不慢放，始终贴近实时。
                # 推理随之变为抽帧进行（跟不上自动丢帧），框/统计仍来自最近一次真实推理。
                # 25/30fps 等低帧率源本来就跟得上（skip≤0），行为与从前完全一致。
                if src_fps and t0_play is not None:
                    if is_live:
                        arrived = int((time.time() - last_iter_t) * src_fps)
                        drop = arrived - 1
                        if drop > 0:
                            for _ in range(min(drop, 60)):
                                if not cap.grab():
                                    break
                                frame_idx += 1
                    else:
                        expected = 1 + int((time.time() - t0_play) * src_fps)
                        skip = expected - frame_idx
                        if skip > 0:
                            # 上限 1 秒的量，防止长时间卡顿后一次性狂跳
                            for _ in range(min(skip, int(src_fps) + 2)):
                                if not cap.grab():
                                    break
                                frame_idx += 1
                    last_iter_t = time.time()
        except GeneratorExit:
            pass
        finally:
            if cap is not None:
                cap.release()
            _release_stream_slot(slot_token)
            _unregister_stream(sid)
            if sid and not keep_stats:
                STREAM_STATS.pop(sid, None)

    resp = Response(stream_with_context(gen()),
                    mimetype="multipart/x-mixed-replace; boundary=frame")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/api/detect/stream/stop")
@login_required
def detect_stream_stop():
    sid = (request.args.get("sid") or "").strip()
    if sid:
        STREAM_STATS.pop(sid, None)
        STREAM_CONF.pop(sid, None)
    # 顺手触发看门狗，回收可能已泄漏的名额（如客户端非正常断开绕过 finally 的极端场景）
    _reap_dead_streams()
    return jsonify({"ok": True})


@app.post("/api/detect/stream/conf")
@login_required
def detect_stream_conf():
    """运行时更新某路网络流的置信度阈值（实时生效，无需重连）。

    前端在流已连接时失焦修改「置信度」输入框后调用；gen() 每帧读取最新值。
    """
    sid = (request.args.get("sid") or request.form.get("sid") or "").strip()
    if not sid:
        return jsonify({"ok": False, "msg": "缺少 sid"}), 400
    raw = request.args.get("conf")
    if raw is None:
        raw = request.form.get("conf")
    try:
        conf = float(raw)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "msg": "置信度需为数字"}), 400
    if conf < 0.05 or conf > 0.95:
        return jsonify({"ok": False, "msg": "置信度需在 0.05~0.95 之间"}), 400
    STREAM_CONF[sid] = conf
    return jsonify({"ok": True})


@app.get("/api/detect/stream/stats")
@login_required
def detect_stream_stats():
    sid = (request.args.get("sid") or "").strip()
    now = time.time()
    for k in list(STREAM_STATS.keys()):
        if now - STREAM_STATS[k].get("ts", now) > 300:
            STREAM_STATS.pop(k, None)
    data = STREAM_STATS.get(sid)
    if not data:
        return jsonify({"ok": True, "active": False})
    if data.get("error"):
        return jsonify({"ok": True, "active": False, "error": data["error"]})
    if data.get("ended"):
        return jsonify({"ok": True, "active": False, "ended": True,
                        "stats": data.get("stats", {}), "total": data.get("total", 0),
                        "conf_sum": data.get("conf_sum", {}),   # 每类置信度累加和：前端算平均置信度折线
                        "frames": data.get("frames", 0), "infer": data.get("infer", 0),
                        "dur_ms": data.get("dur_ms", 0)})
    return jsonify({"ok": True, "active": True,
                    "stats": data["stats"], "total": data["total"],
                    "duration_ms": data["duration_ms"]})


@app.get("/api/detect/stream/boxes")
@login_required
def detect_stream_boxes():
    """返回某路流最近一帧的检测框与帧尺寸，供前端 canvas 绘制（与底层原始 MJPEG 对齐）。"""
    sid = (request.args.get("sid") or "").strip()
    data = STREAM_STATS.get(sid)
    if not data:
        return jsonify({"ok": False, "boxes": [], "frame_w": 0, "frame_h": 0, "live": False})
    return jsonify({
        "ok": True,
        "boxes": data.get("boxes", []),
        "frame_w": data.get("frame_w", 0),
        "frame_h": data.get("frame_h", 0),
        "live": ("ended" not in data) and ("error" not in data),
    })


# ==================== 工控页网络画面源中继（纯 MJPEG 转码，不带推理） ====================
# 与上面的 /api/detect/stream（服务端推理）不同：工控页的触发判定/分拣/ROI 全在前端，
# 走的是「前端抓帧 -> /api/detect/frame」链路。而浏览器放不了 RTSP，
# 所以这里只负责把 rtsp/rtmp/http 流解码成 MJPEG 吐给 <img>，前端再从画面抓帧送推理，
# 整条触发链路零改动。
_IND_STREAM_LOCK = threading.Lock()
_IND_STREAM = {
    "running": False, "url": "", "thread": None, "gen_id": 0,
    "frame": b"", "seq": 0, "error": "",
    "clients": 0, "last_client": 0.0, "got_frame": False, "fps": 0,
}
# 中继输出最大宽度（超过则等比缩小）。**0 = 不缩放**：按"预览画面永远最高清"的要求，
# 摄像头码流多高清就原样转发（代价是带宽/CPU 随分辨率上升；要省再改回 1280/960）。
_IND_STREAM_MAX_W = 0
_IND_STREAM_IDLE_STOP = 120       # 无观看者超过该秒数自动停止（防僵尸流占资源）
_IND_STREAM_GIVEUP_SEC = 45       # 一直连不上超过该秒数放弃（等下次 open 重新拉起）


def _ind_stream_relay(url):
    """中继线程：解码画面源 -> 最新一帧 JPEG 写入共享缓存。断流自动重连。

    网络流：连不上重试，出过帧后断流自动重连。
    本地视频文件：打不开立即报错（重试无意义），播放到结尾自动从头循环（不报"流中断"）。
    """
    import cv2
    src_kind = _classify_source(url)
    with _IND_STREAM_LOCK:
        _IND_STREAM["gen_id"] += 1
        my_gen = _IND_STREAM["gen_id"]
    cap = None
    fail = 0
    started = time.time()
    pacer = _FramePacer(0)
    with _IND_STREAM_LOCK:
        _IND_STREAM["fps"] = 0
    try:
        # 仅视频流直连：不支持图片、不做兜底下载；连不上由下方循环提示「无法连接」
        while True:
            with _IND_STREAM_LOCK:
                alive = _IND_STREAM["running"] and _IND_STREAM["gen_id"] == my_gen
                idle = time.time() - _IND_STREAM["last_client"] if _IND_STREAM["clients"] <= 0 else 0
            if not alive:
                break
            if idle > _IND_STREAM_IDLE_STOP:
                logger.info("[ind-stream] %.0f 秒无观看者，自动停止中继: %s", idle, url)
                with _IND_STREAM_LOCK:
                    _IND_STREAM["running"] = False
                break
            if cap is None or not cap.isOpened():
                cap = _open_network_capture(url)
                if cap is None:
                    if src_kind == "file":
                        # 本地文件打不开就是路径错/格式不支持，重试没有意义，直接收工
                        _IND_STREAM["error"] = "无法打开视频文件，请检查路径是否正确"
                        logger.warning("[ind-stream] 无法打开本地视频文件: %s", url)
                        with _IND_STREAM_LOCK:
                            _IND_STREAM["running"] = False
                        break
                    _IND_STREAM["error"] = "无法连接视频流，请检查地址/账号密码/网络"
                    if not _IND_STREAM["got_frame"] and time.time() - started > _IND_STREAM_GIVEUP_SEC:
                        logger.warning("[ind-stream] 一直连不上，放弃本次中继: %s", url)
                        with _IND_STREAM_LOCK:
                            _IND_STREAM["running"] = False
                        break
                    time.sleep(2)
                    continue
                _IND_STREAM["error"] = ""
                pacer.reset(_source_fps(cap))
                with _IND_STREAM_LOCK:
                    _IND_STREAM["fps"] = _source_fps(cap)   # 供 mjpeg 端按源帧率采样
            pacer.wait()          # 按源帧率限速：本地视频保持 1 倍速，网络流基本无操作
            ret, frame = cap.read()
            if not ret or frame is None:
                fail += 1
                if src_kind == "file":
                    # 本地文件读到结尾：重开即循环播放，不当成"断流"
                    cap.release()
                    cap = None
                    fail = 0
                    continue
                if fail >= 10:
                    # 已出过帧后断流：重连；重来太多次且从没出过帧：按连接失败处理
                    cap.release()
                    cap = None
                    fail = 0
                    if _IND_STREAM["got_frame"]:
                        _IND_STREAM["error"] = "流中断，正在自动重连…"
                    time.sleep(1)
                else:
                    time.sleep(0.05)
                continue
            fail = 0
            _IND_STREAM["got_frame"] = True
            h0, w0 = frame.shape[:2]
            if _IND_STREAM_MAX_W and w0 > _IND_STREAM_MAX_W:
                s = _IND_STREAM_MAX_W / float(w0)
                frame = cv2.resize(frame, (_IND_STREAM_MAX_W, int(h0 * s)))
            # q85：既然要"最高清预览"，MJPEG 就不再压太狠（带宽换清晰度）
            ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            if ok:
                _IND_STREAM["frame"] = buf.tobytes()
                _IND_STREAM["seq"] += 1
    except Exception as e:
        logger.warning("[ind-stream] 中继线程异常退出: %s(%s)", type(e).__name__, e)
        _IND_STREAM["error"] = "中继线程异常: %s" % e
    finally:
        if cap is not None:
            cap.release()
        with _IND_STREAM_LOCK:
            if _IND_STREAM["gen_id"] == my_gen:
                _IND_STREAM["thread"] = None


def _ind_stream_start(url):
    """启动（或替换）中继线程。同一 URL 重复 open 幂等。"""
    with _IND_STREAM_LOCK:
        if _IND_STREAM["running"] and _IND_STREAM["url"] == url and _IND_STREAM["thread"] \
                and _IND_STREAM["thread"].is_alive():
            return
        # 先让旧线程退出（每轮循环都会检查 running/gen_id，最多等一个 read 周期）
        _IND_STREAM["running"] = False
        old = _IND_STREAM["thread"]
    if old and old.is_alive():
        old.join(timeout=3)
    with _IND_STREAM_LOCK:
        _IND_STREAM.update({
            "running": True, "url": url, "frame": b"", "error": "",
            "got_frame": False, "seq": _IND_STREAM["seq"] + 1, "fps": 0,
            "last_client": time.time(),   # 必须初始化，否则首轮就按"无观看者超时"退出
        })
        th = threading.Thread(target=_ind_stream_relay, args=(url,),
                              daemon=True, name="ind-stream-relay")
        _IND_STREAM["thread"] = th
    th.start()
    logger.info("[ind-stream] 中继已启动: %s", url)


@app.post("/api/ind/stream/open")
@login_required
def ind_stream_open():
    """打开工控页画面源。body: {"url":"rtsp://..."} 或本地视频文件完整路径"""
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"ok": False, "msg": "请填写流地址或本地视频文件路径"}), 400
    kind = _classify_source(url)
    if kind == "img":
        return jsonify({"ok": False, "msg": "不支持图片，仅支持视频文件（mp4/avi/mov/mkv 等）"}), 400
    if not kind:
        return jsonify({"ok": False, "msg": "仅支持 rtsp://、rtmp://、http(s):// 视频流地址，或本地视频文件的完整路径"}), 400
    _ind_stream_start(url)
    return jsonify({"ok": True})


@app.post("/api/ind/stream/close")
@login_required
def ind_stream_close():
    with _IND_STREAM_LOCK:
        _IND_STREAM["running"] = False
        old = _IND_STREAM["thread"]
        _IND_STREAM["url"] = ""
    if old and old.is_alive():
        old.join(timeout=3)
    with _IND_STREAM_LOCK:
        _IND_STREAM["frame"] = b""
        _IND_STREAM["error"] = ""
        _IND_STREAM["got_frame"] = False
        _IND_STREAM["fps"] = 0
    logger.info("[ind-stream] 中继已停止")
    return jsonify({"ok": True})


@app.get("/api/ind/stream/status")
@login_required
def ind_stream_status():
    with _IND_STREAM_LOCK:
        return jsonify({
            "ok": True,
            "running": _IND_STREAM["running"],
            "url": _IND_STREAM["url"],
            "error": _IND_STREAM["error"],
            "has_frame": _IND_STREAM["got_frame"],
            "clients": _IND_STREAM["clients"],
        })


def _mjpeg_poll_interval(fps):
    """mjpeg 轮询间隔：默认 ~25fps 采样；源帧率更高时按 2 倍采样率跟进（不漏帧）。"""
    if not fps or fps <= 25:
        return 0.04
    return max(0.008, 0.5 / fps)


@app.get("/api/ind/stream/mjpeg")
@login_required
def ind_stream_mjpeg():
    """MJPEG 输出：把中继缓存的最新帧推给前端 <img>。"""
    with _IND_STREAM_LOCK:
        if not _IND_STREAM["running"] or not _IND_STREAM["url"]:
            return jsonify({"ok": False, "msg": "网络流未开启"}), 409
        _IND_STREAM["clients"] += 1
        _IND_STREAM["last_client"] = time.time()
        my_seq = _IND_STREAM["seq"]

    def gen():
        boundary = b"--indframe\r\n"
        my_seq = _IND_STREAM["seq"]     # gen 内有赋值 → my_seq 是局部变量，必须在此初始化
        try:
            idle_since = time.time()
            while True:
                with _IND_STREAM_LOCK:
                    running = _IND_STREAM["running"]
                    seq = _IND_STREAM["seq"]
                    data = _IND_STREAM["frame"]
                    fps = _IND_STREAM["fps"]
                    fresh = (seq != my_seq)
                    if fresh:
                        my_seq = seq
                        idle_since = time.time()
                if not running:
                    break
                if not fresh:
                    if time.time() - idle_since > 15:
                        break   # 15 秒无新帧（流已断/中继退出）→ 结束本次输出
                    time.sleep(_mjpeg_poll_interval(fps))
                    continue
                # 只在新帧时推：重复推同一帧会让画面按轮询速率播放（低帧率视频被"加速"）
                if data:
                    yield (boundary + b"Content-Type: image/jpeg\r\n\r\n" + data + b"\r\n")
                time.sleep(_mjpeg_poll_interval(fps))
        finally:
            with _IND_STREAM_LOCK:
                _IND_STREAM["clients"] = max(0, _IND_STREAM["clients"] - 1)
                _IND_STREAM["last_client"] = time.time()

    resp = Response(stream_with_context(gen()),
                    mimetype="multipart/x-mixed-replace; boundary=indframe")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


# ==================== 视频检测 ====================
# ==================== 客户端中断探测（图片/视频、单张/批量统一） ====================
# 背景：用户在进度条走的时候刷新/关页面/点取消，HTTP 连接就断了。视频（流式）能靠生成器
# 被关闭感知到；但图片单张/批量、同步视频都是「同步请求」，推理跑到一半没人告诉它该停，
# 于是白烧完剩下的 CPU/GPU，还把已上传的文件留在磁盘上变成孤儿。
# 这里补一个通用探测：同步接口在「上传后、推理前」「推理后、落库前」各探一次，
# 视频（含同步接口）还能把它接进 progress_cb，做到逐帧中止。
def _client_gone():
    """尽力探测当前请求的客户端是否已断开（刷新/关闭页面/点了取消）。

    werkzeug 会把底层 TCP socket 放进 environ['werkzeug.socket']；用非阻塞 MSG_PEEK 窥一个字节：
      - 收到 b''               → 对端已发 FIN（断开）
      - BlockingIOError        → 无数据可读，连接还在
      - 收到非空数据            → 连接还在（peek 不消费，不影响后续请求解析）
    拿不到 socket（将来换 waitress/gunicorn 等）时保守返回 False —— 宁可漏判，绝不误判成断开。
    """
    sock = None
    try:
        sock = request.environ.get("werkzeug.socket")
        if sock is None:
            return False
        old = sock.gettimeout()
        sock.setblocking(False)
        try:
            data = sock.recv(1, socket.MSG_PEEK)
        except (BlockingIOError, InterruptedError):
            return False          # 没数据可读 = 连接还开着
        except OSError:
            return True           # 连接重置/已关闭
        return data == b""        # b'' = 对端已关闭
    except Exception:
        return False
    finally:
        # 必须还原超时设置：werkzeug 随后还要在同一个 socket 上写响应
        if sock is not None:
            try:
                sock.settimeout(old)
            except Exception:
                pass


def _discard_uploaded(paths, tag=""):
    """中断时丢弃本次已写入、但尚未落库的中间文件（延迟删，避开启用的文件句柄）。"""
    alive = [p for p in (paths or []) if p]
    if not alive:
        return
    for p in alive:
        _safe_remove_later(p, 2)
    logger.info("[detect] 客户端已断开，丢弃未落库的中间文件（%s）: %s",
                tag or "detect", ", ".join(os.path.basename(p) for p in alive))


def _save_and_precheck_video(f, ext):
    """保存上传的视频并做资源预检，返回 (uid, in_path, out_path, None) 或 (None,...错误)。

    同步接口与流式接口共用，保证两处校验规则一致。
    """
    import cv2 as _cv2
    uid = uuid.uuid4().hex[:12]
    in_path = os.path.join(UPLOAD_VIDEOS, f"{uid}{ext}")
    # 不再预生成标注 mp4（out_path=None）：落盘只保留原视频 + 框时间轴，
    # 带框视频改由用户点下载时现场合成，避免几十倍体积的磁盘占用
    out_path = None
    f.save(in_path)

    # 处理前的资源保护：视频过长会独占请求线程，磁盘不足会导致写一半失败
    cap = _cv2.VideoCapture(in_path)
    if not cap.isOpened():
        os.remove(in_path)
        return None, None, None, "无法解析该视频文件"
    fps = cap.get(_cv2.CAP_PROP_FPS) or 25
    frames = int(cap.get(_cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()
    duration = (frames / fps) if (frames and fps) else 0
    if frames > MAX_VIDEO_FRAMES or duration > MAX_VIDEO_SECONDS:
        os.remove(in_path)
        logger.info("[detect] 视频超限被拒：%s 帧 / %.1f 秒", frames, duration)
        return None, None, None, (
            f"视频过长（{frames} 帧 / {duration:.0f} 秒），上限为 "
            f"{MAX_VIDEO_SECONDS} 秒或 {MAX_VIDEO_FRAMES} 帧，请裁剪后再传"
        )
    free_mb = shutil.disk_usage(UPLOAD_DIR).free / 1024 / 1024
    if free_mb < MIN_FREE_DISK_MB:
        os.remove(in_path)
        return None, None, None, f"磁盘剩余空间不足（{free_mb:.0f} MB），请先清理"
    return uid, in_path, out_path, None


def _finalize_video_result(uid, filename, total, inferred, stats, elapsed,
                           first_frame, rep_boxes, model_file,
                           timeline=None, names_map=None, vw=0, vh=0, vfps=0):
    """推理结束后落库，返回结果 dict（同步与流式接口共用）。

    落盘策略（2026-10-22 改）：**只存原视频 + 逐帧框时间轴 JSON**，不再写标注 mp4、
    不再存封面帧。所有画面上的框都由前端用时间轴现场绘制；用户要带框的视频时，
    走下载接口现场合成（见 /api/record/<id>/download），不再预先占着几十倍体积的磁盘。
    """
    # 原始上传视频路径：必须入库，删除记录时才能连带清理，避免 uploads/videos 残留
    ext = os.path.splitext(filename)[1].lower()
    source_url = f"/uploads/videos/{uid}{ext}"

    # 逐帧框时间轴：供前端在原始视频上精确画框（原始坐标 + 类别名映射）
    boxes_url = None
    if timeline is not None:
        try:
            tl = {
                "fps": round(float(vfps or 0), 3),
                "width": int(vw or 0),
                "height": int(vh or 0),
                "names": {str(k): v for k, v in (names_map or {}).items()},
                "frames": timeline,
            }
            tl_name = f"{uid}_boxes.json"
            with open(os.path.join(UPLOAD_BOXES, tl_name), "w", encoding="utf-8") as tf:
                json.dump(tl, tf, ensure_ascii=False, separators=(",", ":"))
            boxes_url = f"/uploads/boxes/{tl_name}"
        except Exception as e:
            logger.warning("[detect] 视频框时间轴写入失败（不影响主流程）: %s", e)

    total_n = sum(stats.values())
    conclusion = f"共 {total} 帧，标注 {total_n} 个目标"

    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO detection_records "
                "(user_id, username, image_name, image_url, result_url, source_url, boxes_url, media_type, "
                " conclusion, stats_json, boxes_json, model_name, duration_ms) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,'video',%s,%s,%s,%s,%s)",
                (session["user_id"], session["username"], filename,
                 source_url,                    # image_url：视频记录不再有封面帧，指向原视频
                 source_url,                    # result_url：同上（展示一律用原视频 + 前端框）
                 source_url, boxes_url or "",
                 conclusion, json.dumps(stats, ensure_ascii=False),
                 json.dumps(rep_boxes, ensure_ascii=False),
                 model_file or detector.get_current(), elapsed),
            )
            record_id = cur.lastrowid
        conn.commit()
    finally:
        conn.close()

    return {
        "ok": True,
        "record_id": record_id,
        "image_url": source_url,      # 视频记录不再生成封面帧
        "result_url": source_url,     # 不再生成标注 mp4：展示用原视频 + 时间轴前端画框
        "source_url": source_url,
        "boxes_url": boxes_url,
        "boxes": rep_boxes,
        "stats": stats,
        "conclusion": conclusion,
        "total_frames": total,
        "inferred_frames": inferred,
        "duration_ms": elapsed,
    }


def _read_video_form():
    """解析视频检测的公共表单参数。"""
    conf = float(request.form.get("conf", DEFAULT_CONF))
    # skip：每隔几帧推理一次，默认 2；1 表示逐帧，值越大越快
    try:
        skip = int(request.form.get("skip", 2))
    except (TypeError, ValueError):
        skip = 2
    skip = max(1, min(skip, 10))
    # 模型由管理员全局统一控制：视频检测不再支持按请求指定模型，一律用全局当前模型
    return conf, skip


@app.post("/api/detect/video")
@login_required
def detect_video():
    _gl = _train_locked_response()
    if _gl[0]:
        return _gl
    if "file" not in request.files:
        return jsonify({"ok": False, "msg": "请上传视频"}), 400
    f = request.files["file"]
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ALLOWED_VIDEO_EXT:
        return jsonify({"ok": False, "msg": "不支持的视频格式"}), 400

    uid, in_path, out_path, err = _save_and_precheck_video(f, ext)
    if err:
        return jsonify({"ok": False, "msg": err}), 400

    conf, skip = _read_video_form()
    # 统一用全局当前模型（管理员在模型管理页切换，全员生效）
    used_model = detector.get_current()

    # 中断约定（与流式接口一致）：客户端刷新/关闭 → 逐帧感知到就停手，并清掉已上传的原视频
    holder = {"aborted": False}

    def on_progress(done, total_est):
        if _client_gone():
            holder["aborted"] = True
            return False                 # False = 请中止
        return True

    if _client_gone():                   # 上传后、推理前就已断开
        _discard_uploaded([in_path], f.filename)
        return jsonify({"ok": False, "msg": "已取消"}), 200

    try:
        (total, inferred, stats, elapsed, first_frame, rep_boxes,
         timeline, names_map, vw, vh, vfps) = detector.detect_video(
            in_path, out_path, conf=conf, skip=skip, progress_cb=on_progress
        )
    except Exception as e:
        if holder["aborted"]:
            _discard_uploaded([in_path], f.filename)
            return jsonify({"ok": False, "msg": "已取消"}), 200
        logger.warning("[detect] 视频处理失败: %s", e)
        return jsonify({"ok": False, "msg": f"视频处理失败: {e}"}), 500

    if _client_gone():                   # 推理完了但用户已经走了：不落库、不留文件
        _discard_uploaded([in_path], f.filename)
        return jsonify({"ok": False, "msg": "已取消"}), 200

    result = _finalize_video_result(uid, f.filename, total, inferred, stats, elapsed,
                                    first_frame, rep_boxes, used_model,
                                    timeline, names_map, vw, vh, vfps)
    return jsonify(result)


@app.post("/api/detect/video/stream")
@login_required
def detect_video_stream():
    """视频检测（流式进度版）。

    逐行返回 NDJSON：先推若干 {"type":"progress",...}，最后推 {"type":"result",...}；
    失败时推 {"type":"error",...}。老接口 /api/detect/video 保持同步 JSON 不变。
    """
    _gl = _train_locked_response()
    if _gl[0]:
        return _gl
    import queue

    if "file" not in request.files:
        return jsonify({"ok": False, "msg": "请上传视频"}), 400
    f = request.files["file"]
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ALLOWED_VIDEO_EXT:
        return jsonify({"ok": False, "msg": "不支持的视频格式"}), 400

    uid, in_path, out_path, err = _save_and_precheck_video(f, ext)
    if err:
        return jsonify({"ok": False, "msg": err}), 400

    conf, skip = _read_video_form()
    # 统一用全局当前模型（管理员在模型管理页切换，全员生效）
    used_model = detector.get_current()
    filename = f.filename
    q = queue.Queue()
    holder = {}

    # 中断约定：客户端（浏览器）刷新/关闭时 HTTP 连接断开 → Flask 会关闭生成器，
    # gen() 的 finally 置 aborted=True；worker 通过 progress_cb 返回 False 感知到后中止推理，
    # 并把已经上传的原视频删掉（结果不会落库，留着就是孤儿文件白占磁盘）。
    def on_progress(done, total_est):
        if holder.get("aborted"):
            return False      # False = 请中止
        q.put({"type": "progress", "done": done, "total": total_est})
        return True

    def worker():
        try:
            holder["out"] = detector.detect_video(
                in_path, out_path, conf=conf, skip=skip,
                progress_cb=on_progress,
            )
        except Exception as e:
            if holder.get("aborted"):
                logger.info("[detect] 客户端已断开，视频推理中止: %s", filename)
            else:
                logger.warning("[detect] 视频流式处理失败: %s", e)
                holder["err"] = str(e)
        finally:
            if holder.get("aborted"):
                # 结果不会落库 → 连已上传的原视频一起清掉，避免孤儿文件堆积
                _safe_remove_later(in_path, 2)
            q.put({"type": "__end__"})

    threading.Thread(target=worker, daemon=True).start()

    def gen():
        try:
            while True:
                item = q.get()
                if item.get("type") == "__end__":
                    break
                yield json.dumps(item, ensure_ascii=False) + "\n"
            if "err" in holder:
                yield json.dumps({"type": "error", "msg": f"视频处理失败: {holder['err']}"},
                                 ensure_ascii=False) + "\n"
                return
            (total, inferred, stats, elapsed, first_frame, rep_boxes,
             timeline, names_map, vw, vh, vfps) = holder["out"]
            try:
                result = _finalize_video_result(uid, filename, total, inferred, stats, elapsed,
                                                first_frame, rep_boxes, used_model,
                                                timeline, names_map, vw, vh, vfps)
            except Exception as e:
                logger.warning("[detect] 视频结果落库失败: %s", e)
                yield json.dumps({"type": "error", "msg": f"结果保存失败: {e}"},
                                 ensure_ascii=False) + "\n"
                return
            holder["finished"] = True
            yield json.dumps({"type": "result", "data": result}, ensure_ascii=False) + "\n"
        finally:
            # 走到这里而没出结果 = 客户端提前断开（刷新/关闭页面）
            if not holder.get("finished"):
                holder["aborted"] = True
                logger.info("[detect] 客户端断开连接，中止视频推理并清理已上传文件: %s", filename)

    resp = Response(stream_with_context(gen()), mimetype="application/x-ndjson")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


# ==================== 下载「带框」结果：现场绘制，不预生成、不占盘 ====================
# 落盘策略（2026-10-22 改）：图片/视频都只存原文件 + 框数据 JSON，页面上的框一律前端现场画。
# 只有用户真的要带框文件时，才在这里临时合成并下载 —— **全速绘制**（不按 1 倍速、不等帧间隔），
# 合成完立刻下载；视频走临时文件，下载完自动删，不留在磁盘里。
def _upload_url_to_path(url):
    """/uploads/... -> 磁盘绝对路径，不存在返回 None。"""
    if not url or not url.startswith("/uploads/"):
        return None
    p = os.path.join(UPLOAD_DIR, url[len("/uploads/"):].replace("/", os.sep))
    return p if os.path.exists(p) else None


def _record_boxes_doc(row):
    """读回该记录的框数据文件（图片 {"boxes":[...]} / 视频 {"frames":[[..]]}）。"""
    p = _upload_url_to_path(row.get("boxes_url"))
    if p:
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.warning("[download] 框数据读取失败: %s", e)
    try:
        return {"boxes": json.loads(row.get("boxes_json") or "[]"), "names": {}}
    except Exception:
        return {"boxes": [], "names": {}}


# Windows 下跑 ffmpeg 不要弹出控制台窗口
_SP_NOWINDOW = {"creationflags": 0x08000000} if os.name == "nt" else {}


def _safe_remove_later(path, delay=120):
    """send_file 还在读盘时不能删，延迟一会儿再清理临时合成文件。

    句柄偶尔还没释放（Windows 上会 WinError 32），失败后最多再重试 2 次，避免临时文件残留。
    """
    def _rm(attempt=0):
        try:
            if os.path.exists(path):
                os.remove(path)
        except Exception as e:
            if attempt < 2:
                threading.Timer(30, lambda: _rm(attempt + 1)).start()
            else:
                logger.warning("[download] 临时文件清理失败 %s: %s", path, e)
    threading.Timer(delay, _rm).start()


# ==================== 下载「带框」文件：两阶段 ====================
# ① POST /api/record/<id>/prepare —— 后端现场合成，流式推 NDJSON 进度，完成后发一个下载凭证 token
# ② GET  /api/record/<id>/download?token=xxx —— 浏览器直接流式下载（文件不进 JS 内存）
# 为什么要拆两步：合成是几十秒的 CPU 活，需要真实进度和"用户走了就中止"的保护；
# 而下载几十 MB 的文件不该用 fetch+Blob 全塞进内存。拆开后两头都舒服。
_DL_LOCK = threading.Lock()
_DL_BUSY = set()          # 正在合成中的 rid（防连点）
_DL_TOKENS = {}           # token -> {"rid","path","name","user_id","keep","ts"}
# 合成任务表（rid -> 任务快照）。为什么不用流式 NDJSON 推进度：实测用户的浏览器环境里
# 流式响应可能被代理/安全软件缓冲吞掉（fetch 永远收不到第一个字节，而普通 JSON 请求
# 全部正常）→ 改成「后台任务 + 前端轮询 JSON」，轮询是已被证明 100% 可靠的通道。
_DL_JOBS = {}             # rid -> {"state","done","total","token","name","size","msg","aborted","ts"}


def _fetch_record_for_download(rid):
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            if session.get("role") == "admin":
                cur.execute("SELECT * FROM detection_records WHERE id=%s", (rid,))
            else:
                cur.execute("SELECT * FROM detection_records WHERE id=%s AND user_id=%s",
                            (rid, session["user_id"]))
            return cur.fetchone()
    finally:
        conn.close()


@app.get("/api/record/<int:rid>/prepare")
@login_required
def prepare_marked(rid):
    """启动带框文件的后台合成任务，**立即**返回 JSON；进度/结果由 prepare-status 轮询。

    为什么改成「任务 + 轮询」而不是流式 NDJSON：实测用户的浏览器环境里流式响应会被
    吞掉/缓冲（fetch 永远收不到第一个字节，页面卡在"准备中"），而普通 JSON 请求全部
    正常 —— 所以入口也用 GET（POST 在该环境同样有被吞的嫌疑），只依赖已验证可靠的通道。
    """
    row = _fetch_record_for_download(rid)
    if not row:
        return jsonify({"ok": False, "msg": "记录不存在或无权限"}), 404
    now = time.time()
    with _DL_LOCK:
        job = _DL_JOBS.get(rid)
        if job and job.get("state") == "running":
            return jsonify({"ok": False, "msg": "该文件正在合成中，请勿重复点击"}), 409
        for k in [k for k, v in _DL_JOBS.items() if now - v.get("ts", 0) > 1800]:
            _DL_JOBS.pop(k, None)          # 回收半小时前的旧任务快照
        job = {"state": "running", "done": 0, "total": 0, "token": None, "name": None,
               "size": 0, "msg": None, "aborted": False, "ts": now}
        _DL_JOBS[rid] = job
        _DL_BUSY.add(rid)

    base = os.path.splitext(row.get("image_name") or "result")[0]
    uid = session["user_id"]               # worker 线程没有请求上下文，先在这里取好

    def worker():
        try:
            def cb(done, total):
                if job["aborted"]:
                    return False
                job["done"], job["total"] = done, total
                return True
            if row.get("media_type") == "video":
                path, name, keep = _compose_marked_video(row, base, progress_cb=cb)
            else:
                path, name, keep = _compose_marked_image(row, base)
            token = uuid.uuid4().hex[:16]
            with _DL_LOCK:
                _DL_TOKENS[token] = {"rid": rid, "path": path, "name": name, "keep": keep,
                                     "user_id": uid, "ts": time.time()}
            job["state"], job["token"], job["name"] = "done", token, name
            job["size"] = os.path.getsize(path) if os.path.exists(path) else 0
            if not keep:
                # 兜底清理：即便该产物从未被下载（仅围观设备 / 发起者刷新后未重下），
                # 也保证 10 分钟后清理，避免残留在临时目录；uploads/tmp 还有启动清扫兜底
                _safe_remove_later(path, 600)
        except InterruptedError:
            job["state"], job["msg"] = "cancelled", "已取消合成"
        except Exception as e:
            logger.warning("[download] 合成失败: %s(%s)", type(e).__name__, e)
            job["state"], job["msg"] = "error", f"合成失败：{e}"
        finally:
            with _DL_LOCK:
                _DL_BUSY.discard(rid)

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"ok": True, "state": "running"})


@app.get("/api/record/<int:rid>/prepare-status")
@login_required
def prepare_status(rid):
    """轮询合成进度：返回 {"state","done","total","token","name","size","msg"}。"""
    with _DL_LOCK:
        job = _DL_JOBS.get(rid)
        snap = None if not job else {k: job.get(k) for k in
                                     ("state", "done", "total", "token", "name", "size", "msg")}
    if snap is None:
        return jsonify({"ok": False, "msg": "没有进行中的合成任务"}), 404
    return jsonify(snap)


@app.get("/api/record/<int:rid>/prepare-cancel")
@login_required
def prepare_cancel(rid):
    """取消合成：置中止标志，worker 的 progress_cb 感知后抛 InterruptedError 停手。"""
    with _DL_LOCK:
        job = _DL_JOBS.get(rid)
        if job and job.get("state") == "running":
            job["aborted"] = True
    return jsonify({"ok": True})


@app.get("/api/record/<int:rid>/download")
@login_required
def download_marked(rid):
    """凭 token 下载已合成好的带框文件（浏览器直接流式下载，不占前端内存）。

    token 一次性即焚：仅限“发起下载的那台设备”使用，杜绝“见者有份”——否则
    多台围观设备同时拿到同一 token 并发下载，会给服务器造成额外压力。其他围观
    设备在前端被限制为“只看进度、不下载”，到 done 时给提示而非真正拉取文件。
    安全性由「token 只发给该任务 user_id + 校验 session 同账号/管理员」保证；
    取 token 时顺带清理 5 分钟前的旧 token，防止 _DL_TOKENS 无限膨胀。
    """
    token = (request.args.get("token") or "").strip()
    with _DL_LOCK:
        info = _DL_TOKENS.pop(token, None)
        now_ts = time.time()
        for k in [k for k, v in _DL_TOKENS.items() if now_ts - v.get("ts", 0) > 300]:
            _DL_TOKENS.pop(k, None)      # 顺带清理 5 分钟前的旧 token（孤儿），防 _DL_TOKENS 膨胀
    if not info or info["rid"] != rid:
        return jsonify({"ok": False, "msg": "下载凭证无效或已过期，请重新点击下载"}), 400
    if info["user_id"] != session["user_id"] and session.get("role") != "admin":
        return jsonify({"ok": False, "msg": "下载凭证无效或已过期，请重新点击下载"}), 400
    path, name = info["path"], info["name"]
    if not os.path.exists(path):
        return jsonify({"ok": False, "msg": "合成产物已失效，请重新点击下载"}), 400

    mime = "video/mp4" if name.lower().endswith(".mp4") else "image/jpeg"
    resp = send_file(path, mimetype=mime, as_attachment=True, download_name=name)
    if not info.get("keep"):
        # keep=True 的是"库里已有引用"的旧产物（不能删）；其余是 tmp 下的临时产物。
        # ⚠ 必须用“响应体迭代器的 close 钩子”触发清理，不能用 resp.call_on_close：
        #   send_file 走 direct_passthrough，WSGI 服务器发完响应体后调用的是**响应体迭代器**
        #   的 close()，而不是 Response.call_on_close 的回调——后者在此链路里根本不触发
        #   （上一版就因为这个导致下载成功却永不清理）。
        #   把清理放进生成器 finally：无论正常发完还是客户端中途断开（GeneratorExit），
        #   服务器调用迭代器 close() 时 finally 都会执行 → 排 60s 定时删除。
        #   60s 真正从“文件完整送达浏览器”起算：用户晾着保存确认框也不会被提前删；
        #   且 finally 里已先 close 掉底层文件句柄，不会踩 Windows 删除正在读文件的 WinError 32。
        #   若浏览器一直不点保存、迟迟不拉流，本钩子不触发，由 worker 的 10 分钟兜底清理接管。
        raw = resp.response          # send_file 的底层文件迭代器
        def _stream_with_cleanup():
            try:
                yield from raw
            finally:
                try:
                    raw.close()
                except Exception:
                    pass
                _safe_remove_later(path, 60)
        resp.response = _stream_with_cleanup()
        resp.direct_passthrough = False   # 让 Flask 走我们包过的迭代器（否则会直接用 raw 绕过）
        resp.headers.pop("Content-Length", None)  # 改为生成器流式，长度未知（浏览器显示未知大小）
    return resp


@app.get("/api/record/<int:rid>/download-direct")
@login_required
def download_marked_direct(rid):
    """（兼容旧入口）一步到位：合成完直接下载，无进度、无 token。仅作兜底保留。"""
    row = _fetch_record_for_download(rid)
    if not row:
        return jsonify({"ok": False, "msg": "记录不存在或无权限"}), 404
    with _DL_LOCK:
        if rid in _DL_BUSY:
            return jsonify({"ok": False, "msg": "该文件正在合成中，请勿重复点击"}), 409
        _DL_BUSY.add(rid)
    base = os.path.splitext(row.get("image_name") or "result")[0]
    try:
        if row.get("media_type") == "video":
            path, name, keep = _compose_marked_video(row, base)
        else:
            path, name, keep = _compose_marked_image(row, base)
        resp = send_file(path, mimetype="video/mp4" if name.endswith(".mp4") else "image/jpeg",
                         as_attachment=True, download_name=name)
        if not keep:
            _safe_remove_later(path, 60)
        return resp
    except Exception as e:
        logger.warning("[download] 合成失败: %s(%s)", type(e).__name__, e)
        return jsonify({"ok": False, "msg": f"合成失败：{e}"}), 500
    finally:
        with _DL_LOCK:
            _DL_BUSY.discard(rid)


def _compose_marked_image(row, base):
    """合成带框图片 → 写到 uploads/tmp，返回 (临时路径, 下载文件名)；失败抛 ValueError。"""
    import cv2
    import detector as _det
    doc = _record_boxes_doc(row)
    boxes = doc.get("boxes") or []
    src = _upload_url_to_path(row.get("source_url") or row.get("image_url") or row.get("result_url"))
    if not src:
        raise ValueError("找不到原始图片文件")
    if not boxes:
        # 旧记录：磁盘上已有后端带框结果图，直接原样拿它当产物
        old = _upload_url_to_path(row.get("result_url"))
        if old and old != src and os.path.exists(old):
            return old, f"{base}_marked.jpg", True      # True = 别删（它在库里有引用）
        img0 = cv2.imread(src)
        if img0 is None:
            raise ValueError("原图读取失败")
        out_img = img0
    else:
        img0 = cv2.imread(src)
        if img0 is None:
            raise ValueError("原图读取失败")
        out_img = _det.draw_boxes_bgr(img0, boxes, doc.get("names") or {})
    ok, buf = cv2.imencode(".jpg", out_img, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    if not ok:
        raise ValueError("图片编码失败")
    name = f"{base}_marked.jpg"
    path = os.path.join(UPLOAD_TMP, f"{uuid.uuid4().hex[:12]}.jpg")
    with open(path, "wb") as f:
        f.write(buf.tobytes())
    return path, name, False


# ---- 音轨处理：OpenCV 合成标注视频时**只写画面**，原片的音轨不会跟过来 → 下载的视频没声音。
# 解决办法：合成完后用 ffmpeg 把原视频的音轨并回去（视频流 -c:v copy 直接复制，不二次编码，
# 只有音频需要 mux/编码，很快）。ffmpeg 来自 imageio_ffmpeg（ultralytics 生态自带二进制），
# 找不到 ffmpeg 时自动退回无声版本，不影响下载功能。
def _ffmpeg_exe():
    """可用的 ffmpeg 路径：优先 imageio_ffmpeg 自带二进制，其次系统 PATH；都没有返回 None。"""
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.exists(exe):
            return exe
    except Exception:
        pass
    try:
        import shutil as _sh
        return _sh.which("ffmpeg")
    except Exception:
        return None


def _ffmpeg_has_audio(exe, src):
    """探测源视频是否含音轨（ffmpeg -i 会在输出里列出 Stream ... Audio:）。"""
    try:
        p = subprocess.run([exe, "-hide_banner", "-i", src],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=30, **_SP_NOWINDOW)
        return b"Audio:" in ((p.stdout or b"") + (p.stderr or b""))
    except Exception as e:
        logger.debug("[download] 音轨探测失败（按无音轨处理）: %s", e)
        return False


def _ffmpeg_mux_audio(exe, silent_mp4, src_video, out_path,
                      reencode_video=False, with_audio=True):
    """把 src_video 的音轨并到 silent_mp4 上，成功返回 True。

    视频流默认直接 copy（不重新编码，省时间也保画质）；
    reencode_video=True 时用 libx264 重编码 —— 这台机器 avc1 不可用、OpenCV 回落 mp4v，
    中间文件会比原片大好几倍（实测 42KB→240KB），重编码能把它压回正常体积且更兼容。
    音频一律先尝试 copy，格式不兼容 mp4 时再退回 aac 重编码。
    """
    vcodec = "libx264" if reencode_video else "copy"
    vextra = ["-pix_fmt", "yuv420p", "-crf", "23", "-preset", "veryfast"] if reencode_video else []
    base = [exe, "-y", "-hide_banner", "-loglevel", "error"]
    for acodec in (("copy", "aac") if with_audio else (None,)):
        if with_audio:
            # 视频取合成片、音频取原片，两个输入一起 mux
            cmd = (base + ["-i", silent_mp4, "-i", src_video,
                           "-map", "0:v:0", "-map", "1:a:0",
                           "-c:v", vcodec] + vextra
                   + ["-c:a", acodec, "-shortest", out_path])
        else:
            # 原片没音轨：只做视频转码（把 mp4v 中间文件压成 H.264）
            cmd = base + ["-i", silent_mp4, "-map", "0:v:0", "-c:v", vcodec] + vextra + [out_path]
        try:
            p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=900, **_SP_NOWINDOW)
            if p.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
                logger.info("[download] 合成完成（视频=%s 音频=%s，%d 字节）",
                            vcodec, acodec or "无", os.path.getsize(out_path))
                return True
        except Exception as e:
            logger.debug("[download] 合成失败（v=%s a=%s）: %s", vcodec, acodec, e)
        try:
            if os.path.exists(out_path):
                os.remove(out_path)
        except Exception:
            pass
    return False


def _compose_marked_video(row, base, progress_cb=None):
    """合成带框视频 → 写到 uploads/tmp，返回 (临时路径, 下载文件名, 是否别删)。

    progress_cb(done, total) 返回 False = 客户端已断开，立即中止；
    同时也用它上报进度（由 prepare 接口推给前端显示百分比）。
    """
    import cv2
    import tempfile
    import detector as _det
    doc = _record_boxes_doc(row)
    frames = doc.get("frames")
    names = doc.get("names") or {}
    src = _upload_url_to_path(row.get("source_url") or row.get("result_url"))
    if not src:
        raise ValueError("找不到原始视频文件")
    name = f"{base}_marked.mp4"
    if not frames:
        # 旧记录：磁盘上已有后端标注 mp4，直接原样拿它当产物
        old = _upload_url_to_path(row.get("result_url"))
        if old and os.path.exists(old):
            return old, name, True
        raise ValueError("该记录没有框数据，无法合成标注视频")

    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        raise ValueError("原视频读取失败（无法打开源视频）")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fd, tmp_path = tempfile.mkstemp(prefix="__dl_", suffix=".mp4", dir=UPLOAD_TMP)
    os.close(fd)
    # 优先 H.264(avc1)；这台机器上它不可用会回落 mp4v —— 记下来，后面用 ffmpeg 重编码补救
    used_codec = "avc1"
    writer = cv2.VideoWriter(tmp_path, cv2.VideoWriter_fourcc(*"avc1"), fps, (w, h))
    if not writer.isOpened():
        writer.release()
        used_codec = "mp4v"
        writer = cv2.VideoWriter(tmp_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    idx = 0
    aborted = [False]
    total_est = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    def _tick(done):
        """上报进度；回调返回 False（客户端断开）则中止。每 10 帧或每 0.4 秒上报一次。"""
        if progress_cb is None:
            return True
        now = time.time()
        if done == 1 or done % 10 == 0 or (now - _tick.last >= 0.4):
            _tick.last = now
            return progress_cb(done, total_est) is not False
        return True
    _tick.last = 0.0

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            if not _tick(idx + 1):
                aborted[0] = True
                logger.info("[download] 客户端已断开，中止标注视频合成: %s", row.get("image_name"))
                break
            arr = frames[idx] if idx < len(frames) else []
            if arr:
                frame = _det.draw_boxes_bgr(frame, arr, names)
            writer.write(frame)      # 全速写，不做任何限速
            idx += 1
    finally:
        cap.release()
        writer.release()
    if aborted[0]:
        _safe_remove_later(tmp_path, 3)
        raise InterruptedError("客户端已断开，合成已中止")

    # OpenCV 只写画面 → 把原片的音轨并回来，下载的视频才有声音
    final_path = tmp_path
    mixed_path = None
    exe = _ffmpeg_exe()
    if not exe:
        logger.warning("[download] 未找到 ffmpeg，标注视频将没有声音（且体积可能偏大）")
    else:
        has_audio = _ffmpeg_has_audio(exe, src)
        # OpenCV 写视频没法设码率：avc1 能开时码率偏高、不可用时回落 mp4v，两种情况都会让
        # 中间文件比原片大好几倍（实测 5.7×~15×）。体积明显膨胀就用 ffmpeg 压一遍（crf 23）。
        try:
            _src_sz = os.path.getsize(src)
            _tmp_sz = os.path.getsize(tmp_path)
            need_reencode = (used_codec == "mp4v") or (_tmp_sz > _src_sz * 2)
        except Exception:
            need_reencode = (used_codec == "mp4v")
        if has_audio or need_reencode:
            fd2, mixed_path = tempfile.mkstemp(prefix="__dl_mix_", suffix=".mp4", dir=UPLOAD_TMP)
            os.close(fd2)
            if _ffmpeg_mux_audio(exe, tmp_path, src, mixed_path,
                                 reencode_video=need_reencode, with_audio=has_audio):
                final_path = mixed_path
            else:
                logger.warning("[download] ffmpeg 合成失败，退回 OpenCV 直出版本: %s",
                               row.get("image_name"))
                _safe_remove_later(mixed_path, 5)
                mixed_path = None
        if not has_audio:
            logger.info("[download] 原视频本身没有音轨，标注视频同样无声: %s", row.get("image_name"))

    # 中间产物（OpenCV 直出的那个）用完就删；最终产物交给调用方（下载后由调用方清理）
    _safe_remove_later(tmp_path, 5)
    return final_path, name, False


@app.get("/api/disk/free")
@login_required
def disk_free():
    """返回上传/结果目录所在磁盘的剩余空间（MB），供批量任务提前预估是否够用（P2-2）。"""
    try:
        free_mb = shutil.disk_usage(UPLOAD_DIR).free / 1024 / 1024
    except Exception:
        free_mb = 0
    return jsonify({"ok": True, "free_mb": round(free_mb, 1)})


# ==================== 批量图片检测 ====================
@app.post("/api/detect/batch-image")
@login_required
def detect_batch_image():
    """接收多图片文件，逐张推理并落库，返回每张结果。"""
    _gl = _train_locked_response()
    if _gl[0]:
        return _gl
    files = request.files.getlist("files")
    if not files:
        return jsonify({"ok": False, "msg": "请选择图片"}), 400

    import cv2
    import numpy as np
    conf = float(request.form.get("conf", DEFAULT_CONF))

    results = []
    cancelled = False    # 客户端中途断开：停止处理剩下的，已完成的保留
    conf = float(request.form.get("conf", DEFAULT_CONF))
    conn = db.get_db()
    try:
        for f in files:
            # 每张开始前先探一次：断了就别再烧 CPU 处理剩下的（已入库的会先 commit 保留）
            if _client_gone():
                cancelled = True
                logger.info("[detect] 批量图片：客户端已断开，停止处理剩余图片（已完成 %d 张）",
                           len(results))
                break
            ext = os.path.splitext(f.filename)[1].lower()
            if ext not in ALLOWED_IMAGE_EXT:
                results.append({"name": f.filename, "ok": False, "msg": "格式不支持"})
                continue
            try:
                orig_path = None
                raw = f.read()
                # 单张图片独立上限（防止整张解码后 OOM）：超限跳过该张
                if len(raw) > MAX_IMAGE_MB * 1024 * 1024:
                    results.append({"name": f.filename, "ok": False,
                                    "msg": f"图片过大，单张不能超过 {MAX_IMAGE_MB} MB"})
                    continue
                arr = np.frombuffer(raw, np.uint8)
                img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                if img is None:
                    results.append({"name": f.filename, "ok": False, "msg": "解析失败"})
                    continue
                uid = uuid.uuid4().hex[:12]
                orig_name = f"{uid}{ext}"
                orig_path = os.path.join(UPLOAD_IMAGES, orig_name)
                cv2.imwrite(orig_path, img)
                # 与单张一致：只存原图 + 框数据 JSON，不写带框结果图
                _plotted, boxes, stats, elapsed = detector.detect_image(img, conf=conf, plot=False)
                # 推理这张的途中断开：本张不落库、文件收走，剩下的也不再处理
                if _client_gone():
                    cancelled = True
                    _discard_uploaded([orig_path], f.filename)
                    logger.info("[detect] 批量图片：客户端已断开，停止后续处理（已完成 %d 张）",
                               len(results))
                    break
                boxes_url = ""
                boxes_path = ""
                try:
                    bh, bw = img.shape[:2]
                    tl_name = f"{uid}_boxes.json"
                    boxes_path = os.path.join(UPLOAD_BOXES, tl_name)
                    with open(boxes_path, "w", encoding="utf-8") as tf:
                        json.dump({"width": int(bw), "height": int(bh),
                                   "names": {str(b.get("cls")): b.get("cls_name") for b in (boxes or [])},
                                   "boxes": boxes},
                                  tf, ensure_ascii=False, separators=(",", ":"))
                    boxes_url = f"/uploads/boxes/{tl_name}"
                except Exception as e:
                    logger.warning("[detect] 批量图片框数据写入失败（不影响主流程）: %s", e)

                total = sum(stats.values())
                conclusion = f"检测到 {total} 个目标"

                with conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO detection_records "
                        "(user_id, username, image_name, image_url, result_url, boxes_url, media_type, "
                        " conclusion, stats_json, boxes_json, model_name, duration_ms) "
                        "VALUES (%s,%s,%s,%s,%s,%s,'image',%s,%s,%s,%s,%s)",
                        (session["user_id"], session["username"], f.filename,
                         f"/uploads/images/{orig_name}",
                         f"/uploads/images/{orig_name}",
                         boxes_url or "",
                         conclusion, json.dumps(stats, ensure_ascii=False),
                         json.dumps(boxes, ensure_ascii=False),
                         detector.get_current(), elapsed),
                    )
                    rec_id = cur.lastrowid
                conn.commit()   # 逐张提交：中途取消时已完成的部分能保留下来
                results.append({
                    "name": f.filename, "ok": True,
                    "record_id": rec_id,
                    "image_url": f"/uploads/images/{orig_name}",
                    "result_url": f"/uploads/images/{orig_name}",
                    "boxes_url": boxes_url,
                    "boxes": boxes, "stats": stats,
                    "conclusion": conclusion, "duration_ms": elapsed,
                })
            except Exception as e:
                if orig_path:
                    _discard_uploaded([orig_path], f.filename)   # 这张没入库，别留孤儿
                results.append({"name": f.filename, "ok": False, "msg": str(e)})
        conn.commit()
    finally:
        conn.close()

    ok_n = sum(1 for r in results if r["ok"])
    return jsonify({"ok": True, "items": results, "done": ok_n,
                    "total": len(results), "cancelled": cancelled})


# ==================== 历史 ====================
@app.get("/api/history")
@login_required
def list_history():
    user_filter = request.args.get("user", "")
    kw = (request.args.get("kw") or "").strip()
    page, limit, offset = _paging()
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            ands = []
            params = []
            # 普通用户只能看自己的记录；管理员可看全部
            if session.get("role") != "admin":
                ands.append("user_id=%s")
                params.append(session["user_id"])
            elif user_filter and user_filter != "all":
                ands.append("username=%s")
                params.append(user_filter)
            if kw:
                ands.append("image_name LIKE %s")
                params.append("%" + kw + "%")
            wsql = (" WHERE " + " AND ".join(ands)) if ands else ""
            cur.execute("SELECT COUNT(*) AS c FROM detection_records" + wsql, params)
            total = cur.fetchone()["c"]
            sql = ("SELECT id, username, image_name, image_url, result_url, source_url, boxes_url, conclusion, "
                   "stats_json, boxes_json, model_name, duration_ms, created_at "
                   "FROM detection_records" + wsql +
                   " ORDER BY id DESC LIMIT %s OFFSET %s")
            cur.execute(sql, params + [limit, offset])
            rows = cur.fetchall()
        out = []
        for r in rows:
            try:
                stats = json.loads(r["stats_json"] or "{}")
            except Exception:
                stats = {}
            try:
                boxes = json.loads(r["boxes_json"] or "[]")
            except Exception:
                boxes = []
            out.append({
                "id": r["id"],
                "username": r["username"],
                "image_name": r["image_name"],
                "image_url": r["image_url"],
                "result_url": r["result_url"],
                "source_url": r.get("source_url") or "",
                "boxes_url": r.get("boxes_url") or "",
                "conclusion": r["conclusion"],
                "stats": stats,
                "boxes": boxes,
                "model_name": r["model_name"],
                "duration_ms": r["duration_ms"],
                "created_at": r["created_at"].strftime("%Y/%m/%d %H:%M:%S"),
            })
        return jsonify({"ok": True, "records": out, "total": total,
                        "page": page, "limit": limit})
    finally:
        conn.close()


def _del_upload(url):
    """根据 /uploads/... URL 删除磁盘文件，不存在则忽略。

    每一步都打日志：孤儿文件清理"看起来没动静"时，靠这里分辨到底是
    URL 格式不对、路径拼错、还是 os.remove 本身被拦（某些受控环境下会静默失败）。
    """
    if not url or not url.startswith("/uploads/"):
        logger.info("[cleanup][skip] URL 非 /uploads/ 或为空: %r", url)
        return False
    rel = url[len("/uploads/"):]
    p = os.path.join(UPLOAD_DIR, rel.replace("/", os.sep))
    if not os.path.exists(p):
        logger.info("[cleanup][skip] 文件已不存在: %s", p)
        return False
    try:
        os.remove(p)
    except Exception as e:
        logger.warning("[cleanup][fail] 删除文件失败 %s: %s(%s)", p, type(e).__name__, e)
        return False
    if os.path.exists(p):
        # 罕见但致命：os.remove 没报错却没删掉（受控/沙箱环境会这样）
        logger.warning("[cleanup][fail] os.remove 返回成功但文件仍在: %s", p)
        return False
    logger.info("[cleanup][ok] 已删除: %s", p)
    return True


def _del_source_video(source_url, result_url):
    """删除视频检测的原始上传视频。

    新记录路径存于 source_url；历史记录 source_url 为空时，
    从 result_url 推导 uid 并尝试已知视频扩展名兜底清理（避免旧数据残留）。
    """
    if source_url:
        _del_upload(source_url)
        return
    if not result_url or "/uploads/results/videos/" not in result_url:   # 旧记录兼容（新记录已无此路径）
        return
    base = os.path.basename(result_url)
    if not base.endswith("_out.mp4"):
        return
    uid = base[: -len("_out.mp4")]
    if not uid:
        return
    for ext in ALLOWED_VIDEO_EXT:
        _del_upload(f"/uploads/videos/{uid}{ext}")


def _del_record_files(row):
    """删除一条检测记录关联的全部磁盘文件（预览图/结果图/结果视频/原始视频）。

    row 为含 url 字段的字典；兼容旧记录缺失 source_url 字段的情况。
    """
    if not row:
        return
    _del_upload(row.get("image_url"))
    _del_upload(row.get("result_url"))
    _del_source_video(row.get("source_url"), row.get("result_url"))


# ---- 磁盘文件异步清理 ----
# 为什么要异步：删除一条记录要连同预览图/结果图/原始视频一起从磁盘删掉，
# 大视频的 IO 很慢（实测 20 条耗时 17 秒），且在某些环境下会被安全策略拦截/卡住，
# HTTP 请求就会一直挂在那里甚至被掐断 → 前端收到 "Failed to fetch"（实际已删、误报失败）。
# 数据库记录本身是瞬时删除的，所以：**先删库立即可返回，文件清理丢后台线程**，
# 即便清理失败也只是留下孤儿文件，不影响用户的删除操作。
_CLEANUP_Q = queue.Queue()
_CLEANUP_LOCK = threading.Lock()
_CLEANUP_STARTED = False
_CLEANUP_WORKERS = 2


def _cleanup_worker():
    while True:
        row = _CLEANUP_Q.get()
        try:
            _del_record_files(row)
        except Exception as e:
            logger.warning("[cleanup] 后台清理文件异常: %s(%s)", type(e).__name__, e)
        finally:
            _CLEANUP_Q.task_done()


def _probe_delete_capability():
    """启动时自测：当前进程到底能不能删磁盘文件。

    历史教训：某些受控环境下 os.remove 会被静默拦截/卡住，
    导致"记录删了、图片还在"，且日志里毫无痕迹。这里开机就探一次，
    结果写进日志，排查时一眼可见。
    """
    import tempfile
    try:
        fd, tmp = tempfile.mkstemp(prefix="__probe_", dir=UPLOAD_DIR)
        os.close(fd)
        os.remove(tmp)
        ok = not os.path.exists(tmp)
        if ok:
            logger.info("[cleanup][probe] 当前进程可正常删除上传目录下的文件")
        else:
            logger.warning("[cleanup][probe] 删除调用无异常但文件仍在，本进程的文件删除被拦截！")
    except Exception as e:
        logger.warning("[cleanup][probe] 删除能力自测失败: %s(%s)", type(e).__name__, e)


_probe_delete_capability()


def _schedule_record_cleanup(rows):
    """把若干条记录的磁盘文件丢进后台清理队列（非阻塞）。"""
    global _CLEANUP_STARTED
    pending = [dict(r) for r in rows if r]
    if not pending:
        return
    with _CLEANUP_LOCK:
        if not _CLEANUP_STARTED:
            for i in range(_CLEANUP_WORKERS):
                threading.Thread(
                    target=_cleanup_worker, daemon=True, name=f"cleanup-{i}"
                ).start()
            _CLEANUP_STARTED = True
    for r in pending:
        _CLEANUP_Q.put(r)


def _cleanup_watchdog():
    """定期巡查后台清理队列。

    受控环境下单个进程的磁盘删除次数可能提前耗尽，之后 os.remove 会永久卡住：
    表现是"记录删了、图片还在"，而且日志里没有任何报错（异常都不会抛）。
    这里只看一个信号——队列是否还在消化；长时间不动就明确告警，避免问题被忽略。
    """
    import time as _t
    _last_size = 0
    _stall_rounds = 0
    while True:
        _t.sleep(30)
        size = _CLEANUP_Q.qsize()
        if size == 0:
            _stall_rounds = 0
        elif size == _last_size:
            _stall_rounds += 1
            if _stall_rounds >= 2:      # 连续 60 秒没有进展
                logger.warning(
                    "[cleanup][watchdog] 文件清理队列卡住，剩余 %d 条未处理。"
                    "当前进程可能已达磁盘删除上限或被安全策略拦截，"
                    "建议用「启动后端.exe」重启后端，再到历史页点「清理孤儿文件」", size,
                )
                _stall_rounds = 0
        else:
            _stall_rounds = 0
        _last_size = size


threading.Thread(target=_cleanup_watchdog, daemon=True, name="cleanup-watchdog").start()


def _startup_orphan_sweep():
    """开机补清孤儿文件。

    上一轮遗留的孤儿（记录删了但图还在）不该一直躺在磁盘上。每次后端启动后
    在后台扫一次；启动即全删（不再按修改时间 1 小时门槛），单轮限时 20 秒。
    单轮没扫完（truncated，常见于「刚清库 → 全盘文件都成孤儿」或删除被受控环境拖慢）
    就接着再开一轮，最多 6 轮 —— 以前只跑一轮，几千个文件时清一半就收工，
    剩下的要等下一次启动，看起来就像"回收不干净"。
    第 1 轮 min_age=0（开机瞬间本进程还没产生上传，历史遗留一律可删）；
    后续轮次用默认 3 分钟保护窗，避免误删"刚上传、还没入库"的新文件。
    """
    time.sleep(20)          # 等其它启动任务（模型加载等）先跑完
    deleted = freed = failed = 0
    try:
        for i in range(6):
            r = _sweep_orphan_files(
                dry=False,
                deadline=time.monotonic() + 20,
                min_age=0 if i == 0 else _ORPHAN_SAFE_SECONDS,
            )
            deleted += r["deleted"]
            freed += r["freed_bytes"]
            failed += r["failed"]
            if not r["truncated"]:
                break
            logger.info("[cleanup][boot] 第 %d 轮未扫完（本轮删 %d），继续下一轮",
                        i + 1, r["deleted"])
        if deleted or failed:
            logger.info(
                "[cleanup][boot] 开机孤儿回收：删除 %d 个（%d 字节），失败 %d",
                deleted, freed, failed,
            )
        else:
            logger.info("[cleanup][boot] 开机孤儿回收：磁盘无孤儿文件")
    except Exception as e:
        logger.warning("[cleanup][boot] 开机孤儿回收异常: %s(%s)", type(e).__name__, e)
    # 下载临时目录：启动即全清（上次异常退出遗留的临时产物一并清掉；本进程尚未
    # 产生任何下载，此时目录里全是上一轮的残留，可无脑清）
    try:
        n = 0
        for fn in os.listdir(UPLOAD_TMP):
            p = os.path.join(UPLOAD_TMP, fn)
            try:
                if os.path.isfile(p):
                    os.remove(p)
                    n += 1
            except Exception:
                pass
        if n:
            logger.info("[cleanup][boot] 清理下载临时产物 %d 个", n)
    except Exception as e:
        logger.warning("[cleanup][boot] 下载临时目录清理异常: %s(%s)", type(e).__name__, e)


threading.Thread(target=_startup_orphan_sweep, daemon=True, name="cleanup-boot").start()


@app.delete("/api/history/<int:rid>")
@login_required
def delete_history(rid):
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT image_url, result_url, source_url FROM detection_records WHERE id=%s",
                (rid,),
            )
            _rows = [cur.fetchone()]
            if session.get("role") != "admin":
                cur.execute(
                    "DELETE FROM detection_records WHERE id=%s AND user_id=%s",
                    (rid, session["user_id"]),
                )
            else:
                cur.execute("DELETE FROM detection_records WHERE id=%s", (rid,))
        conn.commit()
        _schedule_record_cleanup(_rows)
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.post("/api/history/batch-delete")
@login_required
def batch_delete_history():
    """删除所选记录，body: {"ids":[1,2,3]}"""
    _t0 = time.time()
    data = request.get_json(force=True) or {}
    ids = data.get("ids") or []
    if not ids:
        return jsonify({"ok": False, "msg": "未选择记录"}), 400
    ids = [int(i) for i in ids]
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            placeholders = ",".join(["%s"] * len(ids))
            if session.get("role") != "admin":
                cur.execute(
                    f"SELECT image_url, result_url, source_url FROM detection_records WHERE id IN ({placeholders}) AND user_id=%s",
                    ids + [session["user_id"]],
                )
            else:
                cur.execute(
                    f"SELECT image_url, result_url, source_url FROM detection_records WHERE id IN ({placeholders})",
                    ids,
                )
            _rows = cur.fetchall()
            if session.get("role") != "admin":
                cur.execute(
                    f"DELETE FROM detection_records WHERE id IN ({placeholders}) AND user_id=%s",
                    ids + [session["user_id"]],
                )
            else:
                cur.execute(
                    f"DELETE FROM detection_records WHERE id IN ({placeholders})",
                    ids,
                )
            n = cur.rowcount
        conn.commit()
        _schedule_record_cleanup(_rows)
        app.logger.info(
            "[batch-delete] user=%s ids=%s deleted=%s 耗时 %.2fs",
            session.get("user_id"), len(ids), n, time.time() - _t0,
        )
        return jsonify({"ok": True, "deleted": n})
    finally:
        conn.close()


@app.post("/api/history/exists")
@login_required
def history_exists():
    """核实给定 id 中哪些仍存在（删除请求遇网络故障时，前端用于确认是否实际已删掉）。
    body: {"ids":[1,2,3]} → {"ok":true,"existing":[仍存在的 id 列表]}"""
    data = request.get_json(force=True) or {}
    ids = data.get("ids") or []
    if not ids:
        return jsonify({"ok": True, "existing": []})
    try:
        ids = [int(i) for i in ids]
    except (TypeError, ValueError):
        return jsonify({"ok": False, "msg": "参数错误"}), 400
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            placeholders = ",".join(["%s"] * len(ids))
            if session.get("role") != "admin":
                cur.execute(
                    f"SELECT id FROM detection_records WHERE id IN ({placeholders}) AND user_id=%s",
                    ids + [session["user_id"]],
                )
            else:
                cur.execute(
                    f"SELECT id FROM detection_records WHERE id IN ({placeholders})",
                    ids,
                )
            existing = [r["id"] for r in cur.fetchall()]
        return jsonify({"ok": True, "existing": existing})
    finally:
        conn.close()


@app.post("/api/history/clear")
@login_required
def clear_history():
    """删除全部检测记录（普通用户只删自己的，管理员删全部）"""
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            if session.get("role") != "admin":
                cur.execute("SELECT image_url, result_url, source_url FROM detection_records WHERE user_id=%s",
                            (session["user_id"],))
            else:
                cur.execute("SELECT image_url, result_url, source_url FROM detection_records")
            _rows = cur.fetchall()
            if session.get("role") != "admin":
                cur.execute("DELETE FROM detection_records WHERE user_id=%s",
                            (session["user_id"],))
            else:
                cur.execute("DELETE FROM detection_records")
            n = cur.rowcount
        conn.commit()
        _schedule_record_cleanup(_rows)
        return jsonify({"ok": True, "deleted": n})
    finally:
        conn.close()


# ---- 孤儿文件兜底清理 ----
# 背景：删除记录时如果文件清理失败（例如当前进程被环境的"安全删除"策略拦截），
# 数据库里已经没有这条记录，磁盘上的图/视频却留下成为孤儿，越积越多。
# 这里提供一次全量扫描：凡是不被任何记录引用的文件，统统删掉。
_ORPHAN_DIRS = (
    os.path.join("images"),     # 原图
    os.path.join("videos"),     # 原视频
    os.path.join("boxes"),      # 框数据 JSON（原 results/images、results/videos 已合并到这里）
)
_ORPHAN_SAFE_SECONDS = 180   # 刚生成不到 3 分钟的文件跳过：可能正在上传/推理中


def _sweep_orphan_files(dry=False, deadline=None, min_age=None):
    """扫描上传目录，删除不被任何检测记录引用的文件。

    dry=True 只统计不删除；deadline 为 time.monotonic() 时间戳，超时则提前收尾
    （受控环境下单次 os.remove 可能卡死，不能让 HTTP 请求陪着挂到底）；
    min_age 为"只处理生成超过这么多秒的文件"，默认 _ORPHAN_SAFE_SECONDS。
    """
    conn = db.get_db()
    keep = set()
    try:
        with conn.cursor() as cur:
            # boxes_url 必须算进"保留清单"：新落盘策略下框数据文件和原文件一样是被引用的，
            # 漏了它会被当成孤儿删掉（删了就再也画不出框了）
            for col in ("image_url", "result_url", "source_url", "boxes_url"):
                cur.execute(
                    f"SELECT DISTINCT {col} AS u FROM detection_records "
                    f"WHERE {col} IS NOT NULL AND {col} <> ''"
                )
                for r in cur.fetchall():
                    keep.add(r["u"])
    finally:
        conn.close()

    scanned = deleted = skipped = failed = 0
    truncated = False
    freed = 0
    samples = []
    now = time.time()
    for sub in _ORPHAN_DIRS:
        base = os.path.join(UPLOAD_DIR, sub)
        if not os.path.isdir(base):
            continue
        for name in os.listdir(base):
            p = os.path.join(base, name)
            if not os.path.isfile(p):
                continue
            scanned += 1
            url = "/uploads/" + os.path.relpath(p, UPLOAD_DIR).replace(os.sep, "/")
            if url in keep:
                continue
            try:
                mtime = os.path.getmtime(p)
                size = os.path.getsize(p)
            except OSError:
                continue
            if now - mtime < (_ORPHAN_SAFE_SECONDS if min_age is None else min_age):
                skipped += 1          # 太新，可能是正在写入的文件
                continue
            if dry:
                deleted += 1
                freed += size
                continue
            if _del_upload(url):
                deleted += 1
                freed += size
            else:
                failed += 1
                if len(samples) < 5:
                    samples.append(name)
            if deadline and time.monotonic() > deadline:
                truncated = True
                break
        if truncated:
            break
    return {
        "scanned": scanned, "deleted": deleted, "skipped": skipped,
        "failed": failed, "freed_bytes": freed, "samples": samples,
        "truncated": truncated,
    }


@app.post("/api/history/cleanup-orphans")
@login_required
@admin_required
def cleanup_orphans():
    """管理员清理孤儿文件（不被任何检测记录引用的图/视频）。body: {"dry":true} 只预览。"""
    data = request.get_json(silent=True) or {}
    dry = bool(data.get("dry"))
    # 限时 25 秒：宁可返回"没干完"，也不要让请求陪着卡死的 os.remove 一起挂
    deadline = time.monotonic() + 25
    try:
        r = _sweep_orphan_files(dry=dry, deadline=deadline, min_age=10)
    except Exception as e:
        logger.warning("[cleanup][orphan] 扫描失败: %s(%s)", type(e).__name__, e)
        return jsonify({"ok": False, "msg": "扫描失败：" + str(e)}), 500
    r["ok"] = True
    logger.info("[cleanup][orphan] dry=%s 结果: %s", dry, r)
    if r.get("truncated"):
        r["msg"] = ("本轮未在限额时间内做完（可能遇到磁盘删除受限），"
                    "已清理 %d 个，可再次点击继续" % r["deleted"])
    elif r["failed"]:
        # 删不掉通常意味着当前进程没有删除权限（受控环境会静默拦截）
        r["msg"] = ("有 %d 个文件删不掉，当前后端进程可能没有磁盘删除权限，"
                    "请用「启动后端.exe」重启后端后再试" % r["failed"])
    return jsonify(r)


# ==================== 用户管理 ====================
@app.post("/api/offline")
@login_required
def offline():
    """前端真正下线（关闭页面/刷新）时调用：从内存移除，并把最后在线时间写一次 DB。"""
    try:
        del ONLINE_MAP[session["user_id"]]
    except KeyError:
        pass
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET last_seen=NOW() WHERE id=%s", (session["user_id"],))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.get("/api/usernames")
@login_required
@admin_required
def list_usernames():
    """返回所有用户名（用于历史页筛选下拉框，仅管理员可访问）。"""
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT username FROM users ORDER BY id")
            rows = cur.fetchall()
        return jsonify({"ok": True, "users": [r["username"] for r in rows]})
    finally:
        conn.close()


@app.get("/api/users")
@admin_required
def list_users():
    now = time.time()
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, username, role, status, created_at, last_seen, user_code, phone FROM users ORDER BY id")
            rows = cur.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            info = ONLINE_MAP.get(r["id"])
            if info and (now - info["ts"]) <= 12:
                d["online"] = True
                d["device"] = info.get("device", "")
            else:
                d["online"] = False
                d["device"] = ""
            result.append(d)
        return jsonify({"ok": True, "users": result})
    finally:
        conn.close()


@app.delete("/api/users/<int:uid>")
@admin_required
def delete_user(uid):
    if uid == session.get("user_id"):
        return jsonify({"ok": False, "msg": "不能删除当前登录账号"}), 400
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE id=%s", (uid,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.post("/api/users/batch-delete")
@admin_required
def batch_delete_users():
    data = request.get_json(force=True)
    ids = data.get("ids") or []
    ids = [i for i in ids if i != session.get("user_id")]
    if not ids:
        return jsonify({"ok": False, "msg": "没有可删除的用户（不能删自己）"}), 400
    conn = db.get_db()
    try:
        n = _batch_delete_rows(conn, "users", "id", ids)
        conn.commit()
        return jsonify({"ok": True, "deleted": n})
    finally:
        conn.close()


# ==================== 文章管理 ====================
@app.get("/api/articles")
@admin_required
def list_articles_admin():
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM articles ORDER BY created_at DESC")
            rows = cur.fetchall()
        return jsonify({"ok": True, "articles": rows})
    finally:
        conn.close()


@app.get("/api/articles/public")
def list_articles_public():
    """安全宣教页：只列已发布文章。"""
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, title, summary, category, cover_url, author, created_at "
                        "FROM articles WHERE status='published' ORDER BY created_at DESC")
            rows = cur.fetchall()
        return jsonify({"ok": True, "articles": rows})
    finally:
        conn.close()


@app.get("/api/articles/<int:aid>")
def get_article(aid):
    """公开：获取单篇已发布文章详情（含正文）。"""
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM articles WHERE id=%s AND status='published'", (aid,))
            row = cur.fetchone()
        if not row:
            return jsonify({"ok": False, "msg": "文章不存在或未发布"}), 404
        return jsonify({"ok": True, "article": row})
    finally:
        conn.close()


@app.delete("/api/articles/<int:aid>")
@admin_required
def delete_article(aid):
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM articles WHERE id=%s", (aid,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.post("/api/articles/batch-delete")
@admin_required
def batch_delete_articles():
    data = request.get_json(force=True)
    ids = data.get("ids") or []
    if not ids:
        return jsonify({"ok": False, "msg": "未选择文章"}), 400
    conn = db.get_db()
    try:
        n = _batch_delete_rows(conn, "articles", "id", ids)
        conn.commit()
        return jsonify({"ok": True, "deleted": n})
    finally:
        conn.close()


# ==================== 模型批量删除 ====================
@app.post("/api/models/batch-delete")
@admin_required
def batch_delete_models():
    data = request.get_json(force=True)
    ids = data.get("ids") or []
    if not ids:
        return jsonify({"ok": False, "msg": "未选择模型"}), 400
    conn = db.get_db()
    deleted = 0
    try:
        with conn.cursor() as cur:
            fmt = ",".join(["%s"] * len(ids))
            cur.execute(f"SELECT id, file_name, is_current FROM models WHERE id IN ({fmt})", ids)
            rows = cur.fetchall()
            for r in rows:
                if r["is_current"]:
                    continue
                detector.unload(r["file_name"])
                p = detector.model_path(r["file_name"])
                if os.path.exists(p):
                    os.remove(p)
                cur.execute("DELETE FROM models WHERE id=%s", (r["id"],))
                deleted += 1
        conn.commit()
        return jsonify({"ok": True, "deleted": deleted})
    finally:
        conn.close()


# ==================== 工作台统计 ====================
@app.get("/api/stats")
@login_required
def dashboard_stats():
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) c FROM detection_records")
            n_records = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) c FROM detection_records WHERE DATE(created_at)=CURDATE()")
            n_today = cur.fetchone()["c"]
            cur.execute("SELECT name FROM models WHERE is_current=1")
            row = cur.fetchone()
            cur.execute("SELECT image_name, conclusion, created_at, media_type FROM detection_records ORDER BY created_at DESC LIMIT 4")
            recent = cur.fetchall()
        return jsonify({"ok": True, "records": n_records, "today": n_today,
                        "online": len(ONLINE_MAP),
                        "current_model": (row and row["name"]) or detector.current_file or "未加载",
                        "recent": recent, "role": session.get("role")})
    finally:
        conn.close()


# ==================== 用户管理：新增/改角色 ====================
@app.post("/api/users")
@admin_required
def create_user():
    data = request.get_json(force=True)
    username = (data.get("username") or "").strip()
    phone = (data.get("phone") or "").strip()
    password = data.get("password") or ""
    role = data.get("role") or "user"
    if not phone or len(phone) != 11 or not phone.isdigit() or not phone.startswith("1"):
        return jsonify({"ok": False, "msg": "请输入正确的 11 位手机号"}), 400
    if not password:
        return jsonify({"ok": False, "msg": "请填写密码"}), 400
    if role not in ("admin", "user"):
        return jsonify({"ok": False, "msg": "角色非法"}), 400
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE phone=%s", (phone,))
            if cur.fetchone():
                return jsonify({"ok": False, "msg": "该手机号已存在"}), 400
            if not username:
                username = "user_" + "".join(random.choices(string.digits, k=6))
            try:
                cur.execute("INSERT INTO users (username, password_hash, role, phone) VALUES (%s,%s,%s,%s)",
                            (username, generate_password_hash(password), role, phone))
            except pymysql.err.IntegrityError:
                return jsonify({"ok": False, "msg": "用户名或手机号已存在"}), 400
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.put("/api/users/<int:uid>")
@admin_required
def update_user(uid):
    if uid == session.get("user_id"):
        return jsonify({"ok": False, "msg": "不能修改自己的账号"}), 400
    data = request.get_json(force=True)
    fields, vals = [], []
    if "role" in data:
        if data["role"] not in ("admin", "user"):
            return jsonify({"ok": False, "msg": "角色非法"}), 400
        fields.append("role=%s"); vals.append(data["role"])
    if "status" in data:
        if data["status"] not in ("active", "disabled"):
            return jsonify({"ok": False, "msg": "状态非法"}), 400
        fields.append("status=%s"); vals.append(data["status"])
    if not fields:
        return jsonify({"ok": True})
    fields.append("session_version = session_version + 1")
    vals.append(uid)
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE users SET {', '.join(fields)} WHERE id=%s", vals)
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


# ==================== 文章：新增/编辑 ====================
@app.post("/api/articles")
@admin_required
def create_article():
    data = request.get_json(force=True)
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"ok": False, "msg": "标题不能为空"}), 400
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO articles (title, summary, content, category, status, author) "
                "VALUES (%s,%s,%s,%s,%s,%s)",
                (title, data.get("summary",""), data.get("content",""),
                 data.get("category","综合"), data.get("status","published"),
                 session.get("username","admin")),
            )
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.put("/api/articles/<int:aid>")
@admin_required
def update_article(aid):
    data = request.get_json(force=True)
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE articles SET title=%s, summary=%s, content=%s, category=%s, status=%s, updated_at=NOW() WHERE id=%s",
                (data.get("title"), data.get("summary",""), data.get("content",""),
                 data.get("category","综合"), data.get("status","published"), aid),
            )
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


# ==================== 修改密码 ====================
@app.post("/api/change-username")
@login_required
def change_username():
    data = request.get_json(force=True)
    ok, msg = _check_captcha(data)
    if not ok:
        return jsonify({"ok": False, "msg": msg}), 400
    new_name = (data.get("new_username") or "").strip()
    if len(new_name) < 3 or len(new_name) > 20:
        return jsonify({"ok": False, "msg": "用户名需 3-20 位"}), 400
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE username=%s AND id<>%s",
                        (new_name, session["user_id"]))
            if cur.fetchone():
                return jsonify({"ok": False, "msg": "该用户名已被占用"}), 400
            cur.execute("UPDATE users SET username=%s WHERE id=%s",
                        (new_name, session["user_id"]))
        conn.commit()
        session["username"] = new_name
        return jsonify({"ok": True, "username": new_name})
    finally:
        conn.close()


@app.post("/api/change-password")
@login_required
def change_password():
    data = request.get_json(force=True)
    ok, msg = _check_captcha(data)
    if not ok:
        return jsonify({"ok": False, "msg": msg}), 400
    old = data.get("old_password") or ""
    new = data.get("new_password") or ""
    if len(new) < 6 or len(new) > 20:
        return jsonify({"ok": False, "msg": "新密码需 6-20 位"}), 400
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT password_hash FROM users WHERE id=%s", (session["user_id"],))
            row = cur.fetchone()
            if not row or not check_password_hash(row["password_hash"], old):
                return jsonify({"ok": False, "msg": "原密码不正确"}), 400
            cur.execute("UPDATE users SET password_hash=%s, session_version=session_version+1 WHERE id=%s",
                        (generate_password_hash(new), session["user_id"]))
            cur.execute("SELECT session_version FROM users WHERE id=%s", (session["user_id"],))
            new_sv = cur.fetchone()["session_version"]
        conn.commit()
        # session_version+1 会让本会话的 sv 失配 → 下个请求就被判 kicked 踢回登录页。
        # 这里把当前 session 的 sv 同步为新值：本人改密后无需重新登录（其他设备的旧会话仍被踢）。
        session["sv"] = new_sv
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.post("/api/change-phone")
@login_required
def change_phone():
    data = request.get_json(force=True)
    ok, msg = _check_captcha(data)
    if not ok:
        return jsonify({"ok": False, "msg": msg}), 400
    new_phone = (data.get("new_phone") or "").strip()
    if len(new_phone) != 11 or not new_phone.isdigit() or not new_phone.startswith("1"):
        return jsonify({"ok": False, "msg": "请输入正确的 11 位手机号"}), 400
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE phone=%s AND id<>%s",
                        (new_phone, session["user_id"]))
            if cur.fetchone():
                return jsonify({"ok": False, "msg": "该手机号已被其他账号使用"}), 400
            cur.execute("UPDATE users SET phone=%s WHERE id=%s",
                        (new_phone, session["user_id"]))
        conn.commit()
        return jsonify({"ok": True, "phone": new_phone})
    finally:
        conn.close()


@app.post("/api/arm/alarm-record")
@login_required
def arm_alarm_record():
    """「仅报警」动作的记录落库。

    与正常分拣记录同表（sort_records），区别：pick_success=0、place_area='alarm'，
    表示识别到但**没有执行抓取动作**。
    """
    data = request.get_json(force=True, silent=True) or {}
    defect_class = (data.get("defect_class") or "").strip()
    if not defect_class:
        return jsonify({"ok": False, "msg": "缺少类别"}), 400
    try:
        conf = float(data.get("confidence") or 0)
    except (TypeError, ValueError):
        conf = 0.0
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO sort_records "
                "(user_id, username, defect_class, confidence, place_area, pick_success, duration_ms, model_name) "
                "VALUES (%s, %s, %s, %s, 'alarm', 0, %s, %s)",
                (session.get("user_id", 1), session.get("username", "system"),
                 defect_class, round(conf, 4), 0, detector.current_file or ''))
        conn.commit()
    except Exception as e:
        logger.warning("报警记录写入失败: %s", e)
        return jsonify({"ok": False, "msg": "记录写入失败"}), 500
    finally:
        conn.close()
    return jsonify({"ok": True, "msg": "已记录"})


# 触发调优默认值（按模型存 users.trigger_arb_by_model，列名沿用"仲裁"但实际存调优参数）。
# 2026-10-21 深夜起仅剩仲裁帧数一项可调：防抖帧数改在前端写死 3 帧（js/app.js _IND_DEBOUNCE_FRAMES）、
# 失效时间写死 500ms（js/app.js _IND_EXPIRE_MS）——两者都不再开放调节（失效时间是"逐帧间隔"判定，
# 设得比帧间隔还小会全链路静默失效；防抖写死是为把参数面板精简成一个旋钮，降低使用门槛）。
# 仲裁有效取值只有 0（关闭）和 4~10：防抖写死 3 帧，"有效反超帧数 = 仲裁值 - 3"，
# 1/2 基本反超不了开窗后才出现的类别、3 零宽限，故不允许；默认 6（=3 帧反超宽限）。
_TUNING_DEFAULTS = {"arb_frames": 6}


def _read_tuning(entry):
    """把库里的调参条目规范成 {arb_frames}（仅剩仲裁一项可调）。

    - 兼容 2026-10-21 早先的旧形状 {frames: N}（那时只有仲裁帧数）；
    - 忽略已废弃的 debounce_frames / expire_ms：防抖帧数前端写死 3 帧、失效时间写死 500ms，
      库里遗留值读取时直接丢弃，下次保存时自然被清掉；
    - 有效取值只有 0（关闭）与 4~10：1/2/3 及越界值一律回落默认 6
      （防抖写死 3 帧，"有效反超帧数 = 仲裁值 - 3"，1/2 基本无效、3 零宽限）。
    """
    out = dict(_TUNING_DEFAULTS)
    if isinstance(entry, dict):
        e = dict(entry)
        if "arb_frames" not in e and "frames" in e:
            e["arb_frames"] = e.pop("frames")      # 旧形状兼容
        for k in out:
            if k in e:
                try:
                    out[k] = int(e[k])
                except (TypeError, ValueError):
                    pass
    _arb = out["arb_frames"]
    if _arb != 0 and not (4 <= _arb <= 10):
        out["arb_frames"] = 6                      # 1/2/3 及越界 → 默认 6
    return out


@app.get("/api/arm/class-trigger-rules")
@login_required
def arm_get_class_trigger_rules():
    """取当前模型的「类别触发规则」与规则模式。

    返回结构：{mode:'basic'|'advanced', rules:{类别:{priority,min_count,conf,cooldown,action}},
               tuning:{debounce_frames:N, expire_ms:MS, arb_frames:N}}
    basic=普通规则：选中类别中取置信度最高（并列比数量、再并列随机），rules 不参与判定
    advanced=高级规则：四道检查（资格→规则→优先级分组[同级置信度决胜]→兜底）
    tuning=触发调优（按模型记忆，前端弹窗可调，仅一项）：
      · arb_frames 仲裁窗帧数：首个合格类别出现后等待 N 帧再放行，期间后到的
        更高优先级（高级规则）/更高置信度（普通规则）类别可反超。有效取值 0（关闭）
        或 4~10——"有效反超帧数 = 仲裁值 - 3"（防抖写死 3 帧）；1/2/3 不允许，
        读取时一律规范为默认 6
    防抖帧数与计数失效时间已于 2026-10-21 深夜改为前端写死（3 帧 / 500ms，
    js/app.js _IND_DEBOUNCE_FRAMES / _IND_EXPIRE_MS），不再随本接口收发；
    库里遗留的 debounce_frames / expire_ms 读取时忽略、保存时自然清除。
    只返回【当前已选类别】的规则；未配置过的类别不出现（由前端按需补默认行）。
    """
    uid = session.get("user_id", 1)
    model_file = detector.current_file or ""
    rules = {}
    mode = "basic"
    tuning = dict(_TUNING_DEFAULTS)
    try:
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT class_trigger_by_model, trigger_mode_by_model,"
                            " trigger_arb_by_model FROM users WHERE id=%s", (uid,))
                row = cur.fetchone()
        finally:
            conn.close()
        if row:
            raw = row.get("class_trigger_by_model")
            if isinstance(raw, str):
                raw = json.loads(raw)
            rules = ((raw or {}).get(model_file)) or {}
            raw2 = row.get("trigger_mode_by_model")
            if isinstance(raw2, str):
                raw2 = json.loads(raw2)
            _m = (raw2 or {}).get(model_file)
            if _m in ("basic", "advanced"):
                mode = _m
            raw3 = row.get("trigger_arb_by_model")
            if isinstance(raw3, str):
                raw3 = json.loads(raw3)
            tuning = _read_tuning((raw3 or {}).get(model_file))
    except Exception as e:
        logger.debug("读取触发规则失败: %s", e)
    return jsonify({"ok": True, "model_file": model_file, "mode": mode,
                    "rules": rules, "tuning": tuning})


@app.post("/api/arm/class-trigger-rules")
@login_required
def arm_save_class_trigger_rules():
    """保存当前模型的「类别触发规则」与规则模式。

    入参：{mode:'basic'|'advanced', rules:{类别:{priority,min_count,conf,cooldown,action,follow}},
            tuning?:{arb_frames:N}}
    basic=普通规则：选中类别中取置信度最高（并列比目标数量、再并列随机），rules 保留但不参与判定
    advanced=高级规则：四道检查（资格[含跟随+两帧防抖]→规则→优先级分组[同级置信度决胜]→兜底）
    tuning=触发调优（按模型，可选字段，仅 arb_frames 一项）：以库里现值为基线，
    **只覆盖本次显式传来的字段**（缺项保留原值，不清零）；兜底默认：arb_frames=6。
    仲裁有效取值：0（关闭）或 4~10——"有效反超帧数 = 仲裁值 - 3"（防抖写死 3 帧），
    1/2 基本反超不了晚到的类别、3 零宽限，一律 400 拒绝。
    防抖帧数与失效时间均已废弃（前端写死 3 帧 / 500ms）：传了也忽略，遗留值保存时自然清除。
    **整个不传 tuning 则完全保留原值**（模式切换等接口只发 rules+mode，不能冲掉用户的调优设置）。
    校验：priority 为 1~99 整数，**允许重复**（同级按置信度决胜）；min_count 为 1~999 整数；
    conf 留空或 0.05~0.95；cooldown 为 0~86400 秒；action 仅允许 sort / alarm；
    follow 为跟随类别数组（可含未选中的模型类别，自动去重、剔除自身、上限 8 个）。
    """
    uid = session.get("user_id", 1)
    model_file = detector.current_file or ""
    data = request.get_json(force=True, silent=True) or {}
    rules = data.get("rules") or {}
    mode = (data.get("mode") or "basic").strip()
    if mode not in ("basic", "advanced"):
        return jsonify({"ok": False, "msg": "未知的规则模式"}), 400

    # 触发调优（可选）：先只校验显式传来的字段（范围/类型）；
    # 合并与落库在下方数据库事务里做（以库里现值为基线，缺项不清零）
    _t_over = {}
    if "tuning" in data:
        _t_in = data.get("tuning") or {}
        if "arb_frames" in _t_in:
                try:
                    _v = int(_t_in["arb_frames"])
                except (TypeError, ValueError):
                    return jsonify({"ok": False, "msg": "仲裁帧数只能是 0 或 4～10 之间的整数"}), 400
                if _v != 0 and (_v < 4 or _v > 10):
                    return jsonify({"ok": False, "msg": "仲裁帧数只能设 0（关闭）或 4～10（1～3 无效：防抖固定 3 帧，反超宽限为负或零）"}), 400
                _t_over["arb_frames"] = _v

    clean = {}
    for cls, cfg in (rules or {}).items():
        try:
            p = int(cfg.get("priority", 99))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "msg": "优先级必须是整数（%s）" % cls}), 400
        if p < 1 or p > 99:
            return jsonify({"ok": False, "msg": "优先级需在 1～99 之间（%s）" % cls}), 400
        act = (cfg.get("action") or "sort").strip()
        if act not in ("sort", "alarm"):
            return jsonify({"ok": False, "msg": "动作只能是分拣或仅报警（%s）" % cls}), 400
        try:
            mc = int(cfg.get("min_count", 1))
        except (TypeError, ValueError):
            mc = 1
        if mc < 1 or mc > 999:
            return jsonify({"ok": False, "msg": "最小数量需为 1～999 的整数（%s）" % cls}), 400
        try:
            conf = float(cfg.get("conf")) if cfg.get("conf") not in (None, "") else None
        except (TypeError, ValueError):
            conf = None
        if conf is not None and not (0.05 <= conf <= 0.95):
            return jsonify({"ok": False, "msg": "置信度门槛需在 0.05～0.95 之间（%s，留空=全局）" % cls}), 400
        try:
            cd = float(cfg.get("cooldown", 0) or 0)
        except (TypeError, ValueError):
            cd = 0.0
        if cd < 0 or cd > 86400:
            return jsonify({"ok": False, "msg": "冷却时间需为 0～86400 秒（%s）" % cls}), 400
        # follow：跟随类别列表（高级模式①资格门槛用）——本类须与其同时出现才参与判定。
        # 跟随类可以是模型支持的任意类别，不限于已选类别。
        follow_raw = cfg.get("follow")
        if follow_raw in (None, ""):
            follow = []
        elif isinstance(follow_raw, str):
            follow = [follow_raw]
        elif isinstance(follow_raw, (list, tuple)):
            follow = [str(x).strip() for x in follow_raw if str(x).strip()]
        else:
            return jsonify({"ok": False, "msg": "跟随类别格式不正确（%s）" % cls}), 400
        follow = [f for f in follow if f != cls]        # 不允许跟随自己（无意义）
        follow = list(dict.fromkeys(follow))[:8]        # 去重并限长
        clean[cls] = {"priority": p, "min_count": max(1, mc), "conf": conf,
                      "cooldown": max(0.0, cd), "action": act, "follow": follow}

    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT class_trigger_by_model, trigger_mode_by_model,"
                        " trigger_arb_by_model FROM users WHERE id=%s", (uid,))
            row = cur.fetchone()
            allm = {}
            if row and row.get("class_trigger_by_model"):
                raw = row["class_trigger_by_model"]
                if isinstance(raw, str):
                    raw = json.loads(raw)
                allm = raw or {}
            allm[model_file] = clean
            cur.execute("UPDATE users SET class_trigger_by_model=%s WHERE id=%s",
                        (json.dumps(allm, ensure_ascii=False), uid))
            # 规则模式同样按模型隔离（默认 basic=普通规则）；
            # 与 rules 一致无条件写入（model_file 为空时也用空串作 key，保证读写对称）
            mmap = {}
            if row and row.get("trigger_mode_by_model"):
                raw2 = row["trigger_mode_by_model"]
                if isinstance(raw2, str):
                    raw2 = json.loads(raw2)
                mmap = raw2 or {}
            mmap[model_file] = mode
            cur.execute("UPDATE users SET trigger_mode_by_model=%s WHERE id=%s",
                        (json.dumps(mmap, ensure_ascii=False), uid))
            # 触发调优（按模型）：带了该字段才写；返回值始终反映"最终生效值"。
            # 合并口径：以库里现值为基线，只覆盖本次显式传来的字段（缺项不清零）——
            # 模式切换等接口只发 rules+mode，不能把用户的调优设置冲掉
            amap = {}
            if row and row.get("trigger_arb_by_model"):
                raw3 = row["trigger_arb_by_model"]
                if isinstance(raw3, str):
                    raw3 = json.loads(raw3)
                amap = raw3 or {}
            tuning = _read_tuning(amap.get(model_file))
            if "tuning" in data:
                tuning.update(_t_over)
                amap[model_file] = tuning
                cur.execute("UPDATE users SET trigger_arb_by_model=%s WHERE id=%s",
                            (json.dumps(amap, ensure_ascii=False), uid))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "msg": "触发规则已保存", "saved": len(clean),
                    "rules": clean, "mode": mode, "model_file": model_file,
                    "tuning": tuning})


@app.post("/api/verify-password")
@login_required
def verify_password():
    data = request.get_json(force=True)
    pwd = (data.get("password") or "").strip()
    if not pwd:
        return jsonify({"ok": False, "msg": "请输入密码"}), 400
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT password_hash FROM users WHERE id=%s", (session["user_id"],))
            row = cur.fetchone()
    finally:
        conn.close()
    if not row or not check_password_hash(row["password_hash"], pwd):
        return jsonify({"ok": False, "msg": "密码错误"}), 400
    return jsonify({"ok": True})


@app.post("/api/update-bark")
@login_required
def update_bark():
    data = request.get_json(force=True)
    val = (data.get("bark_key") or "").strip()
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT bark_key FROM users WHERE id=%s", (session["user_id"],))
            existing = cur.fetchone()["bark_key"] or ""
            if not val:
                new_key = None                       # 清空 = 关闭推送
            elif "*" in val:
                new_key = existing                   # 前端回传的是掩码串 -> 视为未变更，保留原值
            else:
                new_key = _parse_bark_key(val)
                if not new_key:
                    return jsonify({"ok": False, "msg": "Bark Key 格式不正确"}), 400
            cur.execute("UPDATE users SET bark_key=%s WHERE id=%s",
                        (new_key, session["user_id"]))
        conn.commit()
        return jsonify({"ok": True, "bark_key": _mask_bark_key(new_key) if new_key else ""})
    finally:
        conn.close()


@app.post("/api/test-bark")
@login_required
def test_bark():
    data = request.get_json(force=True)
    raw = (data.get("bark_key") or "").strip()
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT bark_key FROM users WHERE id=%s", (session["user_id"],))
            existing = cur.fetchone()["bark_key"] or ""
    finally:
        conn.close()
    # 空或含 '*'（前端回传掩码串）-> 用库内已存 key 测；否则用新输入
    if not raw or "*" in raw:
        key = existing
        if not key:
            return jsonify({"ok": False, "msg": "请先配置 Bark Key 或输入新 Key 后测试"}), 400
    else:
        key = _parse_bark_key(raw)
        if not key:
            return jsonify({"ok": False, "msg": "Bark Key 格式不正确"}), 400
    # 测试推送必须同步，才能真实反馈 Key 是否有效；超时收紧到 4 秒，避免长时间占用请求线程
    try:
        t = urllib.parse.quote("测试推送")
        b = urllib.parse.quote("这是一条测试消息，如果您收到说明 Bark 配置成功！")
        url = "https://api.day.app/%s/%s/%s?group=test" % (key, t, b)
        urllib.request.urlopen(url, timeout=4)
    except Exception as e:
        return jsonify({"ok": False, "msg": "推送失败，请检查 Key 或网络（%s）" % str(e)[:50]}), 500
    return jsonify({"ok": True, "msg": "测试推送已发送，请查看 iPhone"})


# ==================== Bark 验证码登录 ====================
# ==================== 拓展模块权限 ====================
EXT_MODULES = {
    "industrial": {"name": "气泵吸盘机械臂", "desc": "Jibot1-STM32 舵机机械臂控制 · 视觉联动自动分拣", "icon": "robot"},
}

@app.get("/api/ext/modules")
@login_required
def ext_modules():
    is_admin = session.get("role") == "admin"
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            visible = {}
            for mod_key, mod in EXT_MODULES.items():
                if is_admin:
                    visible[mod_key] = mod
                else:
                    cur.execute("SELECT 1 FROM ext_module_access WHERE module_name=%s AND user_id=%s",
                                (mod_key, session["user_id"]))
                    if cur.fetchone():
                        visible[mod_key] = mod
            if is_admin:
                cur.execute("SELECT u.id, u.username, u.user_code, u.phone FROM users u WHERE u.role='user' ORDER BY u.id")
                users = cur.fetchall()
                cur.execute("SELECT module_name, user_id FROM ext_module_access")
                grants = {}
                for r in cur.fetchall():
                    grants.setdefault(r["module_name"], []).append(r["user_id"])
                return jsonify({"ok": True, "modules": visible, "users": users, "grants": grants})
            return jsonify({"ok": True, "modules": visible})
    finally:
        conn.close()

@app.post("/api/ext/access")
@admin_required
def ext_access():
    data = request.get_json(force=True)
    module = data.get("module", "")
    user_ids = data.get("user_ids", [])
    if module not in EXT_MODULES:
        return jsonify({"ok": False, "msg": "未知模块"}), 400
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM ext_module_access WHERE module_name=%s", (module,))
            for uid in user_ids:
                cur.execute("INSERT IGNORE INTO ext_module_access (module_name, user_id) VALUES (%s,%s)",
                            (module, uid))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})

# ==================== Bark 验证码登录 ====================
import urllib.request, urllib.parse, random as _rand, threading as _thread

BARK_CODES = {}  # {phone: {"code": "123456", "expires": ts, "sent_at": ts, "attempts": 0}}
_bark_lock = _thread.Lock()
PW_FAILS = {}    # {phone: {"fails": n, "locked_until": ts}}
_pw_lock = _thread.Lock()
PW_MAX_FAILS = 5
PW_LOCK_SECONDS = 600  # 10 分钟

def _send_bark_push(key, title, body, group="industrial_console"):
    """通过 Bark 推送通知（后台线程异步发送，不阻塞接口响应）"""
    if not key:
        return False
    def _do_push():
        try:
            t = urllib.parse.quote(title)
            b = urllib.parse.quote(body)
            url = "https://api.day.app/%s/%s/%s?group=%s" % (key, t, b, group)
            urllib.request.urlopen(url, timeout=8)
        except Exception as e:
            logger.warning("Bark push error: %s", e)
    _thread.Thread(target=_do_push, daemon=True).start()
    return True

@app.post("/api/send-bark-code")
def send_bark_code():
    data = request.get_json(force=True)
    phone = (data.get("phone") or "").strip()
    if len(phone) != 11 or not phone.isdigit() or not phone.startswith("1"):
        return jsonify({"ok": False, "msg": "请输入正确的 11 位手机号"}), 400
    now = time.time()
    with _bark_lock:
        existing = BARK_CODES.get(phone)
        if existing and (now - existing["sent_at"]) < 120:
            remain = int(120 - (now - existing["sent_at"]))
            return jsonify({"ok": False, "msg": "发送太频繁，请 %d 秒后再试" % remain}), 429
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            # 不带 status 条件查询：以便把「未注册」与「已被禁用」区分开提示，
            # 而不是笼统地报一句"未注册或已被禁用"
            cur.execute("SELECT id, username, status, bark_key FROM users WHERE phone=%s", (phone,))
            row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        return jsonify({"ok": False, "msg": "该手机号未注册，请先注册"}), 404
    if row.get("status") == "disabled":
        return jsonify({"ok": False, "msg": "账号已被禁用，请联系管理员"}), 403
    if not row.get("bark_key"):
        return jsonify({"ok": False, "msg": "该账号未配置 Bark 推送，请使用密码登录或先在个人中心配置 Bark"}), 400
    code = "%06d" % _rand.randint(0, 999999)
    pushed = _send_bark_push(row["bark_key"], "【bark登录验证码】", "您的登录验证码是 %s，5 分钟内有效，如非本人操作，请忽略。" % code)
    if not pushed:
        return jsonify({"ok": False, "msg": "Bark 推送失败，请检查网络或 Bark Key 是否正确"}), 500
    with _bark_lock:
        BARK_CODES[phone] = {"code": code, "expires": now + 300, "sent_at": now, "attempts": 0}
    return jsonify({"ok": True, "msg": "验证码已发送到您的 Bark"})

@app.post("/api/login-with-code")
def login_with_code():
    data = request.get_json(force=True)
    phone = (data.get("phone") or "").strip()
    code = (data.get("code") or "").strip()
    if not phone or not code:
        return jsonify({"ok": False, "msg": "请输入手机号和验证码"}), 400
    now = time.time()
    with _bark_lock:
        rec = BARK_CODES.get(phone)
        if not rec:
            return jsonify({"ok": False, "msg": "请先发送验证码"}), 400
        if now > rec["expires"]:
            del BARK_CODES[phone]
            return jsonify({"ok": False, "msg": "验证码已过期，请重新发送"}), 400
        if code != rec["code"]:
            rec["attempts"] += 1
            if rec["attempts"] >= 5:
                del BARK_CODES[phone]
                return jsonify({"ok": False, "msg": "验证码错误次数过多，已作废，请重新发送"}), 401
            return jsonify({"ok": False, "msg": "验证码错误，还可尝试 %d 次" % (5 - rec["attempts"])}), 401
        del BARK_CODES[phone]
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE phone=%s", (phone,))
            row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        return jsonify({"ok": False, "msg": "账号不存在"}), 404
    if row.get("status") == "disabled":
        return jsonify({"ok": False, "msg": "账号已被禁用，请联系管理员"}), 403
    session["user_id"] = row["id"]
    session["username"] = row["username"]
    session["role"] = row["role"]
    session["login_ts"] = now      # 首次登录时刻：绝对上限（30 天）的锚点，不随续期滚动
    session["last_active"] = now   # 滑动续期的锚点，每次认证请求顺延
    session["sv"] = row["session_version"] or 0
    session.permanent = True
    # 注：cookie 有效期统一由 app.config["PERMANENT_SESSION_LIFETIME"]（30 天）控制。
    ONLINE_MAP[row["id"]] = {"ts": now, "device": _parse_device()}
    return jsonify({"ok": True, "user": _user_dict(row)})




# ==================== 用户反馈 ====================
FEEDBACK_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "feedback")
os.makedirs(FEEDBACK_UPLOAD_DIR, exist_ok=True)

@app.post("/api/feedback")
@login_required
def submit_feedback():
    data = request.get_json(force=True)
    category = (data.get("category") or "usage").strip()
    title = (data.get("title") or "").strip()
    content = (data.get("content") or "").strip()
    images = data.get("images") or []
    notify_admin = 1 if data.get("notify_admin") else 0
    if not title:
        return jsonify({"ok": False, "msg": "请填写标题"}), 400
    if len(title) > 200:
        return jsonify({"ok": False, "msg": "标题过长"}), 400
    if category not in ("bug", "feature", "usage", "other"):
        category = "usage"
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO feedbacks (user_id, username, category, title, content, images, notify_admin) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (session["user_id"], session.get("username", ""), category, title, content,
                 ",".join(images), notify_admin),
            )
            fid = cur.lastrowid
        conn.commit()
    finally:
        conn.close()
    # 如果勾选了通知管理员，推送 Bark
    bark_result = ""
    if notify_admin:
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT username, bark_key FROM users WHERE role='admin' AND bark_key IS NOT NULL AND bark_key<>''")
                admins = cur.fetchall()
        finally:
            conn.close()
        if not admins:
            bark_result = "提交成功，但所有管理员均未配置 Bark，无法实时通知"
        else:
            sent = 0
            cat_text = {"bug":"功能异常","feature":"功能建议","usage":"使用问题","other":"其他"}.get(category, category)
            content_preview = (content[:80] + "...") if len(content) > 80 else content
            push_body = "用户：%s\n类型：%s\n标题：%s\n详情：%s" % (session.get("username",""), cat_text, title, content_preview or "（无描述）")
            for a in admins:
                if _send_bark_push(a["bark_key"], "新反馈待处理", push_body, group="industrial_console"):
                    sent += 1
            bark_result = "提交成功，已通知 %d 位管理员" % sent
    else:
        bark_result = "提交成功"
    return jsonify({"ok": True, "id": fid, "msg": bark_result})

@app.get("/api/feedback/mine")
@login_required
def my_feedback():
    cat = (request.args.get("category") or "").strip()
    kw = (request.args.get("kw") or "").strip()
    page, limit, offset = _paging()
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            ands = ["f.user_id=%s"]
            params = [session["user_id"]]
            if cat:
                ands.append("f.category=%s")
                params.append(cat)
            if kw:
                ands.append("(f.title LIKE %s OR f.content LIKE %s)")
                like = "%" + kw + "%"
                params.extend([like, like])
            wsql = " WHERE " + " AND ".join(ands)
            cur.execute("SELECT COUNT(*) AS c FROM feedbacks f" + wsql, params)
            total = cur.fetchone()["c"]
            cur.execute(
                "SELECT f.* FROM feedbacks f" + wsql +
                " ORDER BY f.created_at DESC LIMIT %s OFFSET %s",
                params + [limit, offset])
            rows = cur.fetchall()
            for r in rows:
                ur = r.get("user_read_at")
                ra = r.get("replied_at")
                try:
                    r["has_new_reply"] = bool(ra and (ur is None or ra > ur))
                except Exception:
                    r["has_new_reply"] = False
    finally:
        conn.close()
    return jsonify({"ok": True, "feedbacks": rows, "total": total,
                    "page": page, "limit": limit})

@app.get("/api/feedback")
@admin_required
def list_feedback():
    status_filter = request.args.get("status", "")
    kw = request.args.get("kw", "").strip()
    page, limit, offset = _paging()
    ands = []
    params = []
    if status_filter:
        ands.append("f.status=%s")
        params.append(status_filter)
    if kw:
        ands.append("(f.title LIKE %s OR f.username LIKE %s OR f.content LIKE %s OR u.phone LIKE %s OR u.user_code LIKE %s)")
        like = "%" + kw + "%"
        params.extend([like, like, like, like, like])
    wsql = (" WHERE 1=1 AND " + " AND ".join(ands)) if ands else " WHERE 1=1"
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS c FROM feedbacks f LEFT JOIN users u ON f.user_id=u.id" + wsql, params)
            total = cur.fetchone()["c"]
            sql = ("SELECT f.*, u.user_code AS user_code, u.phone AS user_phone "
                   "FROM feedbacks f LEFT JOIN users u ON f.user_id=u.id" + wsql +
                   " ORDER BY f.created_at DESC LIMIT %s OFFSET %s")
            cur.execute(sql, params + [limit, offset])
            rows = cur.fetchall()
            for r in rows:
                ur = r.get("user_read_at")
                ar = r.get("admin_read_at")
                ra = r.get("replied_at")
                try:
                    r["has_new_reply"] = bool(ra and (ur is None or ra > ur))
                    r["has_new_msg"] = (ar is None)
                except Exception:
                    r["has_new_reply"] = False
                    r["has_new_msg"] = False
    finally:
        conn.close()
    return jsonify({"ok": True, "feedbacks": rows, "total": total,
                    "page": page, "limit": limit})

@app.put("/api/feedback/<int:fid>")
@admin_required
def reply_feedback(fid):
    data = request.get_json(force=True)
    reply = (data.get("reply") or "").strip()
    status = (data.get("status") or "").strip()
    notify_user = 1 if data.get("notify_user") else 0
    if status and status not in ("pending", "processing", "resolved", "closed"):
        return jsonify({"ok": False, "msg": "状态非法"}), 400
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT user_id, username, title FROM feedbacks WHERE id=%s", (fid,))
            fb = cur.fetchone()
            if not fb:
                return jsonify({"ok": False, "msg": "反馈不存在"}), 404
            cur.execute("UPDATE feedbacks SET reply=%s, status=%s, replied_by=%s, replied_at=NOW() WHERE id=%s",
                        (reply, status or "resolved", session.get("username", ""), fid))
        conn.commit()
    finally:
        conn.close()
    bark_result = ""
    if notify_user:
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT bark_key FROM users WHERE id=%s", (fb["user_id"],))
                u = cur.fetchone()
        finally:
            conn.close()
        if not u or not u.get("bark_key"):
            bark_result = "回复已保存，但该用户未配置 Bark，推送未发送"
        else:
            reply_preview = (reply[:100] + "...") if len(reply) > 100 else reply
            st_map = {"pending":"待处理","processing":"处理中","resolved":"已解决","closed":"已关闭"}
            st_text = st_map.get(status or "resolved", "已解决")
            push_body = "反馈标题：%s\n当前状态：%s\n管理员回复：%s" % (fb["title"], st_text, reply_preview or "（已更新状态，请登录查看）")
            if _send_bark_push(u["bark_key"], "您的反馈有新回复", push_body, group="industrial_console"):
                bark_result = "回复已保存，并已通知用户"
            else:
                bark_result = "回复已保存，但推送失败"
    else:
        bark_result = "回复已保存"
    return jsonify({"ok": True, "msg": bark_result})

@app.delete("/api/feedback/<int:fid>")
@login_required
def delete_feedback(fid):
    conn = db.get_db()
    img_urls = []
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT user_id, images FROM feedbacks WHERE id=%s", (fid,))
            fb = cur.fetchone()
            if not fb:
                return jsonify({"ok": False, "msg": "反馈不存在"}), 404
            if fb["user_id"] != session["user_id"]:
                return jsonify({"ok": False, "msg": "只能删除自己的反馈"}), 403
            if fb.get("images"):
                img_urls.extend([u for u in fb["images"].split(",") if u])
            cur.execute("SELECT images FROM feedback_messages WHERE feedback_id=%s", (fid,))
            for row in cur.fetchall():
                if row.get("images"):
                    img_urls.extend([u for u in row["images"].split(",") if u])
            cur.execute("DELETE FROM feedback_messages WHERE feedback_id=%s", (fid,))
            cur.execute("DELETE FROM feedbacks WHERE id=%s", (fid,))
        conn.commit()
    finally:
        conn.close()
    # 删除本地图片文件
    for url in img_urls:
        try:
            rel = url.split("/uploads/feedback/")[-1]
            fpath = os.path.join(FEEDBACK_UPLOAD_DIR, rel.replace("/", os.sep))
            if os.path.isfile(fpath):
                os.remove(fpath)
        except Exception as e:
            logger.debug("[feedback] 删除反馈图片失败（可能已不存在）: %s", e)
    return jsonify({"ok": True})

@app.post("/api/feedback/upload")
@login_required
def upload_feedback_img():
    if "file" not in request.files:
        return jsonify({"ok": False, "msg": "无文件"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"ok": False, "msg": "未选择文件"}), 400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
        return jsonify({"ok": False, "msg": "仅支持 jpg/png/gif/webp"}), 400
    data = f.read()
    # 单张图片独立上限（与检测图片一致，防止解码 OOM）
    if len(data) > MAX_IMAGE_MB * 1024 * 1024:
        return jsonify({"ok": False, "msg": f"图片过大，单张不能超过 {MAX_IMAGE_MB} MB"}), 400
    uid = session["user_id"]
    user_dir = os.path.join(FEEDBACK_UPLOAD_DIR, str(uid))
    os.makedirs(user_dir, exist_ok=True)
    fname = "fb_%d_%s%s" % (uid, uuid.uuid4().hex[:8], ext)
    with open(os.path.join(user_dir, fname), "wb") as _fp:
        _fp.write(data)
    return jsonify({"ok": True, "url": "/uploads/feedback/%d/%s" % (uid, fname)})


@app.get("/api/feedback/<int:fid>/messages")
@login_required
def feedback_messages(fid):
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT user_id FROM feedbacks WHERE id=%s", (fid,))
            fb = cur.fetchone()
            if not fb:
                return jsonify({"ok": False, "msg": "反馈不存在"}), 404
            is_admin = session.get("role") == "admin"
            if not is_admin and fb["user_id"] != session["user_id"]:
                return jsonify({"ok": False, "msg": "无权查看"}), 403
            cur.execute("""SELECT m.*, u.username AS sender_name, u.user_code AS sender_code
                FROM feedback_messages m LEFT JOIN users u ON m.sender_id=u.id
                WHERE m.feedback_id=%s ORDER BY m.created_at ASC""", (fid,))
            msgs = cur.fetchall()
    finally:
        conn.close()
    return jsonify({"ok": True, "messages": msgs})


@app.post("/api/feedback/<int:fid>/message")
@login_required
def feedback_add_message(fid):
    data = request.get_json(force=True)
    content = (data.get("content") or "").strip()
    images = data.get("images") or []
    notify = 1 if data.get("notify") else 0
    is_admin = session.get("role") == "admin"
    sender = "admin" if is_admin else "user"
    if not content and not images:
        return jsonify({"ok": False, "msg": "请输入内容或上传图片"}), 400
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT user_id, username, title, status FROM feedbacks WHERE id=%s", (fid,))
            fb = cur.fetchone()
            if not fb:
                return jsonify({"ok": False, "msg": "反馈不存在"}), 404
            if not is_admin and fb["user_id"] != session["user_id"]:
                return jsonify({"ok": False, "msg": "无权操作"}), 403
            cur.execute("INSERT INTO feedback_messages (feedback_id, sender, sender_id, content, images) VALUES (%s,%s,%s,%s,%s)",
                        (fid, sender, session["user_id"], content, ",".join(images)))
            mid = cur.lastrowid
            if is_admin:
                cur.execute("UPDATE feedbacks SET reply=%s, replied_by=%s, replied_at=NOW(), status=%s, user_read_at=NULL WHERE id=%s",
                            (content or "（图片回复）", session.get("username",""), data.get("status","resolved"), fid))
            else:
                cur.execute("UPDATE feedbacks SET status='processing', updated_at=NOW(), admin_read_at=NULL, user_read_at=NOW() WHERE id=%s", (fid,))
        conn.commit()
    finally:
        conn.close()
    bark_msg = ""
    if notify:
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                if is_admin:
                    cur.execute("SELECT bark_key FROM users WHERE id=%s", (fb["user_id"],))
                    u = cur.fetchone()
                    target_key = u["bark_key"] if u else None
                    push_title = "您的反馈有新回复"
                    push_body = "反馈标题：%s\n管理员回复：%s" % (fb["title"], content[:100] or "（图片）")
                else:
                    cur.execute("SELECT username, bark_key FROM users WHERE role='admin' AND bark_key IS NOT NULL AND bark_key<>''")
                    admins = cur.fetchall()
                    target_key = None
                    push_title = "反馈有新补充"
                    push_body = "用户：%s\n反馈：%s\n补充：%s" % (fb["username"], fb["title"], content[:100] or "（图片）")
        finally:
            conn.close()
        if is_admin:
            if target_key:
                _send_bark_push(target_key, push_title, push_body, group="industrial_console")
                bark_msg = "已发送并通知用户"
            else:
                bark_msg = "已发送，该用户未配置 Bark"
        else:
            sent = sum(1 for a in (admins or []) if _send_bark_push(a["bark_key"], push_title, push_body, group="industrial_console"))
            bark_msg = "已发送，通知了 %d 位管理员" % sent if sent else "已发送，管理员未配置 Bark"
    else:
        bark_msg = "发送成功"
    return jsonify({"ok": True, "msg": bark_msg})

@app.post("/api/feedback/<int:fid>/read")
@login_required
def feedback_mark_read(fid):
    is_admin = session.get("role") == "admin"
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            if is_admin:
                cur.execute("UPDATE feedbacks SET admin_read_at=NOW(), updated_at=updated_at WHERE id=%s", (fid,))
            else:
                cur.execute("UPDATE feedbacks SET user_read_at=NOW(), updated_at=updated_at WHERE id=%s AND user_id=%s", (fid, session["user_id"]))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})

# ==================== 启动 ====================
# ==================== 模型训练 ====================
import trainer
from config import REPORTS_DIR


@app.get("/api/train/device")
@admin_required
def train_device():
    return jsonify({"ok": True, "device": trainer.detect_device()})


@app.get("/api/train/datasets")
@admin_required
def train_datasets():
    from config import DATASETS_DIR
    return jsonify({"ok": True, "datasets": trainer.scan_datasets(), "datasets_dir": DATASETS_DIR})


@app.post("/api/train/datasets/split")
@admin_required
def train_split_dataset():
    """自动划分「平铺式」数据集（images/ + labels/ 未分 train/val）。

    参数：name 数据集名；val_ratio 验证集占比(0.05~0.5)；mode copy|move；seed 随机种子。
    """
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        return jsonify({"ok": False, "msg": "数据集名称不合法"}), 400
    stats, err = trainer.split_dataset(
        name,
        val_ratio=data.get("val_ratio", 0.2),
        mode=data.get("mode", "copy"),
        seed=data.get("seed", 42),
    )
    if err:
        return jsonify({"ok": False, "msg": err}), 400
    return jsonify({"ok": True, "msg": "划分完成", "stats": stats})


@app.get("/api/train/backbones/latest")
@admin_required
def train_backbones_latest():
    """查询官方最新 Release 里可下载的预训练权重（默认当前主力系列的检测+姿态）。"""
    info, err = trainer.fetch_latest_weights_info(
        series=request.args.get("series") or None)
    if err:
        return jsonify({"ok": False, "msg": err}), 400
    return jsonify({"ok": True, **info})


@app.post("/api/train/backbones/fetch")
@admin_required
def train_backbones_fetch():
    """后台下载指定权重到 pretrained_models（不阻塞服务，进度另查）。"""
    data = request.get_json(force=True, silent=True) or {}
    names = data.get("names") or []
    ok, err = trainer.start_fetch_weights(names)
    if err:
        return jsonify({"ok": False, "msg": err}), 400
    return jsonify({"ok": True, "msg": "已开始下载"})


@app.get("/api/train/backbones/fetch-status")
@admin_required
def train_backbones_fetch_status():
    return jsonify({"ok": True, "status": trainer.fetch_weights_status()})


@app.get("/api/train/backbones")
@admin_required
def train_backbones():
    from config import PRETRAINED_DIR
    return jsonify({"ok": True, "backbones": trainer.scan_backbones(), "backbones_dir": PRETRAINED_DIR})


@app.post("/api/train/open-dir")
@admin_required
def train_open_dir():
    return jsonify({"ok": trainer.open_datasets_dir()})


@app.post("/api/train/open-backbone-dir")
@admin_required
def train_open_backbone_dir():
    return jsonify({"ok": trainer.open_backbones_dir()})


@app.post("/api/train/jobs")
@admin_required
def train_create_job():
    data = request.get_json(force=True, silent=True) or request.form
    name, err = trainer.start_job(data, session.get("username"))
    if err:
        return jsonify({"ok": False, "msg": err}), 400
    return jsonify({"ok": True, "job_name": name})


@app.get("/api/train/jobs")
@admin_required
def train_list_jobs():
    return jsonify({"ok": True, "jobs": trainer.list_jobs()})


@app.get("/api/train/jobs/<job_name>")
@admin_required
def train_job_detail(job_name):
    d = trainer.job_detail(job_name)
    if not d:
        return jsonify({"ok": False, "msg": "任务不存在"}), 404
    return jsonify({"ok": True, "job": d})


@app.post("/api/train/jobs/<job_name>/stop")
@admin_required
def train_stop(job_name):
    data = request.get_json(force=True, silent=True) or {}
    mode = data.get("mode", "finish")
    ok, err = trainer.request_stop(job_name, mode)
    if not ok:
        return jsonify({"ok": False, "msg": err}), 400
    return jsonify({"ok": True})


@app.post("/api/train/jobs/<job_name>/resume")
@admin_required
def train_resume(job_name):
    name, err = trainer.resume_job(job_name)
    if err:
        return jsonify({"ok": False, "msg": err}), 400
    return jsonify({"ok": True, "job_name": name})


@app.delete("/api/train/jobs/<job_name>")
@admin_required
def train_delete(job_name):
    if not trainer._safe_job_name(job_name):
        return jsonify({"ok": False, "msg": "任务名不合法"}), 400
    # 删除前先记下该任务是否已产出并入库模型，用于提示用户去模型页单独处理
    archived = None
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT model_id, model_file FROM training_jobs WHERE job_name=%s", (job_name,))
            row = cur.fetchone()
        if row and (row.get("model_file") or row.get("model_id")):
            archived = {"model_id": row.get("model_id"), "model_file": row.get("model_file") or ""}
    finally:
        conn.close()

    ok, err = trainer.delete_job(job_name)
    if not ok:
        return jsonify({"ok": False, "msg": err}), 400
    resp = {"ok": True}
    if archived:
        resp["archived_model"] = archived
        resp["msg"] = ("训练任务已删除；该任务产出的模型已存入模型库，"
                       "如需一并删除请到「模型管理」页面操作")
    return jsonify(resp)


@app.get("/api/train/jobs/<job_name>/report")
@admin_required
def train_report(job_name):
    # 任务名白名单校验，避免路径穿越
    if not trainer._safe_job_name(job_name):
        return jsonify({"ok": False, "msg": "任务名不合法"}), 400
    rp = os.path.join(REPORTS_DIR, job_name + ".html")
    if not os.path.isfile(rp):
        return jsonify({"ok": False, "msg": "报告不存在"}), 404
    return send_from_directory(REPORTS_DIR, job_name + ".html")


@app.post("/api/train/jobs/<job_name>/export")
@admin_required
def train_export(job_name):
    data = request.get_json(silent=True) or {}
    fmt = (data.get("format") or "").strip()
    result, err = trainer.export_model(job_name, fmt)
    if err:
        return jsonify({"ok": False, "msg": err}), 400
    return jsonify({"ok": True, **result})


@app.get("/api/train/lock-status")
@login_required
def train_lock_status():
    return jsonify({"ok": True, **trainer.lock_status()})



# ==================== 工业设备物理控制（机械臂） ====================
from arm_controller import arm, list_serial_ports, POSE_LABELS
from sorter import sorter
from action_group import action_groups


@app.get("/api/arm/ports")
@login_required
def arm_ports():
    if not _has_industrial_access(session.get('user_id')):
        return jsonify({"ok": False, "msg": "无工业控制模块权限"}), 403
    return jsonify({"ok": True, "ports": list_serial_ports()})


@app.post("/api/arm/page/enter")
@login_required
def arm_page_enter():
    data = request.get_json(force=True, silent=True) or {}
    uid = session.get('user_id')
    uname = session.get('username')
    did = data.get('device_id') or ''
    ok, msg, owner = arm.page_enter(uid, uname, did)
    return jsonify({"ok": ok, "msg": msg, "owner": owner})

@app.post("/api/arm/page/heartbeat")
@login_required
def arm_page_heartbeat():
    uid = session.get('user_id')
    role = session.get('role')
    if role != 'admin':
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM ext_module_access WHERE module_name='industrial' AND user_id=%s", (uid,))
                if not cur.fetchone():
                    arm.page_leave(uid)
                    return jsonify({"ok": False, "msg": "权限已被撤销"}), 403
        finally:
            conn.close()
    ok = arm.page_heartbeat(uid)
    return jsonify({"ok": ok})

@app.post("/api/arm/page/leave")
@login_required
def arm_page_leave():
    uid = session.get('user_id')
    arm.page_leave(uid)
    return jsonify({"ok": True})

@app.get("/api/arm/status")
@login_required
def arm_status():
    if not _has_industrial_access(session.get('user_id')):
        return jsonify({"ok": False, "msg": "无工业控制模块权限"}), 403
    if arm.connected:
        arm.check_connection()
    st = arm.get_status()
    # 行程模式按用户返回各自的偏好（覆盖 get_status 里的全局默认值）
    uid = session.get('user_id')
    st['via_home'] = arm.get_via_home(uid)
    # 姿态标定/放置位均按用户隔离（各人各一套）
    mode = _arm_mode(uid)
    st['mode'] = mode
    st['poses'] = arm.list_poses_status(uid)
    st['run'] = action_groups.get_status()
    st['page_lock'] = arm.page_lock_info()
    return jsonify({"ok": True, **st})


@app.post("/api/arm/connect")
@arm_page_lock_required
@login_required
def arm_connect():
    data = request.get_json(force=True, silent=True) or {}
    port = (data.get("port") or "").strip()
    if not port:
        return jsonify({"ok": False, "msg": "请选择串口号"}), 400
    baudrate = int(data.get("baudrate", 115200))
    ok, msg = arm.connect(port, baudrate)
    if ok:
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM arm_config WHERE id=1")
                if cur.fetchone():
                    cur.execute("UPDATE arm_config SET serial_port=%s, baudrate=%s WHERE id=1", (port, baudrate))
                else:
                    cur.execute("INSERT INTO arm_config (id, serial_port, baudrate) VALUES (1,%s,%s)", (port, baudrate))
            conn.commit()
        finally:
            conn.close()
    return jsonify({"ok": ok, "msg": msg})


@app.post("/api/arm/disconnect")
@arm_page_lock_required
@login_required
def arm_disconnect():
    arm.disconnect()
    return jsonify({"ok": True, "msg": "已断开"})


@app.post("/api/arm/move")
@arm_page_lock_required
@login_required
def arm_move():
    if not arm.connected:
        return jsonify({"ok": False, "msg": "机械臂未连接"}), 400
    if arm.busy:
        return jsonify({"ok": False, "msg": "机械臂正忙，请稍候"}), 400
    data = request.get_json(force=True, silent=True) or {}
    servo_id = int(data.get("servo_id", 0))
    pwm = int(data.get("pwm", 1500))
    duration = int(data.get("duration", 800))
    try:
        arm.move_servo(servo_id, pwm, duration)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "msg": str(e)}), 500


@app.post("/api/arm/move-batch")
@arm_page_lock_required
@login_required
def arm_move_batch():
    if not arm.connected:
        return jsonify({"ok": False, "msg": "机械臂未连接"}), 400
    if arm.busy:
        return jsonify({"ok": False, "msg": "机械臂正忙，请稍候"}), 400
    data = request.get_json(force=True, silent=True) or {}
    servos = data.get("servos") or {}
    duration = int(data.get("duration", 1000))
    if not servos:
        return jsonify({"ok": False, "msg": "servos 不能为空"}), 400
    try:
        arm.move_servos({int(k): int(v) for k, v in servos.items()}, duration)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "msg": str(e)}), 500


@app.post("/api/arm/stop")
@arm_page_lock_required
@login_required
def arm_stop():
    if not arm.connected:
        return jsonify({"ok": False, "msg": "机械臂未连接"}), 400
    try:
        arm.stop_all()
        # 同时中止可能正在运行的动作组（高级模式）
        action_groups.stop()
        return jsonify({"ok": True, "msg": "已急停"})
    except Exception as e:
        return jsonify({"ok": False, "msg": str(e)}), 500


@app.post("/api/arm/pump")
@arm_page_lock_required
@login_required
def arm_pump():
    if not arm.connected:
        return jsonify({"ok": False, "msg": "机械臂未连接"}), 400
    data = request.get_json(force=True, silent=True) or {}
    action = (data.get("action") or "").strip()
    try:
        if action == "suck":
            arm.pump_suck()
            return jsonify({"ok": True, "msg": "气泵吸气"})
        elif action == "release":
            arm.pump_release()
            return jsonify({"ok": True, "msg": "气泵已放气并停止", "state": "off"})
        elif action == "off":
            arm.pump_off()
            return jsonify({"ok": True, "msg": "气泵停止"})
        else:
            return jsonify({"ok": False, "msg": "未知 action"}), 400
    except Exception as e:
        return jsonify({"ok": False, "msg": str(e)}), 500


@app.post("/api/arm/pose/save")
@arm_page_lock_required
@login_required
def arm_pose_save():
    if not arm.connected:
        return jsonify({"ok": False, "msg": "机械臂未连接"}), 400
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    # 按当前用户保存（各人一套）
    uid = session.get('user_id')
    ok, msg = arm.save_pose(name, user_id=uid)
    return jsonify({"ok": ok, "msg": msg})


@app.get("/api/arm/pose/list")
@login_required
def arm_pose_list():
    if not _has_industrial_access(session.get('user_id')):
        return jsonify({"ok": False, "msg": "无工业控制模块权限"}), 403
    uid = session.get('user_id')
    return jsonify({"ok": True,
                    "poses": arm.list_poses_status(uid),
                    "mode": _arm_mode(uid)})


@app.post("/api/arm/pose/goto")
@arm_page_lock_required
@login_required
def arm_pose_goto():
    if not arm.connected:
        return jsonify({"ok": False, "msg": "机械臂未连接"}), 400
    if arm.busy:
        return jsonify({"ok": False, "msg": "机械臂正忙，请稍候"}), 400
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    # 前端不传 duration 时按位移自动计算时长；显式传值则照用（向后兼容）
    raw_dur = data.get("duration")
    duration = int(raw_dur) if raw_dur not in (None, "", 0) else None
    uid = session.get('user_id')
    # 行程（经原点/直达）取当前登录用户的个人偏好
    via_home = arm.get_via_home(uid)
    mode = _arm_mode(uid)
    ok, msg = arm.goto_pose(name, duration, via_home=via_home, user_id=uid)
    return jsonify({"ok": ok, "msg": msg})


@app.post("/api/arm/point/goto")
@arm_page_lock_required
@login_required
def arm_point_goto():
    """编辑器画布上「途经点」卡片的单步执行。

    与 /api/arm/pose/goto 一样读取当前用户的行程偏好（经原点/直达），
    因此单步执行同样受「近远点/直达」开关控制。
    """
    if not arm.connected:
        return jsonify({"ok": False, "msg": "机械臂未连接"}), 400
    if arm.busy:
        return jsonify({"ok": False, "msg": "机械臂正忙，请稍候"}), 400
    data = request.get_json(force=True, silent=True) or {}
    raw = data.get("servos") or {}
    try:
        servos = {int(k): int(v) for k, v in raw.items() if int(k) < 5}
    except (TypeError, ValueError):
        return jsonify({"ok": False, "msg": "servos 格式错误"}), 400
    if not servos:
        return jsonify({"ok": False, "msg": "点位数据为空"}), 400
    uid = session.get('user_id')
    ok, msg = arm.goto_point(servos, via_home=arm.get_via_home(uid),
                             user_id=uid, mode=_arm_mode(uid))
    return jsonify({"ok": ok, "msg": msg})


@app.post("/api/arm/via-home")
@login_required
def arm_set_via_home():
    """设置去姿态行程模式：经原点过渡 / 直达。

    按用户隔离：只改当前登录用户自己的偏好（users.arm_via_home），不影响他人。
    手动点姿态按钮与自动分拣都经由 arm.goto_pose()，故对两者同时生效。
    """
    data = request.get_json(force=True, silent=True) or {}
    enabled = data.get("enabled", True)
    user_id = session.get('user_id')
    ok, msg = arm.set_via_home(bool(enabled), user_id)
    return jsonify({"ok": ok, "msg": msg, "via_home": arm.get_via_home(user_id)})


@app.get("/api/arm/pose/read")
@login_required
def arm_pose_read():
    """从硬件回读 5 路运动关节当前 PWM，供前端滑块实时跟随姿态。

    运动中（busy）不回读：会得到中间值且串口读写干扰动作时序。
    """
    if not arm.connected:
        return jsonify({"ok": False, "msg": "机械臂未连接"}), 400
    if arm.busy:
        return jsonify({"ok": False, "msg": "机械臂运动中，跳过回读"}), 400
    pose = arm.read_current_pose()
    return jsonify({"ok": True, "pose": pose})


# ==================== 自定义动作组（高级行程模式） ====================

def _require_industrial():
    """工控模块权限校验。返回 (ok, err_response)；ok 为 False 时直接 return err_response。"""
    if not _has_industrial_access(session.get('user_id')):
        return False, (jsonify({"ok": False, "msg": "无工业控制模块权限"}), 403)
    return True, None


def _arm_mode(user_id):
    """当前用户的行程模式：'advanced'（高级·动作组）或 'normal'（普通）。"""
    try:
        cfg = db.ensure_user_arm_config(user_id)
        return 'advanced' if cfg.get('advanced_mode') else 'normal'
    except Exception as e:
        logger.debug("[arm] 读取用户模式失败，按普通模式处理: %s", e)
        return 'normal'


def _save_user_json_cfg(user_id, column, value):
    """写入用户级 JSON 配置列。column 为代码内字面量（非用户输入）。"""
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET %s=%%s WHERE id=%%s" % column,
                        (json.dumps(value, ensure_ascii=False), user_id))
        conn.commit()
    finally:
        conn.close()


# ---------- 途经点卡片 ----------

@app.get("/api/arm/waypoints")
@login_required
def arm_waypoints_list():
    ok, err = _require_industrial()
    if not ok:
        return err
    return jsonify({"ok": True, "waypoints": action_groups.list_waypoints(session.get('user_id'))})


@app.post("/api/arm/waypoints")
@login_required
def arm_waypoints_save():
    ok, err = _require_industrial()
    if not ok:
        return err
    data = request.get_json(force=True, silent=True) or {}
    ok, msg, wid = action_groups.save_waypoint(
        session.get('user_id'), data.get("name"), data.get("pwm"))
    return jsonify({"ok": ok, "msg": msg, "id": wid})


@app.post("/api/arm/waypoints/capture")
@login_required
def arm_waypoints_capture():
    """读取机械臂当前姿态并存为途经点卡片（调姿态只能用滑块，不能手掰）。"""
    ok, err = _require_industrial()
    if not ok:
        return err
    data = request.get_json(force=True, silent=True) or {}
    ok, msg, wid = action_groups.capture_waypoint(
        session.get('user_id'), (data.get("name") or "").strip())
    return jsonify({"ok": ok, "msg": msg, "id": wid})


@app.post("/api/arm/waypoints/<int:waypoint_id>/update")
@login_required
def arm_waypoints_update(waypoint_id):
    """把指定途经点更新为机械臂当前各关节位置（编辑器卡片库的「更新」按钮）。

    复用 save_waypoint 的"同名则更新"逻辑：先查该途经点的名字（顺带校验归属），
    再以该名字把当前位置存回去 —— key 不变，画布上已有的连线不受影响。
    """
    ok, err = _require_industrial()
    if not ok:
        return err
    wps = action_groups.list_waypoints(session.get('user_id'))
    w = next((x for x in wps if x['id'] == waypoint_id), None)
    if not w:
        return jsonify({"ok": False, "msg": "途经点不存在或无权更新"}), 404
    if not arm.connected:
        return jsonify({"ok": False, "msg": "机械臂未连接"}), 400
    if arm.busy:
        return jsonify({"ok": False, "msg": "机械臂正忙，请稍候"}), 400
    pwm = arm.read_current_pose()
    if not pwm:
        return jsonify({"ok": False, "msg": "读取当前姿态失败"}), 500
    ok, msg, wid = action_groups.save_waypoint(session.get('user_id'), w['name'], pwm)
    return jsonify({"ok": ok, "msg": msg, "id": wid})


@app.delete("/api/arm/waypoints/<int:waypoint_id>")
@login_required
def arm_waypoints_delete(waypoint_id):
    ok, err = _require_industrial()
    if not ok:
        return err
    ok, msg = action_groups.delete_waypoint(waypoint_id, session.get('user_id'))
    return jsonify({"ok": ok, "msg": msg})


# ---------- 动作组 ----------

@app.get("/api/arm/groups")
@login_required
def arm_groups_list():
    ok, err = _require_industrial()
    if not ok:
        return err
    return jsonify({"ok": True,
                    "groups": action_groups.list_groups(session.get('user_id')),
                    "run": action_groups.get_status()})


@app.post("/api/arm/groups")
@login_required
def arm_groups_save():
    ok, err = _require_industrial()
    if not ok:
        return err
    data = request.get_json(force=True, silent=True) or {}
    ok, msg, gid = action_groups.save_group(
        data.get("id"), session.get('user_id'), data.get("name"),
        data.get("graph"), data.get("remark", ""))
    return jsonify({"ok": ok, "msg": msg, "id": gid})


@app.get("/api/arm/groups/<int:group_id>")
@login_required
def arm_group_get(group_id):
    ok, err = _require_industrial()
    if not ok:
        return err
    g = action_groups.get_group(group_id, session.get('user_id'))
    if not g:
        return jsonify({"ok": False, "msg": "动作组不存在或无权访问"}), 404
    # 附加"被哪些类别引用"（只读，供编辑器展示；映射配置只在工控页左栏）
    # ⚠ 按当前模型解析：全局份切模型后是空的，编辑器会误显示"没有被引用"
    mcfg = db.get_user_model_cfg(session.get('user_id'))
    cmap = mcfg['class_group_map'] or {}
    g['used_by'] = sorted([k for k, v in cmap.items() if v == group_id])
    return jsonify({"ok": True, **g})


@app.delete("/api/arm/groups/<int:group_id>")
@login_required
def arm_group_delete(group_id):
    ok, err = _require_industrial()
    if not ok:
        return err
    ok, msg = action_groups.delete_group(group_id, session.get('user_id'))
    return jsonify({"ok": ok, "msg": msg})


@app.post("/api/arm/groups/<int:group_id>/run")
@arm_page_lock_required
@login_required
def arm_group_run(group_id):
    """手动运行一条动作组（异步执行，进度用 /api/arm/groups 轮询）。"""
    ok, err = _require_industrial()
    if not ok:
        return err
    ok, msg = action_groups.run_group_async(
        group_id, session.get('user_id'), session.get('username'))
    return jsonify({"ok": ok, "msg": msg, "run": action_groups.get_status()})


@app.post("/api/arm/groups/stop")
@arm_page_lock_required
@login_required
def arm_group_stop():
    # 与 /api/arm/stop（急停）性质相同：会中断机械臂动作，故同样要求持有页面锁
    ok, msg = action_groups.stop()
    return jsonify({"ok": ok, "msg": msg})


# ---------- 模式与映射 ----------

@app.post("/api/arm/advanced-mode")
@login_required
def arm_set_advanced_mode():
    """切换普通/高级模式（只影响当前用户）。"""
    ok, err = _require_industrial()
    if not ok:
        return err
    data = request.get_json(force=True, silent=True) or {}
    enabled = 1 if data.get("enabled") else 0
    user_id = session.get('user_id')
    try:
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("UPDATE users SET advanced_mode=%s WHERE id=%s", (enabled, user_id))
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        logger.warning("[arm] 切换高级模式失败: %s", e)
        return jsonify({"ok": False, "msg": "切换失败"})
    return jsonify({"ok": True, "advanced_mode": bool(enabled),
                    "msg": "已切换到" + ("高级模式（动作组）" if enabled else "普通模式")})


@app.get("/api/arm/class-group-map")
@app.post("/api/arm/class-group-map")
@login_required
def arm_class_group_map():
    """读写「类别 → 动作组」映射（当前用户）。"""
    ok, err = _require_industrial()
    if not ok:
        return err
    user_id = session.get('user_id')
    if request.method == "GET":
        cfg = db.ensure_user_arm_config(user_id)
        # 映射**按当前模型切换**：每个模型各自记住一套「类别→动作组」，
        # 换回旧模型时自动恢复（原先只有一份，换模型就被冲掉）
        cur_model = (detector.current_file or '').strip()
        # ⚠ 同样必须直接从 users 表读：ensure_user_arm_config 的返回字典不含新列
        #   （与普通模式踩的是同一个坑）
        _c2 = db.get_db()
        try:
            with _c2.cursor() as _cur:
                _cur.execute("SELECT group_map_by_model, selected_cls_by_model"
                             " FROM users WHERE id=%s", (user_id,))
                _r = _cur.fetchone() or {}
        finally:
            _c2.close()

        def _pj2(v):
            if isinstance(v, str):
                try:
                    return json.loads(v) if v else {}
                except Exception:
                    return {}
            return v or {}
        by_model = _pj2(_r.get('group_map_by_model'))
        cmap_out = (by_model.get(cur_model) if cur_model else None)
        if cmap_out is None:
            cmap_out = cfg.get('class_group_map') or {}   # 老数据兜底
        return jsonify({"ok": True,
                        "class_group_map": cmap_out,
                        # 已选类别同样按模型恢复（切换模型时"当前"那份会被清，
                        # 但每个模型自己那份留着）
                        "selected_classes": (_pj2(_r.get('selected_cls_by_model')).get(cur_model)
                                             if cur_model else None) or
                                            cfg.get('selected_classes') or [],
                        "groups": action_groups.list_groups(user_id)})
    data = request.get_json(force=True, silent=True) or {}
    cmap = data.get("class_group_map")
    if not isinstance(cmap, dict):
        return jsonify({"ok": False, "msg": "映射格式错误"}), 400
    # 只接受属于当前用户且存在的动作组；值为空表示解除绑定
    valid = {g['id'] for g in action_groups.list_groups(user_id)}
    cleaned = {}
    for k, v in cmap.items():
        if v in (None, '', 0):
            continue
        try:
            v = int(v)
        except (TypeError, ValueError):
            continue
        if v in valid:
            cleaned[str(k)] = v
    _save_user_json_cfg(user_id, "class_group_map", cleaned)
    # 同时按**当前模型**单独存一份：换模型再切回来能自动恢复
    try:
        _m = (detector.current_file or '').strip()
        if _m:
            conn = db.get_db()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT group_map_by_model FROM users WHERE id=%s", (user_id,))
                    r2 = cur.fetchone() or {}
                    gbm = r2.get('group_map_by_model') or {}
                    if isinstance(gbm, str):
                        gbm = json.loads(gbm) if gbm else {}
                    gbm[_m] = cleaned
                    cur.execute("UPDATE users SET group_map_by_model=%s WHERE id=%s",
                                (json.dumps(gbm, ensure_ascii=False), user_id))
                conn.commit()
            finally:
                conn.close()
    except Exception as e:
        logger.warning("[arm] 保存按模型的动作组映射失败（不影响当前配置）: %s", e)
    return jsonify({"ok": True, "msg": "已保存类别映射", "class_group_map": cleaned})


@app.post("/api/arm/poses/clear")
@arm_page_lock_required
@login_required
def arm_poses_clear():
    """清空**当前用户**的动作标定位数据（标定按用户隔离，各人只清自己的）。"""
    uid = session.get('user_id')
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET normal_poses_json='{}' WHERE id=%s", (uid,))
        conn.commit()
        # 标定数据以 DB 的 normal_poses_json 为唯一来源，不再写内存副本
        return jsonify({"ok": True, "msg": "已清空你的标定数据"})
    finally:
        conn.close()


@app.get("/api/arm/config")
@login_required
def arm_config_get():
    if not _has_industrial_access(session.get('user_id')):
        return jsonify({"ok": False, "msg": "无工业控制模块权限"}), 403
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM arm_config WHERE id=1")
            row = cur.fetchone()
        if not row:
            return jsonify({"ok": True, "areas": [], "class_area_map": {}, "poses": {}, "selected_classes": []})
        # 全部按用户隔离：放置位列表、姿态标定、类别映射、选中类别，各人各一套
        ucfg = db.ensure_user_arm_config(session.get('user_id'))
        # ⚠️ 区分「未初始化(None)」与「用户主动清空([]/{})」：
        #    只有 None 才回落到全局模板；用户清空后必须保持为空，不能回填
        u_areas = ucfg.get('areas')
        u_poses = ucfg.get('normal_poses_json')
        areas = u_areas if u_areas is not None else (
            json.loads(row["areas"]) if row["areas"] else [])
        poses = u_poses if u_poses is not None else (
            json.loads(row["poses_json"]) if row["poses_json"] else {})
        # 映射**按当前模型切换**：每个模型各自记住一套类别映射，
        # 换回旧模型时自动恢复上次配好的（原先只有一份，换模型就被冲掉）
        # ⚠ 必须直接从 users 表读这三个新列 —— ensure_user_arm_config 只认
        #    旧键列表，不含它们；用 ucfg.get() 永远是 None（已踩坑）
        uid = session.get('user_id')
        conn2 = db.get_db()
        try:
            with conn2.cursor() as cur:
                cur.execute("SELECT class_map_by_model, group_map_by_model,"
                            " selected_cls_by_model, class_trigger_by_model,"
                            " trigger_mode_by_model, trigger_arb_by_model"
                            " FROM users WHERE id=%s", (uid,))
                _rbm = cur.fetchone() or {}
        finally:
            conn2.close()
        def _pj(v):
            if isinstance(v, str):
                try:
                    return json.loads(v) if v else {}
                except Exception:
                    return {}
            return v or {}
        cur_model = (detector.current_file or '').strip()
        by_cmap = _pj(_rbm.get('class_map_by_model'))
        by_gmap = _pj(_rbm.get('group_map_by_model'))
        by_sel = _pj(_rbm.get('selected_cls_by_model'))
        # ⚠️ None 与 {} 同义处理：这里要的是"当前模型的映射"，
        #    没有就给空 —— 用户主动清空也应该是空，不能拿全局模板回填
        class_map = (by_cmap.get(cur_model) if cur_model else None)
        if class_map is None:
            # 旧数据迁移/兜底：还没有按模型分组时，沿用原来那一份
            class_map = ucfg.get('normal_class_map') or {}
        sel_cls = (by_sel.get(cur_model) if cur_model else None)
        if sel_cls is None:
            sel_cls = ucfg.get('selected_classes') or []
        # 动作速度档位（**按用户隔离**：读当前用户自己那份）
        move_speed = db.get_arm_move_speed(session.get('user_id'))
        # 类别触发规则 + 规则模式（同样按当前模型隔离；⚠ 必须直接查 users 表，
        # ensure_user_arm_config 白名单不含这两列，用 ucfg.get() 永远是 None）
        by_trig = _pj(_rbm.get('class_trigger_by_model'))
        by_tmode = _pj(_rbm.get('trigger_mode_by_model'))
        trigger_rules = (by_trig.get(cur_model) if cur_model else None) or {}
        _tm = (by_tmode.get(cur_model) if cur_model else None)
        trigger_mode = _tm if _tm in ('basic', 'advanced') else 'basic'
        # 触发调优（按当前模型）：仲裁帧数是唯一可调项，防抖(3帧)/失效(500ms)已写死。
        # ⚠ 必须在这里返回 tuning——前端 indLoadArmConfig 只从本接口读调优值
        #   （/api/arm/class-trigger-rules 的 GET 前端不调用），漏了它仲裁值
        #   每次加载都回落默认 3，且任何一次保存规则都会把 3 覆盖回库（2026-10-21 实测 bug）
        by_tarb = _pj(_rbm.get('trigger_arb_by_model'))
        tuning = _read_tuning(by_tarb.get(cur_model) if cur_model else None)
        return jsonify({"ok": True, "areas": areas, "class_area_map": class_map, "poses": poses,
                        "selected_classes": sel_cls, "move_speed": move_speed,
                        "class_trigger_by_model": trigger_rules, "trigger_mode": trigger_mode,
                        "tuning": tuning})
    finally:
        conn.close()


@app.post("/api/arm/config")
@arm_page_lock_required
@login_required
def arm_config_set():
    data = request.get_json(force=True, silent=True) or {}
    areas = data.get("areas")
    class_map = data.get("class_area_map")
    move_speed = data.get("move_speed")
    if areas is None and class_map is None and move_speed is None:
        return jsonify({"ok": False, "msg": "没有更新内容"}), 400
    if move_speed is not None and move_speed not in config.MOVE_SPEED_PROFILES:
        return jsonify({"ok": False, "msg": "未知的速度档位: %s" % move_speed}), 400
    uid = session.get('user_id')
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            if areas is not None:
                # 放置位列表按用户隔离
                cur.execute("UPDATE users SET areas=%s WHERE id=%s",
                            (json.dumps(areas, ensure_ascii=False), uid))
                # 联动清理：删除该用户姿态中不在新 areas 列表里的放置位（保留 home/pick）
                cur.execute("SELECT normal_poses_json FROM users WHERE id=%s", (uid,))
                row = cur.fetchone()
                if row and row["normal_poses_json"]:
                    poses = json.loads(row["normal_poses_json"])
                    valid_keys = {"home", "pick"} | {a["key"] for a in areas}
                    removed = [k for k in poses if k not in valid_keys]
                    if removed:
                        for k in removed:
                            del poses[k]
                        cur.execute("UPDATE users SET normal_poses_json=%s WHERE id=%s",
                                    (json.dumps(poses, ensure_ascii=False), uid))
            if class_map is not None:
                # 类别→放置位映射属策略层：按用户隔离（不再写全局 arm_config）
                cur.execute("UPDATE users SET normal_class_map=%s WHERE id=%s",
                            (json.dumps(class_map, ensure_ascii=False), uid))
                # 同时按**当前模型**单独存一份：换模型再切回来能自动恢复
                try:
                    cur.execute("SELECT class_map_by_model FROM users WHERE id=%s", (uid,))
                    r2 = cur.fetchone() or {}
                    bm = r2.get('class_map_by_model') or {}
                    if isinstance(bm, str):
                        bm = json.loads(bm) if bm else {}
                    _m = (detector.current_file or '').strip()
                    if _m:
                        bm[_m] = class_map
                        cur.execute("UPDATE users SET class_map_by_model=%s WHERE id=%s",
                                    (json.dumps(bm, ensure_ascii=False), uid))
                except Exception as e:
                    logger.warning("[arm] 保存按模型映射失败（不影响当前配置）: %s", e)
            if move_speed is not None:
                # 动作速度档位**按用户隔离**：只改当前登录用户自己那份，不影响他人
                cur.execute("UPDATE users SET arm_move_speed=%s WHERE id=%s",
                            (move_speed, uid))
        conn.commit()
        try:
            sorter.reload_config(uid)
        except Exception as e:
            logger.warning("[arm] 更新配置后重载分拣映射失败: %s", e)
        return jsonify({"ok": True, "msg": "配置已更新"})
    finally:
        conn.close()


@app.post("/api/arm/selected-classes")
@arm_page_lock_required
@login_required
def arm_selected_classes_set():
    data = request.get_json(force=True, silent=True) or {}
    classes = data.get("classes") or []
    if not isinstance(classes, list):
        return jsonify({"ok": False, "msg": "classes 必须是数组"}), 400
    if len(classes) > 4:
        return jsonify({"ok": False, "msg": "最多选择 4 个类别"}), 400
    uid = session.get('user_id')
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            # ⚠ 只更新「已选类别」，**映射一律不动**（普通模式 normal_class_map /
            # class_map_by_model，高级模式 class_group_map / group_map_by_model）。
            # 取消勾选 = 暂时不参与触发，不是删除配置：用户重新勾回来映射应当还在。
            #
            # 旧实现在这里清空 normal_class_map 并按选中类别裁剪两份映射，
            # 本意是防止"清空了还在动"，但代价是映射被永久删掉——
            # 用户取消全部类别再勾回来，映射就全没了（用户反馈的记忆失效）。
            # 正确解法是**触发时校验**：不在已选类别中的一律不放行
            #   · 高级模式：sorter/detect 已做双校验（已选 + 有映射）
            #   · 普通模式：本次同步补上（见 sorter_detect 与前端 indCaptureFrame）
            cur.execute(
                "UPDATE users SET selected_classes=%s WHERE id=%s",
                (json.dumps(classes, ensure_ascii=False), uid))
            # 已选类别按当前模型另存一份（换模型回来自动恢复选择）
            try:
                _m2 = (detector.current_file or '').strip()
                if _m2:
                    cur.execute("SELECT selected_cls_by_model FROM users WHERE id=%s", (uid,))
                    _r2 = cur.fetchone() or {}
                    def _j(v):
                        if isinstance(v, str):
                            try:
                                return json.loads(v) if v else {}
                            except Exception:
                                return {}
                        return v or {}
                    _sbm = _j(_r2.get('selected_cls_by_model'))
                    _sbm[_m2] = classes
                    cur.execute("UPDATE users SET selected_cls_by_model=%s WHERE id=%s",
                                (json.dumps(_sbm, ensure_ascii=False), uid))
            except Exception as e:
                logger.warning("[arm] 保存按模型的已选类别失败（不影响当前配置）: %s", e)
        conn.commit()
        try:
            sorter.reload_config(uid)
        except Exception as e:
            logger.warning("[arm] 更新类别后重载分拣映射失败: %s", e)
        return jsonify({"ok": True, "msg": f"已选择 {len(classes)} 个类别"})
    finally:
        conn.close()


@app.get("/api/sorter/records")
@login_required
def sorter_records():
    ok, err = _require_industrial()
    if not ok:
        return err
    page = max(1, int(request.args.get("page", 1)))
    page_size = min(100, int(request.args.get("page_size", 20)))
    cls = (request.args.get("class") or "").strip()
    # scope=me 只看自己的；scope=all 看全部人的 —— 但**普通用户强制只看自己的**
    # （这里兜底，不依赖前端是否隐藏了「全部」按钮）
    scope = (request.args.get("scope") or "all").strip().lower()
    if session.get("role") != "admin":
        scope = "me"
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            where = "WHERE model_name=%s"
            params = [detector.current_file or '']
            if scope == "me":
                where += " AND user_id=%s"
                params.append(session.get("user_id"))
            if cls:
                where += " AND defect_class=%s"
                params.append(cls)
            cur.execute(f"SELECT COUNT(*) AS c FROM sort_records {where}", params)
            total = cur.fetchone()["c"]
            cur.execute(
                f"SELECT * FROM sort_records {where} ORDER BY id DESC LIMIT %s OFFSET %s",
                params + [page_size, (page - 1) * page_size]
            )
            rows = cur.fetchall()
        return jsonify({"ok": True, "records": rows, "total": total, "page": page, "scope": scope})
    finally:
        conn.close()


@app.delete("/api/sorter/records/<int:rid>")
@login_required
def sorter_record_delete(rid):
    ok, err = _require_industrial()
    if not ok:
        return err
    uid = session.get('user_id')
    is_admin = (session.get('role') == 'admin')
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            # 管理员可删任何人的记录；普通用户（被授权进入工控页）只能删自己的
            cur.execute("DELETE FROM sort_records WHERE id=%s" +
                        ("" if is_admin else " AND user_id=%s"),
                        (rid,) if is_admin else (rid, uid))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.delete("/api/sorter/records")
@login_required
def sorter_records_delete_batch():
    ok, err = _require_industrial()
    if not ok:
        return err
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids") or []
    if not ids:
        return jsonify({"ok": False, "msg": "ids 不能为空"}), 400
    uid = session.get('user_id')
    is_admin = (session.get('role') == 'admin')
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            placeholders = ",".join(["%s"] * len(ids))
            if is_admin:
                cur.execute(f"DELETE FROM sort_records WHERE id IN ({placeholders})", ids)
            else:
                # 普通用户（被授权进入工控页）只能删自己的记录
                cur.execute(f"DELETE FROM sort_records WHERE id IN ({placeholders}) AND user_id=%s",
                            list(ids) + [uid])
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.get("/api/sorter/stats")
@login_required
def sorter_stats():
    ok, err = _require_industrial()
    if not ok:
        return err
    # scope=me 只看自己的；scope=all 看全部人的 —— 但**普通用户强制只看自己的**，
    # 不依赖前端是否隐藏了「全部」按钮（纵深防御）
    scope = (request.args.get("scope") or "all").strip().lower()
    if session.get("role") != "admin":
        scope = "me"
    user_sql = " AND user_id=%s" if scope == "me" else ""
    uid = session.get("user_id")
    base = "FROM sort_records WHERE DATE(created_at)=CURDATE() AND model_name=%s" + user_sql
    p1 = [detector.current_file or ''] + ([uid] if scope == "me" else [])
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS c " + base, p1)
            total = cur.fetchone()["c"]
            cur.execute(
                "SELECT defect_class, COUNT(*) AS c " + base + " GROUP BY defect_class", p1
            )
            by_class = {r["defect_class"]: r["c"] for r in cur.fetchall()}
        return jsonify({"ok": True, "total": total, "by_class": by_class, "scope": scope})
    finally:
        conn.close()


@app.post("/api/sorter/start")
@login_required
def sorter_start():
    ok, err = _require_industrial()
    if not ok:
        return err
    ok, msg = sorter.start(session.get("user_id"))
    return jsonify({"ok": ok, "msg": msg})


@app.post("/api/sorter/stop")
@login_required
def sorter_stop():
    ok, err = _require_industrial()
    if not ok:
        return err
    ok, msg = sorter.stop()
    return jsonify({"ok": ok, "msg": msg})


@app.post("/api/sorter/detect")
@login_required
def sorter_detect():
    ok, err = _require_industrial()
    if not ok:
        return err
    data = request.get_json(force=True, silent=True) or {}
    defect_class = (data.get("defect_class") or "").strip()
    confidence = float(data.get("confidence", 0))
    if not defect_class:
        return jsonify({"ok": False, "msg": "缺少 defect_class"}), 400
    user_id = session.get("user_id", 1)
    username = session.get("username", "system")

    # 高级模式：按「类别 → 动作组」映射运行对应动作组，不再执行普通分拣固定 5 步
    if _arm_mode(user_id) == 'advanced':
        # ⚠ 必须按**当前模型**解析：切模型时全局"当前"份已被清空（见 /api/models/switch），
        #   只有 *_by_model 那份留着；ensure_user_arm_config 的白名单不含这些列，
        #   直接 ucfg.get() 读到的恒为空 → 每次触发都被"已忽略"拒掉（2026-10-21 实测）。
        mcfg = db.get_user_model_cfg(user_id)
        # 双校验：类别必须**已选中** 且 **有映射**，两者缺一不可。
        # 只查 class_group_map 是不够的 —— 用户清空已选类别后，
        # class_group_map 里可能还残留旧映射，导致"改了却仍按老映射动作"。
        selected = mcfg['selected_classes'] or []
        # ⚠ 严格判定（不再写 `if selected and ...`）：映射现在不会被删除，
        #   已选类别为空时必须拒绝触发，否则清空类别后仍按旧映射动作
        if defect_class not in selected:
            return jsonify({"ok": False,
                            "msg": f"类别「{defect_class}」不在已选类别中，已忽略",
                            **sorter.get_status()})
        gid = (mcfg['class_group_map'] or {}).get(defect_class)
        if not gid:
            return jsonify({"ok": False,
                            "msg": f"类别「{defect_class}」未绑定动作组，已忽略",
                            **sorter.get_status()})
        # 传入触发类别：动作组跑完后据此补写一条分拣记录，
        # 否则高级模式的「今日计分统计」永远是 0
        ok, msg = action_groups.run_group_async(gid, user_id, username,
                                                defect_class=defect_class,
                                                confidence=confidence)
        return jsonify({"ok": ok, "msg": msg, "run": action_groups.get_status(),
                        **sorter.get_status()})

    # 普通模式：与高级模式一致做「已选类别」校验（同样按当前模型解析，
    # 读全局份会在切模型后恒为空 → 全部触发被"已忽略"拒掉）。
    # 映射现在**不再随取消勾选而删除**（保留记忆），若这里不校验，
    # 用户清空已选类别后机械臂仍会按旧映射动作（"改了却还在动"）。
    mcfg = db.get_user_model_cfg(user_id)
    selected = mcfg['selected_classes'] or []
    # ⚠ 严格判定：已选为空时也要拒绝（一个类别都没选 = 什么都不该分拣）
    if defect_class not in selected:
        return jsonify({"ok": False,
                        "msg": f"类别「{defect_class}」不在已选类别中，已忽略",
                        **sorter.get_status()})
    ok, msg = sorter.submit_detection(defect_class, confidence, user_id, username)
    return jsonify({"ok": ok, "msg": msg, **sorter.get_status()})


@app.get("/api/sorter/status")
@login_required
def sorter_status():
    ok, err = _require_industrial()
    if not ok:
        return err
    # 带上动作组运行状态：高级模式下遮罩需要显示动作组的步骤进度
    return jsonify({"ok": True, **sorter.get_status(),
                    "run": action_groups.get_status()})


@app.post("/api/sorter/estop")
@login_required
def sorter_estop():
    ok, err = _require_industrial()
    if not ok:
        return err
    ok, msg = sorter.estop()
    # 同时中止可能正在运行的动作组（高级模式）
    try:
        action_groups.stop()
    except Exception as e:
        logger.debug("[arm] 急停时中止动作组失败: %s", e)
    return jsonify({"ok": ok, "msg": msg})


@app.post("/api/sorter/reset")
@login_required
def sorter_reset():
    ok, err = _require_industrial()
    if not ok:
        return err
    ok, msg = sorter.reset(session.get("user_id"))
    return jsonify({"ok": ok, "msg": msg})


def main():
    """后端启动入口。

    开发直跑 (python app.py)、字节码形态 (entry.pyc + import app)、
    Cython 扩展形态 (entry.pyc + import app) 三种情况共用这一个函数，
    避免启动逻辑在多处重复（单一真源）。
    """
    db.init_db()
    init_admin()
    init_models_db()
    logger.info("[boot] 当前模型: %s", detector.get_current())
    logger.info("[boot] 模型目录: %s", MODELS_DIR)
    logger.info("[boot] 访问 http://%s:%s", HOST, PORT)
    app.run(host=HOST, port=PORT, debug=False, threaded=True)


if __name__ == "__main__":
    main()
