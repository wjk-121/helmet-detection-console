# -*- coding: utf-8 -*-
"""模型训练模块：数据集/权重扫描、后台训练线程、停止/续训、产物入库、HTML 报告。

全局只允许一个训练任务（ACTIVE 锁）。训练进度每个 epoch 写一次 training_jobs 表，
供多端 5 秒轮询同步。
"""
import os
import re
import csv
import json
import time
import uuid
import base64
import shutil
import threading
import traceback
import logging
from datetime import datetime
from pathlib import Path

# 内网/工地默认离线：必须在 import ultralytics 之前设置。
# 跳过 github AMP 权重下载（无外网时会 curl 重试数分钟）、pypi 更新检查、字体下载等联网等待。
os.environ.setdefault("YOLO_OFFLINE", "True")

import db
from config import (
    PRETRAINED_DIR, DATASETS_DIR, RUNS_DIR, REPORTS_DIR, MODELS_DIR,
)

logger = logging.getLogger("yolo.train")

IMG_EXT = (".jpg", ".jpeg", ".png", ".bmp", ".webp")
_JOB_NAME_RE = re.compile(r"^[A-Za-z0-9_\-]+$")

# ---------------- 全局活动任务（内存） ----------------
ACTIVE = {
    "job_name": None,
    "stop_mode": None,      # 'finish' 收尾入库 / 'abort' 暂停放弃
    "epoch_start_ts": None,
    "last_epoch_sec": None,
    "thread": None,
}
_ACTIVE_LOCK = threading.Lock()


class _AbortTraining(Exception):
    pass


# ---------------- 工具 ----------------
def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _safe_job_name(name):
    return bool(name) and bool(_JOB_NAME_RE.match(name))


def _read_classes(dataset_dir):
    """读 classes.txt，每行一个类名。"""
    p = os.path.join(dataset_dir, "classes.txt")
    classes = []
    if os.path.isfile(p):
        with open(p, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if line:
                    classes.append(line)
    return classes


def _count_images(folder):
    if not os.path.isdir(folder):
        return 0
    return sum(1 for n in os.listdir(folder)
               if n.lower().endswith(IMG_EXT))


# ---------------- 设备检测 ----------------
def detect_device():
    info = {"cuda": False, "device": "cpu", "name": "CPU", "vram_gb": None}
    try:
        import torch
        if torch.cuda.is_available():
            info["cuda"] = True
            info["device"] = "0"
            info["name"] = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            info["vram_gb"] = round(props.total_memory / 1024 ** 3, 1)
    except Exception as e:
        info["error"] = str(e)
    return info


def resolve_device(choice):
    """auto/cpu/0 -> 实际 device 参数。"""
    if choice == "cpu":
        return "cpu"
    if choice in ("0", "gpu", "GPU"):
        return "0"
    return "0" if detect_device()["cuda"] else "cpu"


def ensure_amp_weights():
    """离线环境下让 AMP 检查走本地权重，避免 ultralytics 联网 github 下载长时间重试。

    check_amp 固定需要 yolo26n.pt（仅用于 FP16/FP32 一致性校验，与训练 backbone 无关）。
    若 ultralytics 权重目录里没有，就从本地预训练权重目录复制一份，实现零联网秒过。
    """
    try:
        from ultralytics.utils import WEIGHTS_DIR
        wdir = Path(WEIGHTS_DIR).resolve()
        dst = wdir / "yolo26n.pt"
        if dst.is_file():
            return
        src = os.path.join(PRETRAINED_DIR, "yolo26n.pt")
        if os.path.isfile(src):
            wdir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    except Exception:
        # 兜底：复制失败时离线模式仍会让 check_amp 直接跳过（amp=True），不影响训练
        pass


def ensure_chinese_font():
    """离线环境下让训练图表/标签图正常显示中文类名。

    - PIL 绘图（检测框标签、val 拼图）：ultralytics 对非 ASCII 标签加载 Arial.Unicode.ttf，
      英文加载 Arial.ttf；把系统中文字体复制到其配置目录并使用这两个名字即可命中，不再联网下载。
    - matplotlib 绘图（results.png、混淆矩阵、PR/F1 曲线、labels.jpg）：把 sans-serif 首选
      字体设为系统黑体/雅黑，axes.unicode_minus=False 避免负号变方块。
    找不到系统中文字体时静默跳过（退回英文默认字体），不影响训练。
    """
    try:
        from ultralytics.utils import USER_CONFIG_DIR
        cfg_dir = Path(USER_CONFIG_DIR)
        cfg_dir.mkdir(parents=True, exist_ok=True)
        candidates = [
            r"C:\Windows\Fonts\simhei.ttf",
            r"C:\Windows\Fonts\msyh.ttc",
            r"C:\Windows\Fonts\simsun.ttc",
            "/System/Library/Fonts/PingFang.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        ]
        src = next((pth for pth in candidates if os.path.isfile(pth)), None)
        if src:
            for fn in ("Arial.ttf", "Arial.Unicode.ttf"):
                dst = cfg_dir / fn
                if not dst.exists():
                    shutil.copy2(src, dst)
        import matplotlib
        prefer = ["SimHei", "Microsoft YaHei", "SimSun", "PingFang SC",
                  "WenQuanYi Zen Hei", "Arial Unicode MS", "DejaVu Sans"]
        rest = [f for f in matplotlib.rcParams["font.sans-serif"] if f not in prefer]
        matplotlib.rcParams["font.sans-serif"] = prefer + rest
        matplotlib.rcParams["axes.unicode_minus"] = False
    except Exception as e:
        logger.debug("[train] 中文字体配置跳过（退回默认字体）: %s", e)


# ---------------- 自动划分数据集 ----------------
def split_dataset(name, val_ratio=0.2, mode="copy", seed=42):
    """把「平铺式」数据集自动划分为训练页要求的 train/val 结构。

    适用于用户上传的原始数据：images/ 与 labels/ 下文件平铺、未划分。
    划分后结构：
        datasets/<name>/images/train  images/val
        datasets/<name>/labels/train  labels/val
        datasets/<name>/data.yaml     （不存在时生成）

    - 配对规则：图片与 labels/<同名>.txt；**没有标注的图片也纳入**（YOLO 背景负样本）；
      只有标注没有图片的 txt 会被忽略（记入统计）
    - val_ratio: 验证集占比（0.05~0.5）
    - mode: "copy" 保留原始平铺文件（安全，占双倍空间）；"move" 移动（省空间）
    - seed: 随机种子，同一 seed 划分结果可复现
    """
    import random
    import shutil
    val_ratio = min(0.5, max(0.05, float(val_ratio)))
    if mode not in ("copy", "move"):
        mode = "copy"
    d = os.path.join(DATASETS_DIR, name)
    images_dir = os.path.join(d, "images")
    labels_dir = os.path.join(d, "labels")
    if not os.path.isdir(images_dir):
        return None, "数据集不存在或缺少 images 文件夹"
    if not os.path.isdir(labels_dir):
        return None, "缺少 labels 文件夹（YOLO 标注）"

    # 已划分过就拒绝，避免把 train/val 里的文件再混进新一轮划分
    for sub in ("train", "val", "test"):
        sub_dir = os.path.join(images_dir, sub)
        if os.path.isdir(sub_dir) and _count_images(sub_dir) > 0:
            return None, "该数据集已经划分过（images/%s 非空），如需重新划分请先清空 train/val/test 子目录" % sub

    classes = _read_classes(d)
    if not classes:
        return None, "缺少 classes.txt（每行一个类别名），无法生成训练配置"

    # 收集平铺图片（忽略 train/val/test 子目录本身）
    pairs = []           # (图片文件名, 标注文件名 or None)
    lonely_labels = 0
    for fn in sorted(os.listdir(images_dir)):
        fp = os.path.join(images_dir, fn)
        if not os.path.isfile(fp) or not fn.lower().endswith(IMG_EXT):
            continue
        stem = os.path.splitext(fn)[0]
        lbl = None
        for ext in (".txt",):
            cand = os.path.join(labels_dir, stem + ext)
            if os.path.isfile(cand):
                lbl = stem + ext
                break
        pairs.append((fn, lbl))
    for fn in os.listdir(labels_dir):
        if not fn.lower().endswith(".txt"):
            continue
        stem = os.path.splitext(fn)[0]
        img_hit = any(os.path.splitext(p[0])[0] == stem for p in pairs)
        if not img_hit:
            lonely_labels += 1
    if not pairs:
        return None, "images 文件夹里没有找到图片"

    # 随机打乱后按比例切分
    rng = random.Random(seed)
    rng.shuffle(pairs)
    n_val = max(1, int(round(len(pairs) * val_ratio)))
    n_val = min(n_val, len(pairs) - 1)     # 保证训练集至少 1 张
    val_pairs = pairs[:n_val]
    train_pairs = pairs[n_val:]

    # 建目录并写入
    for sub in ("train", "val"):
        os.makedirs(os.path.join(images_dir, sub), exist_ok=True)
        os.makedirs(os.path.join(labels_dir, sub), exist_ok=True)

    def _place(pair, split):
        fn, lbl = pair
        src_img = os.path.join(images_dir, fn)
        dst_img = os.path.join(images_dir, split, fn)
        if mode == "move":
            shutil.move(src_img, dst_img)
        else:
            shutil.copy2(src_img, dst_img)
        if lbl:
            src_lbl = os.path.join(labels_dir, lbl)
            dst_lbl = os.path.join(labels_dir, split, lbl)
            if mode == "move":
                shutil.move(src_lbl, dst_lbl)
            else:
                shutil.copy2(src_lbl, dst_lbl)

    for p in train_pairs:
        _place(p, "train")
    for p in val_pairs:
        _place(p, "val")

    # 生成 data.yaml（已存在则不覆盖，尊重手动修改）
    yaml_path = os.path.join(d, "data.yaml")
    if not os.path.isfile(yaml_path):
        names_block = "\n".join("  %d: %s" % (i, c) for i, c in enumerate(classes))
        content = ("path: %s\ntrain: images/train\nval: images/val\n\nnc: %d\nnames:\n%s\n"
                   % (d.replace("\\", "/"), len(classes), names_block))
        with open(yaml_path, "w", encoding="utf-8") as f:
            f.write(content)

    return {
        "total": len(pairs),
        "train": len(train_pairs),
        "val": len(val_pairs),
        "without_label": sum(1 for _, l in pairs if not l),
        "lonely_labels": lonely_labels,
        "mode": mode,
        "val_ratio": val_ratio,
    }, None


# ---------------- 拉取官方最新预训练权重 ----------------
# 权重托管在 ultralytics/assets 的 GitHub Release（最新一版里含 200+ 个文件，
# 含 SAM / RT-DETR 等，全部拉取要数 GB），因此这里按"系列 + 任务"筛选，只拉需要的。
GH_API_LATEST = "https://api.github.com/repos/ultralytics/assets/releases/latest"

# 候选系列（按顺序探测：取 release 里实际存在的第一个）
SERIES_CANDIDATES = ["yolo26", "yolo12", "yolo11", "yolov8"]
# 任务后缀：''=检测, '-pose'=姿态（本项目工控页用到检测与姿态）
TASK_SUFFIXES = ["", "-pose"]
# 每个系列的规模档
SCALES = ["n", "s", "m", "l", "x"]

_FETCH_LOCK = threading.Lock()
_FETCH = {
    "running": False, "tag": "", "total": 0, "done": 0,
    "current": "", "items": [], "errors": [], "finished": False,
}


def fetch_latest_weights_info(series=None, tasks=None):
    """查询官方最新 Release 里可下载的预训练权重清单。

    返回 (info, err)。info = {tag, series, items:[{name,size,exists,url}], total_size}
    """
    import urllib.request
    tasks = tasks or TASK_SUFFIXES
    try:
        req = urllib.request.Request(
            GH_API_LATEST, headers={"User-Agent": "yolo-detection-console"})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return None, "无法连接 GitHub 查询最新版本（%s）" % e
    tag = data.get("tag_name") or ""
    assets = {a.get("name"): a for a in (data.get("assets") or [])}

    # 选定系列：优先用户指定，否则按候选顺序挑 release 里确实存在的
    picked = None
    for s in ([series] if series else SERIES_CANDIDATES):
        if any(n.startswith(s) for n in assets):
            picked = s
            break
    if not picked:
        return None, "最新版本 %s 里没有找到可用的 YOLO 权重" % tag

    items = []
    for sc in SCALES:
        for t in tasks:
            name = "%s%s%s.pt" % (picked, sc, t)
            a = assets.get(name)
            if not a:
                continue
            items.append({
                "name": name,
                "size": a.get("size") or 0,
                "url": a.get("browser_download_url") or "",
                "exists": os.path.isfile(os.path.join(PRETRAINED_DIR, name)),
            })
    if not items:
        return None, "最新版本 %s 里没有匹配到 %s 系列的权重" % (tag, picked)
    return {"tag": tag, "series": picked, "items": items,
            "total_size": sum(i["size"] for i in items),
            "missing": sum(1 for i in items if not i["exists"])}, None


def start_fetch_weights(names):
    """后台线程下载指定权重到 PRETRAINED_DIR（不阻塞 Flask 单 worker）。"""
    global _FETCH
    with _FETCH_LOCK:
        if _FETCH["running"]:
            return False, "已有下载任务在进行中"
        if not names:
            return False, "没有选择要下载的权重"
        info, err = fetch_latest_weights_info()
        if err:
            return False, err
        by_name = {i["name"]: i for i in info["items"]}
        picked = [by_name[n] for n in names if n in by_name]
        if not picked:
            return False, "所选权重不在最新版本的清单里"
        _FETCH = {"running": True, "tag": info["tag"], "total": len(picked), "done": 0,
                  "current": "", "items": [i["name"] for i in picked],
                  "errors": [], "finished": False}
    threading.Thread(target=_fetch_worker, args=(picked,), daemon=True).start()
    return True, None


def _fetch_worker(items):
    """逐个下载：先写 .part 临时文件，完成后改名，避免留下半截的 .pt。"""
    import urllib.request
    os.makedirs(PRETRAINED_DIR, exist_ok=True)
    for it in items:
        _FETCH["current"] = it["name"]
        dest = os.path.join(PRETRAINED_DIR, it["name"])
        tmp = dest + ".part"
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
            req = urllib.request.Request(
                it["url"], headers={"User-Agent": "yolo-detection-console"})
            with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f, length=1024 * 512)
            os.replace(tmp, dest)
            _FETCH["done"] += 1
        except Exception as e:
            _FETCH["errors"].append({"name": it["name"], "msg": str(e)})
            if os.path.isfile(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
    _FETCH["current"] = ""
    _FETCH["running"] = False
    _FETCH["finished"] = True


def fetch_weights_status():
    with _FETCH_LOCK:
        return dict(_FETCH)


# ---------------- 扫描 ----------------
def scan_datasets():
    """扫 DATASETS_DIR 下含 images/ + classes.txt 的子文件夹。"""
    out = []
    if not os.path.isdir(DATASETS_DIR):
        return out
    for name in sorted(os.listdir(DATASETS_DIR)):
        d = os.path.join(DATASETS_DIR, name)
        if not os.path.isdir(d):
            continue
        images_dir = os.path.join(d, "images")
        if not os.path.isdir(images_dir):
            continue
        classes = _read_classes(d)
        if not classes:
            continue
        train_n = _count_images(os.path.join(images_dir, "train"))
        val_dir = os.path.join(images_dir, "val")
        val_name = "val"
        if not os.path.isdir(val_dir):
            val_dir = os.path.join(images_dir, "test")
            val_name = "test"
        val_n = _count_images(val_dir)
        out.append({
            "name": name,
            "classes": classes,
            "num_classes": len(classes),
            "train_count": train_n,
            "val_count": val_n,
            "val_split": val_name,
        })
    return out


def scan_backbones():
    """扫 PRETRAINED_DIR 下的 .pt 权重。"""
    out = []
    if not os.path.isdir(PRETRAINED_DIR):
        return out
    for name in sorted(os.listdir(PRETRAINED_DIR)):
        if name.lower().endswith(".pt"):
            p = os.path.join(PRETRAINED_DIR, name)
            out.append({"file": name, "size_bytes": os.path.getsize(p)})
    return out


def build_data_yaml(dataset_name):
    """在数据集目录生成 data.yaml，返回其绝对路径。"""
    ds = next((d for d in scan_datasets() if d["name"] == dataset_name), None)
    if not ds:
        raise ValueError("数据集不存在或结构不完整")
    ds_dir = os.path.join(DATASETS_DIR, dataset_name)
    classes = ds["classes"]
    names_block = "\n".join(f"  {i}: {c}" for i, c in enumerate(classes))
    content = (
        f"path: {ds_dir.replace(chr(92), '/')}\n"
        f"train: images/train\n"
        f"val: images/{ds['val_split']}\n\n"
        f"nc: {len(classes)}\n"
        f"names:\n{names_block}\n"
    )
    yaml_path = os.path.join(ds_dir, "data.yaml")
    with open(yaml_path, "w", encoding="utf-8") as f:
        f.write(content)
    return yaml_path


# ---------------- DB 辅助 ----------------
def _update_job(job_name, **fields):
    if not fields:
        return
    keys = ", ".join(f"{k}=%s" for k in fields)
    vals = list(fields.values()) + [job_name]
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE training_jobs SET {keys} WHERE job_name=%s", vals)
        conn.commit()
    finally:
        conn.close()


def _get_job(job_name):
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM training_jobs WHERE job_name=%s", (job_name,))
            return cur.fetchone()
    finally:
        conn.close()


# ---------------- 训练线程 ----------------
def start_job(params, username):
    """创建并启动训练任务。params 为表单 dict。"""
    with _ACTIVE_LOCK:
        if ACTIVE["job_name"]:
            return None, "有训练任务正在进行，请等待其结束"

    dataset_name = (params.get("dataset_name") or "").strip()
    backbone = (params.get("backbone_file") or "").strip()
    ds = next((d for d in scan_datasets() if d["name"] == dataset_name), None)
    if not ds:
        return None, "请选择有效的数据集"
    # 未划分保护：数据集只有平铺的 images/labels 时 train/val 为空，
    # 直接训练会在数据加载阶段失败（报错很晦涩），这里提前给出明确提示
    if not ds.get("train_count") or not ds.get("val_count"):
        return None, ("数据集「%s」尚未划分（训练集 %s 张 / 验证集 %s 张）。"
                      "请先在训练页点「自动划分」把 images 与 labels 切成 train/val 后再训练"
                      % (dataset_name, ds.get("train_count", 0), ds.get("val_count", 0)))
    if not any(b["file"] == backbone for b in scan_backbones()):
        return None, "请选择有效的基础模型"

    job_name = (params.get("job_name") or "").strip()
    if not job_name:
        job_name = datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + dataset_name
    if not _safe_job_name(job_name):
        return None, "任务名只能含字母、数字、下划线、横线"
    if os.path.isdir(os.path.join(RUNS_DIR, job_name)):
        return None, "任务名已存在，请换一个"

    try:
        epochs = int(params.get("epochs", 100))
        imgsz = int(params.get("imgsz", 640))
    except ValueError:
        return None, "epochs / imgsz 必须是整数"
    batch = str(params.get("batch", "16")).strip() or "16"
    optimizer = (params.get("optimizer") or "auto").strip()
    patience = int(params.get("patience") or 50)
    device_choice = (params.get("device") or "auto").strip()

    def optf(key):
        v = params.get(key)
        if v in (None, "", "null"):
            return None
        return float(v)

    lr0 = optf("lr0")
    mosaic = optf("mosaic")
    degrees = optf("degrees")
    mixup = optf("mixup")

    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO training_jobs "
                "(job_name,dataset_name,backbone_file,epochs,batch,imgsz,optimizer,lr0,"
                "mosaic,degrees,mixup,patience,device,status,total_epochs,created_by,started_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'running',%s,%s,NOW())",
                (job_name, dataset_name, backbone, epochs, batch, imgsz, optimizer, lr0,
                 mosaic, degrees, mixup, patience, device_choice, epochs, username),
            )
        conn.commit()
    finally:
        conn.close()

    os.makedirs(RUNS_DIR, exist_ok=True)
    os.makedirs(REPORTS_DIR, exist_ok=True)

    cfg = dict(dataset_name=dataset_name, backbone=backbone, epochs=epochs,
               batch=batch, imgsz=imgsz, optimizer=optimizer, lr0=lr0,
               mosaic=mosaic, degrees=degrees, mixup=mixup, patience=patience,
               device_choice=device_choice)
    t = threading.Thread(target=_run_wrapper, args=(job_name, cfg, False), daemon=True)
    with _ACTIVE_LOCK:
        ACTIVE["job_name"] = job_name
        ACTIVE["stop_mode"] = None
        ACTIVE["epoch_start_ts"] = time.time()
        ACTIVE["last_epoch_sec"] = None
        ACTIVE["thread"] = t
    t.start()
    return job_name, None


def resume_job(job_name):
    job = _get_job(job_name)
    if not job:
        return None, "任务不存在"
    if job["status"] == "running":
        return None, "该任务正在训练中"
    last_pt = os.path.join(RUNS_DIR, job_name, "weights", "last.pt")
    if not os.path.isfile(last_pt):
        return None, "没有可续训的权重 last.pt"
    with _ACTIVE_LOCK:
        if ACTIVE["job_name"]:
            return None, "有训练任务正在进行，请等待其结束"

    cfg = dict(resume_weights=last_pt)
    _update_job(job_name, status="running", finished_at=None, log_tail=None)
    t = threading.Thread(target=_run_wrapper, args=(job_name, cfg, True), daemon=True)
    with _ACTIVE_LOCK:
        ACTIVE["job_name"] = job_name
        ACTIVE["stop_mode"] = None
        ACTIVE["epoch_start_ts"] = time.time()
        ACTIVE["last_epoch_sec"] = None
        ACTIVE["thread"] = t
    t.start()
    return job_name, None


def request_stop(job_name, mode):
    """mode='finish' 收尾入库；mode='abort' 暂停放弃。"""
    if mode not in ("finish", "abort"):
        return False, "未知停止方式"
    with _ACTIVE_LOCK:
        if ACTIVE["job_name"] != job_name:
            return False, "该任务当前不在训练"
        ACTIVE["stop_mode"] = mode
    return True, None


def _run_wrapper(job_name, cfg, is_resume):
    """训练线程外层，统一异常处理与收尾。"""
    aborted = False
    try:
        _run_training(job_name, cfg, is_resume)
    except _AbortTraining:
        aborted = True
    except Exception:
        _update_job(job_name, status="failed", finished_at=_now(),
                    log_tail=traceback.format_exc()[-4000:])
        _reset_active(job_name)
        return

    if aborted or ACTIVE.get("stop_mode") == "abort":
        _job = _get_job(job_name)
        _ep = (_job or {}).get("progress_epoch") or 0
        if _ep > 0:
            _update_job(job_name, status="paused", finished_at=_now())
        else:
            _update_job(job_name, status="interrupted", finished_at=_now(),
                        log_tail="训练尚未开始即被取消，无可续训的权重")
        _reset_active(job_name)
        return

    # 正常完成（含 finish 收尾）：入库 + 报告
    try:
        _finalize_job(job_name)
        _update_job(job_name, status="done", finished_at=_now())
    except Exception:
        _update_job(job_name, status="failed", finished_at=_now(),
                    log_tail="收尾失败:\n" + traceback.format_exc()[-4000:])
    _reset_active(job_name)


def _reset_active(job_name):
    with _ACTIVE_LOCK:
        if ACTIVE["job_name"] == job_name:
            ACTIVE["job_name"] = None
            ACTIVE["stop_mode"] = None
            ACTIVE["thread"] = None
            ACTIVE["last_epoch_sec"] = None


def _run_training(job_name, cfg, is_resume):
    from ultralytics import YOLO

    ensure_amp_weights()
    ensure_chinese_font()
    log = []

    def push_log(msg):
        log.append(msg)
        if len(log) > 200:
            del log[:len(log) - 200]

    def on_epoch_end(trainer):
        # 计时
        now_ts = time.time()
        if ACTIVE["epoch_start_ts"]:
            ACTIVE["last_epoch_sec"] = now_ts - ACTIVE["epoch_start_ts"]
        ACTIVE["epoch_start_ts"] = now_ts

        ep = int(getattr(trainer, "epoch", 0)) + 1
        total = int(getattr(trainer, "epochs", cfg.get("epochs", 0)))
        _update_job(job_name, progress_epoch=ep, total_epochs=total)

    def on_fit_epoch_metrics(trainer):
        # 每轮验证结束后 mAP / loss 才就绪，在这里落库（on_train_epoch_end 时还没有）
        ep = int(getattr(trainer, "epoch", 0)) + 1
        total = int(getattr(trainer, "epochs", cfg.get("epochs", 0)))
        metrics = getattr(trainer, "metrics", None) or {}
        map50 = metrics.get("metrics/mAP50(B)")
        loss = None
        tloss = getattr(trainer, "tloss", None)
        try:
            if tloss is not None:
                loss = float(tloss.detach().cpu()) if hasattr(tloss, "detach") else float(tloss)
        except Exception:
            loss = None
        fields = {"progress_epoch": ep, "total_epochs": total}
        if map50 is not None and not (isinstance(map50, float) and map50 != map50):
            fields["best_map50"] = round(float(map50), 4)
        if loss is not None:
            fields["final_loss"] = round(loss, 4)
        fields["log_tail"] = "\n".join(log[-30:]) or f"第 {ep}/{total} 轮完成"
        _update_job(job_name, **fields)
        push_log(f"[{_now()}] 第 {ep}/{total} 轮完成，mAP50={map50}, loss={loss}")

        mode = ACTIVE["stop_mode"]
        if mode == "finish":
            # 让训练跑完当前 epoch 后自然结束，走 ultralytics 正常收尾（最终验证+保存）
            trainer.epochs = trainer.epoch + 1
            push_log("收到结束指令，将在本轮后收尾")
        elif mode == "abort":
            push_log("收到暂停指令，放弃本次训练")
            try:
                trainer.save_model()
            except Exception as e:
                logger.warning("[train] 暂停时保存 last.pt 失败: %s", e)
            raise _AbortTraining()

    def check_stop(trainer, stage):
        """在训练更早的阶段检查停止指令（AMP/扫描之后、每轮 batch 开始前）。"""
        mode = ACTIVE["stop_mode"]
        if mode == "abort":
            push_log(f"收到暂停指令，于「{stage}」放弃本次训练")
            raise _AbortTraining()
        if mode == "finish":
            try:
                cur_ep = int(getattr(trainer, "epoch", 0))
                total_ep = int(getattr(trainer, "epochs", 1))
                if total_ep > cur_ep + 1:
                    trainer.epochs = cur_ep + 1
                    push_log(f"收到结束指令，将在当前轮后收尾（{stage}）")
            except Exception as e:
                logger.debug("[train] 调整结束轮次失败: %s", e)

    def on_train_start(trainer):
        push_log(f"[{_now()}] 训练正式开始（进入 epoch 循环）")
        _update_job(job_name, log_tail="\n".join(log[-30:]) or "训练开始")
        check_stop(trainer, "训练开始")

    def on_epoch_start(trainer):
        check_stop(trainer, "轮次开始")

    def on_fit_end(trainer):
        push_log(f"[{_now()}] 训练结束")

    if is_resume:
        model = YOLO(cfg["resume_weights"])
        model.add_callback("on_train_start", on_train_start)
        model.add_callback("on_train_epoch_start", on_epoch_start)
        model.add_callback("on_train_epoch_end", on_epoch_end)
        model.add_callback("on_fit_epoch_end", on_fit_epoch_metrics)
        model.add_callback("on_fit_end", on_fit_end)
        push_log("从断点恢复训练 ...")
        _update_job(job_name, log_tail="从断点恢复训练 ...")
        model.train(resume=True)
        return

    push_log(f"[{_now()}] 正在准备训练环境（生成配置、扫描数据集、AMP 校验）…")
    _update_job(job_name, log_tail=log[-1])
    data_yaml = build_data_yaml(cfg["dataset_name"])
    backbone_path = os.path.join(PRETRAINED_DIR, cfg["backbone"])
    device = resolve_device(cfg["device_choice"])
    model = YOLO(backbone_path)
    model.add_callback("on_train_start", on_train_start)
    model.add_callback("on_train_epoch_start", on_epoch_start)
    model.add_callback("on_train_epoch_end", on_epoch_end)
    model.add_callback("on_fit_end", on_fit_end)

    train_kwargs = dict(
        data=data_yaml,
        epochs=cfg["epochs"],
        batch=int(cfg["batch"]) if cfg["batch"].lstrip("-").isdigit() else cfg["batch"],
        imgsz=cfg["imgsz"],
        device=device,
        project=RUNS_DIR,
        name=job_name,
        exist_ok=False,
        patience=cfg["patience"],
        verbose=True,
    )
    if cfg["optimizer"] and cfg["optimizer"] != "auto":
        train_kwargs["optimizer"] = cfg["optimizer"]
    if cfg["lr0"] is not None:
        train_kwargs["lr0"] = cfg["lr0"]
    if cfg["mosaic"] is not None:
        train_kwargs["mosaic"] = cfg["mosaic"]
    if cfg["degrees"] is not None:
        train_kwargs["degrees"] = cfg["degrees"]
    if cfg["mixup"] is not None:
        train_kwargs["mixup"] = cfg["mixup"]
    # 集装箱刚性物体默认保守增强
    train_kwargs.setdefault("degrees", 0.0)
    train_kwargs.setdefault("mixup", 0.0)
    train_kwargs.setdefault("mosaic", 1.0)
    train_kwargs["close_mosaic"] = 10
    train_kwargs["cos_lr"] = True

    push_log(f"[{_now()}] 开始训练：{cfg['backbone']} / {cfg['dataset_name']} / device={device}")
    _update_job(job_name, log_tail="\n".join(log[-30:]))
    model.train(**train_kwargs)


def _finalize_job(job_name):
    """训练完成：best.pt 入模型库 + 生成 HTML 报告。"""
    run_dir = os.path.join(RUNS_DIR, job_name)
    best_pt = os.path.join(run_dir, "weights", "best.pt")
    job = _get_job(job_name)

    # 1) best.pt 复制到 models_lib 并写 models 表
    model_id = None
    model_file = ""
    if os.path.isfile(best_pt):
        os.makedirs(MODELS_DIR, exist_ok=True)
        disk_name = uuid.uuid4().hex + ".pt"
        dest = os.path.join(MODELS_DIR, disk_name)
        shutil.copy2(best_pt, dest)
        size = os.path.getsize(dest)
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO models (name,file_name,tags,note,size_bytes,status) "
                    "VALUES (%s,%s,%s,%s,%s,'ready')",
                    (job_name, disk_name, "训练产物",
                     f"由训练任务 {job_name} 自动入库", size),
                )
                model_id = cur.lastrowid
            conn.commit()
        finally:
            conn.close()
        model_file = disk_name

    # 2) 生成 HTML 报告
    report_path = ""
    try:
        report_path = generate_report(job_name)
    except Exception:
        report_path = ""

    # 3) 解析最终耗时
    elapsed = 0
    if job and job.get("started_at"):
        try:
            elapsed = int((datetime.now() - job["started_at"]).total_seconds())
        except Exception:
            elapsed = 0

    _update_job(job_name, model_id=model_id, model_file=model_file,
                report_path=report_path, elapsed_sec=elapsed)


# ---------------- 报告 ----------------
def _img_b64(path):
    if not os.path.isfile(path):
        return ""
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    mime = "jpeg" if ext in ("jpg", "jpeg") else ext
    with open(path, "rb") as f:
        return f"data:image/{mime};base64," + base64.b64encode(f.read()).decode()


def _read_results_csv(run_dir):
    """返回 (表头, 行列表)。"""
    p = os.path.join(run_dir, "results.csv")
    if not os.path.isfile(p):
        return [], []
    with open(p, "r", encoding="utf-8", errors="ignore") as f:
        rows = list(csv.reader(f))
    if not rows:
        return [], []
    header = [h.strip() for h in rows[0]]
    data = [[c.strip() for c in r] for r in rows[1:] if r]
    return header, data


def generate_report(job_name):
    run_dir = os.path.join(RUNS_DIR, job_name)
    if not os.path.isdir(run_dir):
        raise ValueError("训练输出目录不存在")
    job = _get_job(job_name) or {}
    header, data = _read_results_csv(run_dir)

    best_map50 = job.get("best_map50")
    best_row = None
    if header and data:
        try:
            idx = header.index("metrics/mAP50(B)")
            best_row = max(data, key=lambda r: float(r[idx]) if r[idx] not in ("", "nan") else -1)
            if best_map50 is None:
                best_map50 = round(float(best_row[idx]), 4)
        except (ValueError, IndexError):
            pass

    def cell(row, name):
        try:
            return row[header.index(name)]
        except (ValueError, IndexError, TypeError):
            return "-"

    charts = [
        ("训练总览曲线 results.png", "results.png"),
        ("混淆矩阵 confusion_matrix.png", "confusion_matrix.png"),
        ("精确率-召回率曲线 PR_curve.png", "PR_curve.png"),
        ("F1 曲线 F1_curve.png", "F1_curve.png"),
        ("标注分布 labels.jpg", "labels.jpg"),
    ]
    chart_html = ""
    for title, fn in charts:
        b64 = _img_b64(os.path.join(run_dir, fn))
        if b64:
            chart_html += f'<h3>{title}</h3><img src="{b64}" />'

    metric_rows = ""
    if best_row:
        items = [
            ("最佳轮次", cell(best_row, "epoch")),
            ("mAP50", cell(best_row, "metrics/mAP50(B)")),
            ("mAP50-95", cell(best_row, "metrics/mAP50-95(B)")),
            ("Precision", cell(best_row, "metrics/precision(B)")),
            ("Recall", cell(best_row, "metrics/recall(B)")),
            ("train box_loss", cell(best_row, "train/box_loss")),
            ("train cls_loss", cell(best_row, "train/cls_loss")),
            ("train dfl_loss", cell(best_row, "train/dfl_loss")),
        ]
        metric_rows = "".join(
            f"<tr><th>{k}</th><td>{v}</td></tr>" for k, v in items)

    params = [
        ("数据集", job.get("dataset_name", "-")),
        ("基础模型", job.get("backbone_file", "-")),
        ("epochs", job.get("epochs", "-")),
        ("batch", job.get("batch", "-")),
        ("imgsz", job.get("imgsz", "-")),
        ("optimizer", job.get("optimizer", "-")),
        ("patience", job.get("patience", "-")),
        ("device", job.get("device", "-")),
        ("创建人", job.get("created_by", "-")),
        ("开始时间", job.get("started_at", "-")),
        ("结束时间", job.get("finished_at", "-")),
    ]
    param_rows = "".join(f"<tr><th>{k}</th><td>{v}</td></tr>" for k, v in params)

    html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>训练报告 · {job_name}</title>
<style>
body{{font-family:'Microsoft YaHei',sans-serif;margin:0;background:#0f141b;color:#e6e9ee;padding:32px;}}
h1{{font-size:26px;margin:0 0 4px;}} .sub{{color:#9aa3b2;margin-bottom:28px;}}
.grid{{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px;}}
.card{{background:#1a212c;border:1px solid #2a3342;border-radius:12px;padding:20px;}}
.card h2{{font-size:16px;margin:0 0 14px;color:#7fd4ff;}}
table{{width:100%;border-collapse:collapse;font-size:14px;}}
th{{text-align:left;color:#9aa3b2;padding:6px 8px;font-weight:normal;width:45%;}}
td{{padding:6px 8px;}}
img{{width:100%;border-radius:8px;margin:8px 0 24px;border:1px solid #2a3342;}}
h3{{color:#cdd5e0;font-size:15px;margin:20px 0 6px;}}
.badge{{display:inline-block;background:#13351f;color:#57d98a;padding:3px 12px;border-radius:20px;font-size:13px;}}
</style></head><body>
<h1>训练报告 · {job_name}</h1>
<div class="sub">生成时间 {_now()} &nbsp; <span class="badge">已完成</span></div>
<div class="grid">
  <div class="card"><h2>关键指标（最佳轮次）</h2><table>{metric_rows or '<tr><td>暂无指标数据</td></tr>'}</table></div>
  <div class="card"><h2>训练配置</h2><table>{param_rows}</table></div>
</div>
<div class="card"><h2>训练图表</h2>{chart_html or '<p>暂无图表</p>'}</div>
</body></html>"""

    os.makedirs(REPORTS_DIR, exist_ok=True)
    out_path = os.path.join(REPORTS_DIR, job_name + ".html")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    return out_path


# ---------------- 列表 / 删除 / 锁定 ----------------
def _job_to_dict(row):
    d = dict(row)
    for k in ("lr0", "mosaic", "degrees", "mixup", "best_map50", "final_loss"):
        if d.get(k) is not None:
            d[k] = float(d[k])
    # datetime -> str
    for k in ("created_at", "started_at", "finished_at"):
        v = d.get(k)
        if v is not None and not isinstance(v, str):
            d[k] = v.strftime("%Y-%m-%d %H:%M:%S")
    return d


def list_jobs():
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM training_jobs ORDER BY id DESC")
            rows = cur.fetchall()
    finally:
        conn.close()
    jobs = [_job_to_dict(r) for r in rows]

    # runs 目录兜底：DB 没登记但磁盘有的输出目录
    known = {j["job_name"] for j in jobs}
    if os.path.isdir(RUNS_DIR):
        for name in sorted(os.listdir(RUNS_DIR), reverse=True):
            d = os.path.join(RUNS_DIR, name)
            if os.path.isdir(d) and name not in known and not name.startswith("."):
                jobs.append({
                    "job_name": name, "dataset_name": "", "backbone_file": "",
                    "status": "unregistered", "progress_epoch": 0, "total_epochs": 0,
                    "best_map50": None, "note": "未登记的历史输出",
                })

    # 活动任务补实时信息
    with _ACTIVE_LOCK:
        active_name = ACTIVE["job_name"]
        last_sec = ACTIVE["last_epoch_sec"]
        epoch_start = ACTIVE["epoch_start_ts"]
    for j in jobs:
        if j["job_name"] == active_name and j["status"] == "running":
            j["active"] = True
            remain = None
            total = j.get("total_epochs") or 0
            done = j.get("progress_epoch") or 0
            if last_sec and total > done:
                remain = int(last_sec * (total - done))
            j["eta_sec"] = remain
            j["current_epoch_sec"] = int(time.time() - epoch_start) if epoch_start else None
        else:
            j["active"] = False
        # 产物文件信息
        run_dir = os.path.join(RUNS_DIR, j["job_name"])
        wdir = os.path.join(run_dir, "weights")
        j["has_best"] = os.path.isfile(os.path.join(wdir, "best.pt"))
        j["has_last"] = os.path.isfile(os.path.join(wdir, "last.pt"))
        j["has_report"] = bool(j.get("report_path")) and os.path.isfile(j["report_path"])
    return jobs


def job_detail(job_name):
    if not _safe_job_name(job_name):
        return None
    row = _get_job(job_name)
    if not row:
        # 未登记任务
        run_dir = os.path.join(RUNS_DIR, job_name)
        if not os.path.isdir(run_dir):
            return None
        d = {"job_name": job_name, "status": "unregistered"}
    else:
        d = _job_to_dict(row)
    run_dir = os.path.join(RUNS_DIR, job_name)
    # 产物大小：列出 weights 目录所有文件（含 ONNX/TFLite 等导出产物），best.pt/last.pt 优先
    artifacts = []
    wdir = os.path.join(run_dir, "weights")
    if os.path.isdir(wdir):
        files = [f for f in os.listdir(wdir)
                 if os.path.isfile(os.path.join(wdir, f))]
        prio = {"best.pt": 0, "last.pt": 1}
        files.sort(key=lambda f: (prio.get(f, 9), f.lower()))
        for fn in files:
            artifacts.append({"file": fn, "size_bytes": os.path.getsize(os.path.join(wdir, fn))})
    d["artifacts"] = artifacts
    # results.csv 末尾指标
    header, data = _read_results_csv(run_dir)
    d["result_rows"] = len(data)
    if data:
        last = data[-1]

        def g(name):
            try:
                return last[header.index(name)]
            except (ValueError, IndexError):
                return None
        d["last_map50_95"] = g("metrics/mAP50-95(B)")
        d["last_precision"] = g("metrics/precision(B)")
        d["last_recall"] = g("metrics/recall(B)")
    return d


def export_model(job_name, fmt):
    """把已完成任务的 best.pt 导出为 ONNX/TFLite/TorchScript 等格式。

    导出产物默认落在 runs/<job>/weights/ 下（ultralytics 行为），详情页产物列表会自动列出。
    缺少对应依赖（如 TFLite 需 tensorflow）时返回友好提示，不抛异常。
    """
    if not _safe_job_name(job_name):
        return None, "任务名不合法"
    job = _get_job(job_name)
    if not job:
        return None, "任务不存在"
    if job["status"] != "done":
        return None, "仅已完成的任务可导出模型"
    best_pt = os.path.join(RUNS_DIR, job_name, "weights", "best.pt")
    if not os.path.isfile(best_pt):
        return None, "未找到 best.pt，无法导出"
    fmt = (fmt or "").strip().lower()
    valid = {"onnx", "tflite", "torchscript", "tensorrt", "openvino",
             "coreml", "paddle", "engine", "saved_model", "pb", "ncnn"}
    if fmt not in valid:
        return None, "不支持的导出格式：" + fmt
    try:
        from ultralytics import YOLO
        model = YOLO(best_pt)
        imgsz = int(job.get("imgsz") or 640)
        kwargs = dict(format=fmt, imgsz=imgsz, simplify=True, half=False)
        if fmt == "onnx":
            kwargs["opset"] = 17
            kwargs["dynamic"] = False
        path = model.export(**kwargs)
        out_path = str(path) if path else ""
        size = os.path.getsize(out_path) if out_path and os.path.isfile(out_path) else 0
        return {"format": fmt, "path": out_path,
                "file_name": os.path.basename(out_path) if out_path else "",
                "size_bytes": size}, None
    except ImportError as e:
        return None, ("缺少依赖：%s。请在 yolo26 环境安装对应库后重试 "
                       "（如 pip install tensorflow / openvino / coremltools）。" % e)
    except Exception as e:
        return None, "导出失败：%s" % e


def delete_job(job_name):
    if not _safe_job_name(job_name):
        return False, "任务名不合法"
    with _ACTIVE_LOCK:
        if ACTIVE["job_name"] == job_name:
            return False, "任务正在训练，不能删除"
    # 删 runs 目录
    run_dir = os.path.join(RUNS_DIR, job_name)
    if os.path.isdir(run_dir):
        shutil.rmtree(run_dir, ignore_errors=True)
    # 删报告
    rp = os.path.join(REPORTS_DIR, job_name + ".html")
    if os.path.isfile(rp):
        try:
            os.remove(rp)
        except OSError as e:
            logger.debug("[train] 删除报告文件失败: %s", e)
    # 删 DB 记录（不联动删 models_lib 已入库模型）
    conn = db.get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM training_jobs WHERE job_name=%s", (job_name,))
        conn.commit()
    finally:
        conn.close()
    return True, None


def lock_status():
    with _ACTIVE_LOCK:
        name = ACTIVE["job_name"]
        last_sec = ACTIVE["last_epoch_sec"]
    if not name:
        return {"locked": False}
    job = _get_job(name)
    eta = None
    if job and last_sec:
        total = job.get("total_epochs") or 0
        done = job.get("progress_epoch") or 0
        if total > done:
            eta = int(last_sec * (total - done))
    return {"locked": True, "job_name": name, "eta_sec": eta}


def open_datasets_dir():
    import subprocess as _sp
    os.makedirs(DATASETS_DIR, exist_ok=True)
    try:
        _sp.Popen(['explorer', DATASETS_DIR])
        return True
    except Exception:
        try:
            os.startfile(DATASETS_DIR)
            return True
        except Exception:
            return False


def open_backbones_dir():
    import subprocess as _sp
    os.makedirs(PRETRAINED_DIR, exist_ok=True)
    try:
        _sp.Popen(['explorer', PRETRAINED_DIR])
        return True
    except Exception:
        try:
            os.startfile(PRETRAINED_DIR)
            return True
        except Exception:
            return False
