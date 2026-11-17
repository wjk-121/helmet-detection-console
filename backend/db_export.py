# -*- coding: utf-8 -*-
"""导出数据库「建表结构 + 必要初始数据」到项目根目录的 db/schema.sql。

备份内容：
  - 各表的 CREATE TABLE（含 DROP DATABASE / CREATE DATABASE，便于新设备一键部署）
  - arm_config 的初始行（程序启动依赖 id=1 这一行存在）

不包含：用户账号、检测记录、分拣记录、模型等业务数据 —— 保证新设备部署出来是干净的。


特别约定：`models` 表绝不预填种子数据，部署出来的必须是空表。
  理由：无法预知目标机器上实际存在哪些模型文件，预填会让数据库记录与磁盘文件
  对不上（库里有记录、磁盘上没文件）。正确做法是部署后由用户在「模型管理」页
  点「刷新元数据」扫描磁盘自动重建。改动本脚本时务必保留这条约定。
用法：python db_export.py
"""
import os
import subprocess
import sys

# Windows 控制台切到 UTF-8，保证中文输出不乱码（与 launcher.py 一致）
os.system("chcp 65001 >nul")
try:
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:
    pass
from shutil import which

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import DB_NAME, DB_CONFIG  # noqa: E402

# 备份输出目录：
#   - 脚本方式运行：脚本在 backend/，输出到 项目根/db
#   - 打包成 EXE 后：EXE 本身就放在 db/ 里，直接输出到 EXE 同级目录
if getattr(sys, "frozen", False):
    OUT_DIR = os.path.dirname(sys.executable)
else:
    OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "db")
OUT_FILE = os.path.join(OUT_DIR, "schema.sql")

# 预留的管理员账号（与 app.py 中"用户表为空时自动创建"的默认值保持一致）
DEFAULT_ADMIN_USER = "admin"
DEFAULT_ADMIN_PASS = "admin"

# mysqldump 常见安装位置（找不到再回落 PATH）
CANDIDATES = [
    r"C:\Program Files\MySQL\MySQL Server 9.0\bin\mysqldump.exe",
    r"C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqldump.exe",
    r"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe",
]


def find_mysqldump():
    for p in CANDIDATES:
        if os.path.isfile(p):
            return p
    return which("mysqldump")


def main():
    dump = find_mysqldump()
    if not dump:
        print("[错误] 未找到 mysqldump，请确认 MySQL 已安装")
        return 1
    os.makedirs(OUT_DIR, exist_ok=True)

    cmd = [
        dump,
        "-h", str(DB_CONFIG.get("host", "127.0.0.1")),
        "-P", str(DB_CONFIG.get("port", 3306)),
        "-u", str(DB_CONFIG.get("user", "root")),
        "-p" + str(DB_CONFIG.get("password", "")),
        "--databases", DB_NAME,
        "--no-data",                 # 只要结构
        "--add-drop-database",       # 便于一键重置 / 新设备部署
        "--add-drop-table",
        "--skip-comments",
        "--set-gtid-purged=OFF",
    ]
    print("[导出] 数据库结构 ...")
    try:
        out = subprocess.run(cmd, capture_output=True)
    except Exception as e:
        print("[错误] 执行 mysqldump 失败：%s" % e)
        return 1
    if out.returncode != 0:
        print("[错误] mysqldump 返回 %d：%s" % (
            out.returncode, out.stderr.decode("utf-8", "ignore")))
        return 1

    sql = out.stdout.decode("utf-8")
    # 追加必要初始数据（全部用 INSERT IGNORE，重复导入不会重复插入）
    # ① arm_config：程序启动依赖 id=1 这一行存在
    # ② 管理员账号：管理员不能靠注册创建，必须在库里预留。
    #    账号/口令与 app.py 里"用户表为空时自动创建"的默认值保持一致（admin/admin），
    #    哈希算法用 werkzeug 默认的 scrypt，与登录校验完全兼容。
    from werkzeug.security import generate_password_hash
    admin_hash = generate_password_hash(DEFAULT_ADMIN_PASS)
    sql += (
        "\n-- ============ 必要初始数据 ============\n"
        "USE `%s`;\n"
        "INSERT IGNORE INTO arm_config (id, class_area_map, areas, poses_json)"
        " VALUES (1, '{}', '[]', '{}');\n"
        "-- 预留管理员（部署后请立即登录并修改密码）\n"
        "INSERT IGNORE INTO users (username, password_hash, role)"
        " VALUES ('%s', '%s', 'admin');\n"
        % (DB_NAME, DEFAULT_ADMIN_USER, admin_hash)
    )
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        f.write(sql)
    print("[完成] 已写入 %s（%.1f KB）" % (OUT_FILE, os.path.getsize(OUT_FILE) / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
