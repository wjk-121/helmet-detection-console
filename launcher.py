# -*- coding: utf-8 -*-
"""YOLO 检测平台一键启动器（打包为 EXE 后双击运行）。

行为：
  - 双击运行 -> 弹出控制台窗口，启动 MySQL(若未运行) + 后端；
  - 后端日志实时显示在窗口；
  - 后端就绪后自动打开浏览器；
  - 按 Ctrl+C 关闭窗口即停止后端并退出。

路径说明：EXE 应放在项目根目录，backend/ 为其同级目录。
Python 解释器固定使用 conda 环境 yolo26；MySQL 版本自动探测本机安装。
"""
import os
import sys
import time
import socket
import subprocess
import webbrowser

# Windows 控制台切到 UTF-8，保证中文输出不乱码
os.system("chcp 65001 >nul")
try:
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:
    pass

# 子进程独立进程组：Ctrl+C 只打断本启动器，由我们主动终止子进程，
# 避免子进程被直接杀掉导致误报。
CREATE_NEW_PROCESS_GROUP = 0x00000200

def _find_project_root():
    """launcher.py 与 backend/ 同级（即项目根）。基于脚本自身路径定位，
    不依赖调用方式或工作目录，也不写死任何历史路径。"""
    here = os.path.dirname(os.path.abspath(__file__))
    if os.path.exists(os.path.join(here, "backend", "app.py")):
        return here
    # 兜底：向上一级再探测一次
    parent = os.path.dirname(here)
    if os.path.exists(os.path.join(parent, "backend", "app.py")):
        return parent
    return here


EXE_DIR = _find_project_root()
BACKEND = os.path.join(EXE_DIR, "backend")
PY = r"C:/Users/WJK-PC/anaconda3/envs/yolo26/python.exe"
PORT = 5000


def find_mysql_server():
    """探测本机安装的 MySQL Server（支持 9.0 / 8.4 / 8.0 等多个大版本）。

    遍历 C:/Program Files/MySQL 下的 'MySQL Server X.Y' 目录，返回
    (mysqld.exe 路径, 对应的 my.ini 路径)；优先版本号最高者；
    找不到则返回 (None, None)。
    """
    pf = r"C:/Program Files/MySQL"
    pd = r"C:/ProgramData/MySQL"
    if not os.path.isdir(pf):
        return None, None
    found = []  # (版本元组, bin路径, ini路径)
    for name in sorted(os.listdir(pf)):
        if not name.startswith("MySQL Server "):
            continue
        ver = name[len("MySQL Server "):]
        try:
            vt = tuple(int(x) for x in ver.split("."))
        except ValueError:
            vt = (0,)
        binp = os.path.join(pf, name, "bin", "mysqld.exe")
        inip = os.path.join(pd, name, "my.ini")
        if os.path.exists(binp):
            found.append((vt, binp, inip))
    if not found:
        return None, None
    found.sort(key=lambda t: t[0], reverse=True)
    return found[0][1], found[0][2]


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def start_mysql():
    if port_in_use(3306):
        print("[1/2] MySQL(3306) 已在运行，跳过。")
        return None
    binp, inip = find_mysql_server()
    if not binp or not os.path.exists(binp):
        print("[1/2] 未找到 mysqld（已探测 9.0/8.4/8.0 等），跳过，后端可能连不上库")
        return None
    if not os.path.exists(inip):
        print("[1/2] 警告：未找到 my.ini (%s)，尝试无配置文件启动（可能失败）" % inip)
        args = [binp, "--console"]
    else:
        args = [binp, "--defaults-file=%s" % inip, "--console"]
    ver_tag = os.path.basename(os.path.dirname(os.path.dirname(binp)))
    print("[1/2] 正在启动 MySQL (%s) ..." % ver_tag)
    try:
        p = subprocess.Popen(args, creationflags=CREATE_NEW_PROCESS_GROUP)
    except Exception as e:
        print("   启动 MySQL 失败：%s" % e)
        return None
    time.sleep(8)
    return p


def start_backend():
    if port_in_use(PORT):
        print("[2/2] 端口 %d 已被占用，后端可能已在运行，跳过启动。" % PORT)
        return None
    app_py = os.path.join(BACKEND, "app.py")
    if not os.path.exists(app_py):
        print("[2/2] 未找到 %s（EXE 是否放在项目根目录？）" % app_py)
        return None
    print("[2/2] 正在启动后端（conda: yolo26）...")
    try:
        p = subprocess.Popen(
            [PY, "app.py"], cwd=BACKEND, creationflags=CREATE_NEW_PROCESS_GROUP
        )
    except Exception as e:
        print("   启动后端失败：%s" % e)
        return None
    return p


def wait_ready(timeout=30):
    for _ in range(timeout):
        if port_in_use(PORT):
            return True
        time.sleep(1)
    return False


def cleanup(procs):
    for p in procs:
        if p and p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass


def main():
    print("=" * 52)
    print("        YOLO 检测平台 - 启动器 (launcher)")
    print("=" * 52)
    print()

    mysql_p = start_mysql()
    backend_p = start_backend()

    if backend_p is None and not port_in_use(PORT):
        print("[!] 后端未启动，请检查上方输出。")
    else:
        if wait_ready():
            print()
            print("[OK] 后端已就绪，正在打开浏览器 ...")
            try:
                webbrowser.open("http://127.0.0.1:%d/" % PORT)
            except Exception:
                pass
        else:
            print()
            print("[!] 后端在预期时间内未就绪，请查看上方日志。")

    print()
    print("后端正在运行。按 Ctrl+C 停止后端并退出。")
    print()

    stopping = False
    try:
        while not stopping:
            if backend_p and backend_p.poll() is not None:
                print("[!] 后端进程已退出，启动器将关闭。")
                break
            time.sleep(1)
    except KeyboardInterrupt:
        stopping = True
        print()
        print("正在停止后端 ...")
    finally:
        cleanup([backend_p, mysql_p])
        print("已停止。再见。")
        time.sleep(1)


if __name__ == "__main__":
    main()
