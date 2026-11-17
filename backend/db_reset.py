# -*- coding: utf-8 -*-
"""一键重置 / 新设备部署数据库：执行项目根目录 db/schema.sql。

效果：删掉同名库（若存在）并按备份重建全部表 + 初始数据。
**会清空现有业务数据**（用户、记录、模型、动作组等），需要确认后执行。

用法：
    python db_reset.py            # 交互式确认
    python db_reset.py --yes      # 跳过确认（脚本/自动化用）
    python db_reset.py --check    # 只看当前状态，不改动
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

# schema.sql 的位置：
#   - 脚本方式运行：脚本在 backend/，备份在 项目根/db
#   - 打包成 EXE 后：EXE 就放在 db/ 里，备份与它同级
if getattr(sys, "frozen", False):
    SCHEMA = os.path.join(os.path.dirname(sys.executable), "schema.sql")
else:
    SCHEMA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "db", "schema.sql")

CANDIDATES = [
    r"C:\Program Files\MySQL\MySQL Server 9.0\bin\mysql.exe",
    r"C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe",
    r"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe",
]


def find_mysql():
    for p in CANDIDATES:
        if os.path.isfile(p):
            return p
    return which("mysql")


def base_cmd(exe):
    return [
        exe,
        "-h", str(DB_CONFIG.get("host", "127.0.0.1")),
        "-P", str(DB_CONFIG.get("port", 3306)),
        "-u", str(DB_CONFIG.get("user", "root")),
        "-p" + str(DB_CONFIG.get("password", "")),
    ]


def check():
    """只读检查：库是否存在、有几张表。"""
    try:
        import db
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SHOW DATABASES LIKE %s", (DB_NAME,))
                exists = cur.fetchone() is not None
                tables = []
                if exists:
                    cur.execute("SELECT COUNT(*) AS n FROM information_schema.tables"
                                " WHERE table_schema=%s", (DB_NAME,))
                    tables = ["（共 %s 张表）" % cur.fetchone()["n"]]
            print("数据库 %s：%s %s" % (DB_NAME, "存在" if exists else "不存在",
                                       " ".join(tables)))
            return exists
        finally:
            conn.close()
    except Exception as e:
        print("数据库状态检查失败：%s" % e)
        return None


def main():
    args = sys.argv[1:]
    if "--check" in args:
        check()
        return 0

    if not os.path.isfile(SCHEMA):
        print("[错误] 找不到备份文件 %s，请先运行 db_export.py 导出" % SCHEMA)
        return 1
    exe = find_mysql()
    if not exe:
        print("[错误] 未找到 mysql 客户端，请确认 MySQL 已安装")
        return 1

    print("=" * 56)
    print("即将重置数据库：%s" % DB_NAME)
    print("  - 删除同名库并按 %s 重建" % os.path.relpath(SCHEMA, os.path.dirname(HERE)))
    print("  - 现有用户、检测/分拣记录、模型、动作组等数据都会被清空")
    print("=" * 56)
    if "--yes" not in args:
        try:
            ans = input("确认执行请输入 yes：").strip().lower()
        except EOFError:
            ans = ""
        if ans != "yes":
            print("已取消")
            return 0

    print("[执行] 导入结构 ...")
    r = subprocess.run(base_cmd(exe), stdin=open(SCHEMA, "r", encoding="utf-8"),
                       capture_output=True)
    if r.returncode != 0:
        print("[错误] 导入失败：%s" % r.stderr.decode("utf-8", "ignore"))
        return 1
    print("[完成] 数据库已重建：%s" % DB_NAME)
    print("提示1：后端会自动补建缺失的列（db._migrate），直接启动即可")
    print("提示2：已预留管理员 admin / admin，登录后可创建其它账号 —— 请尽快修改密码")
    print("提示3：models 表是空的，请在「模型管理」页点「刷新元数据」扫描磁盘重建")
    return 0


if __name__ == "__main__":
    sys.exit(main())
