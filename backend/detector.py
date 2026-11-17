# -*- coding: utf-8 -*-
"""YOLO 推理服务：模型扫描、懒加载、单例缓存、图片/视频推理。"""
import os
import time
import threading
import logging
import concurrent.futures
import cv2
import numpy as np
from ultralytics import YOLO
# Annotator/colors：用于在**原尺寸**帧上重画检测框（视频推理降分辨率时保持框线锐利）
from ultralytics.utils.plotting import Annotator, colors

from config import (MODELS_DIR, DEFAULT_CONF, MAX_LOADED_MODELS,
                    MODEL_LOAD_TIMEOUT_SEC, INFER_MAX_WIDTH,
                    INFER_BOX_SMOOTH, INFER_BOX_MATCH_RATIO, INFER_BOX_MISS_MAX)

logger = logging.getLogger("helmet.detector")


class Detector:
    def __init__(self):
        self._models = {}          # file_name -> YOLO 对象（懒加载）
        self._last_used = {}       # file_name -> 最近一次使用时间（用于按最久未用释放）
        self._lock = threading.Lock()
        self._load_lock = threading.Lock()   # 模型加载互斥，避免并发重复加载同一权重
        self.current_file = None   # 当前推理用的权重文件名
        self._last_infer_ts = 0.0  # 最近一次推理的时间戳（供上层判断"是否有活跃推理"）
        os.makedirs(MODELS_DIR, exist_ok=True)
        # 单 worker 线程池：模型加载放进后台线程，主线程按超时等待，
        # 避免请求线程被加载无限期阻塞；max_workers=1 天然串行化加载。
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="model-load")

    # ---------- 模型扫描 ----------
    def scan_models(self):
        """返回 models_lib 下所有 .pt 模型文件名列表。"""
        if not os.path.isdir(MODELS_DIR):
            return []
        files = [f for f in os.listdir(MODELS_DIR) if f.lower().endswith(".pt")]
        return sorted(files)

    def model_path(self, file_name):
        return os.path.join(MODELS_DIR, file_name)

    def unload(self, file_name):
        """从内存缓存移除模型（删除模型文件时调用）。"""
        with self._lock:
            self._models.pop(file_name, None)
            self._last_used.pop(file_name, None)

    # ---------- 模型加载（懒加载 + 缓存） ----------
    def _release_vram(self):
        """主动归还显存缓存。

        只回收「已无引用」的缓存块；正在进行的推理持有自己的模型引用，
        不受影响，其显存要等那次推理结束、引用释放后才真正回收。
        """
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception as e:
            logger.debug("[detector] 释放显存缓存失败（可忽略）: %s", e)

    def _unload_others(self):
        """释放除当前模型外的所有已加载模型（全局单模型语义）。

        系统只使用管理员设定的那一个模型，切换后旧模型不应继续白占显存。
        注意：unload 只是从缓存字典移除引用，不会销毁模型对象 ——
        正在用旧模型跑的推理会正常跑完，不会被中断。
        """
        victims = []
        with self._lock:
            for fn in list(self._models.keys()):
                if fn == self.current_file:
                    continue
                self._models.pop(fn, None)
                self._last_used.pop(fn, None)
                victims.append(fn)
        if not victims:
            return
        logger.info("[detector] 切换模型后释放非当前模型: %s", "、".join(victims))
        self._release_vram()

    def _evict_if_needed(self):
        """模型数量超过上限时，释放最久未用的模型（当前使用的模型除外）。

        避免多次切换模型后所有权重常驻内存/显存，导致显存被占满。
        """
        victims = []
        with self._lock:
            if len(self._models) <= MAX_LOADED_MODELS:
                return
            # 候选：除当前模型外，按最近使用时间升序（最久未用的排前面）
            candidates = [fn for fn in self._models if fn != self.current_file]
            candidates.sort(key=lambda fn: self._last_used.get(fn, 0.0))
            while len(self._models) > MAX_LOADED_MODELS and candidates:
                victim = candidates.pop(0)
                self._models.pop(victim, None)
                self._last_used.pop(victim, None)
                victims.append(victim)
        if not victims:
            return
        logger.info("[detector] 模型缓存超过上限 %s，已释放最久未用的: %s",
                    MAX_LOADED_MODELS, "、".join(victims))
        # 主动归还显存缓存，让后续推理有空间可用
        self._release_vram()

    def _load(self, file_name, timeout=None):
        """加载（或取缓存）指定模型，带加载超时保护。

        - 命中缓存直接返回；
        - 未命中时把实际加载放进后台 worker 线程，主线程按 timeout 等待；
          超时则抛出 RuntimeError，避免请求线程被模型加载无限期阻塞
          （如 CUDA 繁忙 / OOM / 权重文件异常）。
        - worker 内部持 _load_lock，保证同一时刻只有一次权重加载（防并发重复加载）。
        """
        timeout = timeout if timeout is not None else MODEL_LOAD_TIMEOUT_SEC
        # 快速命中路径：缓存读无需持锁（CPython GIL 保证 dict 读取原子）
        if file_name in self._models:
            with self._lock:
                self._last_used[file_name] = time.time()
            return self._models[file_name]
        try:
            fut = self._executor.submit(self._load_model_impl, file_name)
            return fut.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            raise RuntimeError(
                f"模型 {file_name} 加载超时（>{timeout}s），请检查显存占用或模型文件是否损坏"
            )

    def _load_model_impl(self, file_name):
        """实际加载权重的 worker（在后台线程执行，内部持加载互斥锁）。"""
        with self._load_lock:
            # 二次检查：并发 _load 时，先到者可能已写入缓存
            model = self._models.get(file_name)
            if model is not None:
                with self._lock:
                    self._last_used[file_name] = time.time()
                return model
            path = self.model_path(file_name)
            if not os.path.exists(path):
                raise FileNotFoundError(f"模型文件不存在: {path}")
            model = YOLO(path)
            # 预热一次（空图），消除首次推理的初始化耗时
            try:
                warm = np.zeros((64, 64, 3), dtype=np.uint8)
                model(warm, verbose=False)
            except Exception as e:
                logger.warning("[detector] %s 预热推理失败（不影响加载）: %s", file_name, e)
            with self._lock:
                self._models[file_name] = model
                self._last_used[file_name] = time.time()
            self._evict_if_needed()
            return model

    def set_current(self, file_name):
        """切换当前模型：预加载新模型，并立即释放所有非当前模型。

        全局单模型语义：系统只使用管理员设定的这一个模型，切换后旧模型
        不再滞留缓存白占显存。正在用旧模型跑的推理不受影响（引用仍有效，会跑完）。
        """
        if file_name not in self.scan_models():
            raise FileNotFoundError(f"models_lib 中没有 {file_name}")
        self.current_file = file_name
        # 预加载当前模型
        self._load(file_name)
        # 立即释放非当前模型，使缓存严格保持 1 个
        self._unload_others()

    def get_current(self):
        return self.current_file

    def current_names(self):
        """当前模型的类别名 dict {idx: name}。"""
        if not self.current_file:
            return {}
        try:
            m = self._load(self.current_file)
            return m.names or {}
        except Exception:
            return {}

    # ---------- 读取模型真实元信息 ----------
    def get_model_info(self, file_name):
        """加载指定模型，返回真实元信息。

        返回 {'nc': 类别数, 'params_m': 参数量(M), 'names': 类别名逗号分隔,
              'names_list': 类别名数组}。
        names_list 供 models.classes（JSON）入库，使后续无需加载模型即可拿到类别名。
        """
        model = self._load(file_name)
        names = model.names or {}
        nc = len(names)
        # 参数量
        try:
            total = sum(p.numel() for p in model.model.parameters())
            params_m = round(total / 1e6, 1)
        except Exception:
            params_m = 0
        names_list = [str(names.get(i, i)) for i in sorted(names.keys())]
        return {
            "nc": nc,
            "params_m": params_m,
            "names": ",".join(names_list),
            "names_list": names_list,
        }

    # ---------- 推理活跃标记 ----------
    def _mark_infer(self):
        """记录"刚刚发生了推理"的时间戳。

        放在服务层而不是各个调用点，保证图片/视频/网络流等所有检测类型自动覆盖；
        上层据此判断当前是否有活跃推理（如批量读元信息的严格模式）。
        """
        self._last_infer_ts = time.time()

    def last_infer_ts(self):
        """返回最近一次推理的时间戳（从未推理过返回 0）。"""
        return self._last_infer_ts

    # ---------- 图片推理 ----------
    def ensure_loaded(self, file_name=None):
        """预热：确保模型已加载进显存，返回 (ok, msg)。

        实时推理首帧会触发模型加载（读盘 + 载入显存 + 首次 CUDA 初始化，可能数秒），
        表现为"点开启推理后卡一下"。开启推理前先调用本方法把这段耗时挪到有提示的阶段。
        """
        fn = file_name or self.current_file
        if not fn:
            return False, "未设置当前模型，请先在模型管理页选择"
        try:
            self._load(fn)
            return True, "模型已就绪"
        except Exception as e:
            logger.warning("[detector] 模型预热失败: %s", e)
            return False, f"模型加载失败: {e}"

    def detect_image(self, bgr_img, conf=DEFAULT_CONF, file_name=None, plot=True):
        """输入 BGR numpy 图像，返回 (结果图BGR, boxes_list, stats_dict, elapsed_ms)。

        file_name 指定用哪个模型（多用户并发时互不干扰），不传则用全局当前。
        plot=False 时不做 r.plot()（工控页改用前端 canvas 画框，不需要后端回图，
        省掉绘图 + JPEG 编码 + base64 传输）。
        """
        fn = file_name or self.current_file
        if not fn:
            raise RuntimeError("未设置当前模型，请先在模型管理页选择一个模型")
        model = self._load(fn)

        self._mark_infer()
        t0 = time.time()
        results = model(bgr_img, conf=conf, verbose=False)
        elapsed = int((time.time() - t0) * 1000)

        r = results[0]
        plotted = r.plot() if plot else None   # BGR ndarray，已画框

        boxes = []
        stats = {}
        names = r.names or {}
        if r.boxes is not None and len(r.boxes) > 0:
            for b in r.boxes:
                cls_id = int(b.cls[0])
                cls_name = names.get(cls_id, str(cls_id))
                cnf = float(b.conf[0])
                x1, y1, x2, y2 = [float(v) for v in b.xyxy[0]]
                boxes.append({
                    "cls": cls_id,
                    "cls_name": cls_name,
                    "conf": round(cnf, 4),
                    "x1": round(x1, 2), "y1": round(y1, 2),
                    "x2": round(x2, 2), "y2": round(y2, 2),
                })
                stats[cls_name] = stats.get(cls_name, 0) + 1

        return plotted, boxes, stats, elapsed

    # ---------- 视频推理 ----------
    def detect_video(self, input_path, output_path, conf=DEFAULT_CONF, skip=1,
                     file_name=None, progress_cb=None):
        """逐帧推理视频，写出标注后的 mp4（H.264，浏览器可播）。

        skip=每隔几帧推理一次（加速）。
        file_name 指定用哪个模型（与 detect_image 保持一致），不传则用全局当前模型。
        progress_cb: 可选回调 progress_cb(已读取帧数, 预估总帧数)，总帧数读不出时为 0。
        返回 (总帧数, 推理帧数, stats, elapsed_ms, 第一帧BGR, 代表帧boxes列表)。
        代表帧 = 第一个检测到目标的推理帧，用于详情页明细表展示。
        """
        fn = file_name or self.current_file
        if not fn:
            raise RuntimeError("未设置当前模型，请先在模型管理页选择一个模型")
        model = self._load(fn)

        self._mark_infer()
        cap = cv2.VideoCapture(input_path)
        if not cap.isOpened():
            raise RuntimeError(f"无法打开视频: {input_path}")
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        # 预估总帧数（部分容器读不出，此时为 0，前端会转成"不确定进度"）
        total_est = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

        def _emit(done):
            """按节流规则上报进度：首帧必报，之后每 30 帧或每 0.5 秒报一次。

            回调返回 False 表示**客户端已断开**（浏览器刷新/关闭），此时抛异常中止推理，
            别再白烧 CPU/GPU 把剩下的帧跑完。
            """
            # 长视频处理期间持续刷新"最近推理时间"，避免被判定为已空闲
            self._mark_infer()
            if not progress_cb:
                return
            now = time.time()
            if done == 1 or done % 30 == 0 or (now - _emit.last >= 0.5):
                _emit.last = now
                try:
                    if progress_cb(done, total_est) is False:
                        raise InterruptedError("client disconnected")
                except InterruptedError:
                    raise
                except Exception as e:
                    logger.debug("[detector] 进度回调失败（不影响处理）: %s", e)
        _emit.last = 0.0

        # output_path 为 None = 只推理并记录时间轴，**不写标注视频**（落盘策略改为
        # 「只存原视频 + 框数据」，标注视频改由用户点下载时现场绘制）。
        writer = None
        if output_path:
            # 优先 H.264(avc1)，浏览器可直接播放；不可用则退回 mp4v
            fourcc = cv2.VideoWriter_fourcc(*"avc1")
            writer = cv2.VideoWriter(output_path, fourcc, fps, (width, height))
            if not writer.isOpened():
                writer.release()
                fourcc = cv2.VideoWriter_fourcc(*"mp4v")
                writer = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

        t0 = time.time()
        total = 0
        inferred = 0
        stats = {}
        first_frame = None
        # 按类别累积：count、置信度和、坐标和（用于最后算平均）
        cls_acc = {}

        def acc_box(b, names, coord_scale=1.0):
            """累计一个框。coord_scale：把框坐标从"推理用的缩小图"还原到原尺寸的倍数。"""
            cls_id = int(b.cls[0])
            name = names.get(cls_id, str(cls_id))
            c = float(b.conf[0])
            x1, y1, x2, y2 = [float(v) * coord_scale for v in b.xyxy[0]]
            a = cls_acc.setdefault(name, {"cnt": 0, "conf": 0.0,
                                          "x1": 0.0, "y1": 0.0, "x2": 0.0, "y2": 0.0})
            a["cnt"] += 1
            a["conf"] += c
            a["x1"] += x1; a["y1"] += y1; a["x2"] += x2; a["y2"] += y2
            stats[name] = stats.get(name, 0) + 1

        # ---- 时间维度框平滑（插帧）----
        # 逐帧独立推理的框天然会抖动，抽帧时中间帧更是完全没框 → 观感"跳 / 断"。
        # 这里维护"当前目标"列表：按类别 + 中心距离匹配同一目标，对框坐标做指数平滑，
        # 并按最近速度给未推理的中间帧外推补框，输出视频里的框就是连续移动的。
        # ⚠ 只影响**绘制**；统计（stats / 聚合框坐标）仍用原始推理结果，保证计数准确。
        _tracks = []      # [{cls_name, cid, conf, box, vel, miss}]

        def _tracks_update(new_boxes, frame_w):
            """new_boxes: [(cls_name, cid, conf, [x1,y1,x2,y2])]，就地维护 _tracks。"""
            thresh2 = (frame_w * INFER_BOX_MATCH_RATIO) ** 2
            used = [False] * len(_tracks)
            for nb in new_boxes:
                cx = (nb[3][0] + nb[3][2]) / 2.0
                cy = (nb[3][1] + nb[3][3]) / 2.0
                best, bd = -1, None
                for i, t in enumerate(_tracks):
                    if used[i] or t["cls_name"] != nb[0]:
                        continue
                    tx = (t["box"][0] + t["box"][2]) / 2.0
                    ty = (t["box"][1] + t["box"][3]) / 2.0
                    d = (cx - tx) ** 2 + (cy - ty) ** 2
                    if d <= thresh2 and (bd is None or d < bd):
                        bd, best = d, i
                if best >= 0:
                    t = _tracks[best]
                    used[best] = True
                    prev = t["box"][:]
                    t["vel"] = [nb[3][k] - prev[k] for k in range(4)]     # 供中间帧外推
                    t["box"] = [prev[k] + (nb[3][k] - prev[k]) * INFER_BOX_SMOOTH for k in range(4)]
                    t["conf"] = nb[2]
                    t["miss"] = 0
                else:
                    _tracks.append({"cls_name": nb[0], "cid": nb[1], "conf": nb[2],
                                    "box": nb[3][:], "vel": [0, 0, 0, 0], "miss": 0})
                    # ⚠ used 必须与 _tracks 等长：本轮新加的目标也算"已用"，
                    # 否则后续循环按索引访问 used 会越界
                    used.append(True)
            # 本轮没匹配上的：累计 miss，超过上限判定目标消失
            _keep = []
            for i, t in enumerate(_tracks):
                if used[i]:
                    _keep.append(t)
                else:
                    t["miss"] += 1
                    if t["miss"] <= INFER_BOX_MISS_MAX:
                        _keep.append(t)
            _tracks[:] = _keep

        def _draw_items(frame, items):
            """items: [(cls_name, cid, conf, box)] —— 在原始尺寸帧上画框。"""
            ann = Annotator(frame, pil=False)
            for name, cid, cf, box in items:
                ann.box_label(box, "%s %.2f" % (name, cf), color=colors(cid, True))
            return ann.result()

        timeline = []   # 逐帧框时间轴（原始坐标）：供前端在原始视频上精确画框并逐帧对齐
        names_map = {}   # 类别 id -> 名称，一并写入时间轴 JSON
        # try/finally：中途被中止（客户端断开）也要释放 cap/writer —— 否则 Windows 上
        # 文件句柄没放，调用方想删掉这个临时上传的原视频会删不掉，留下孤儿
        try:
          while True:
            ret, frame = cap.read()
            if not ret:
                break
            if first_frame is None:
                first_frame = frame.copy()
            total += 1
            _emit(total)
            h, w = frame.shape[:2]
            _smooth_on = INFER_BOX_SMOOTH > 0
            items = []   # 本帧要绘制/记录的框：[（cls_name, cid, conf, [x1,y1,x2,y2]）]
            if total % skip == 0:
                # 不写视频时后端不再逐帧绘制（框由前端现场画 / 下载时现场合成），省掉这一步开销
                _need_draw = writer is not None
                # 宽度超过 INFER_MAX_WIDTH 时临时降分辨率推理（与原尺寸等比），仅降低推理耗时。
                # ⚠ 画框不再是"在小图上画完再拉伸回原尺寸"（那样框线与标签会变粗发虚），
                # 而是把框坐标按比例还原，用 Annotator **在原始尺寸帧上重画**，框线保持锐利。
                if w > INFER_MAX_WIDTH:
                    _scale = INFER_MAX_WIDTH / float(w)
                    _small = cv2.resize(frame, (INFER_MAX_WIDTH, int(round(h * _scale))))
                    results = model(_small, conf=conf, verbose=False)
                else:
                    _scale = 1.0
                    results = model(frame, conf=conf, verbose=False)
                r = results[0]
                inferred += 1
                names = r.names or {}
                _inv = 1.0 / _scale                # 小图坐标 -> 原尺寸坐标
                if not _smooth_on:
                    # 关闭平滑：保持原始逐帧结果
                    if r.boxes is not None and len(r.boxes) > 0:
                        for b in r.boxes:
                            _cid = int(b.cls[0])
                            _cf = float(b.conf[0])
                            names_map.setdefault(_cid, names.get(_cid, str(_cid)))
                            _xy = [float(v) * _inv for v in b.xyxy[0]]
                            items.append((names.get(_cid, str(_cid)), _cid, _cf, _xy))
                    if _need_draw:
                        ann = Annotator(frame, pil=False)
                        for name, cid, cf, box in items:
                            ann.box_label(box, "%s %.2f" % (name, cf), color=colors(cid, True))
                        frame = ann.result()
                else:
                    _new = []
                    if r.boxes is not None and len(r.boxes) > 0:
                        for b in r.boxes:
                            _cid = int(b.cls[0])
                            names_map.setdefault(_cid, names.get(_cid, str(_cid)))
                            _new.append((names.get(_cid, str(_cid)), _cid,
                                         float(b.conf[0]),
                                         [float(v) * _inv for v in b.xyxy[0]]))
                    _tracks_update(_new, w)
                    items = [(t["cls_name"], t["cid"], t["conf"], t["box"])
                             for t in _tracks]
                    if _need_draw:
                        frame = _draw_items(frame, items)
                # 统计始终用原始推理结果（不受平滑影响）
                if r.boxes is not None and len(r.boxes) > 0:
                    for b in r.boxes:
                        acc_box(b, names, _inv)
            elif _smooth_on and _tracks:
                # 未推理的中间帧：按最近速度外推补框（真正意义上是"插帧"）
                _f = (total % skip) / float(skip)
                items = [(t["cls_name"], t["cid"], t["conf"],
                          [t["box"][k] + t["vel"][k] * _f for k in range(4)])
                         for t in _tracks]
                if _need_draw:
                    frame = _draw_items(frame, items)
            # 记录逐帧框（原始坐标），前端据此在原始视频上逐帧画框并精确对齐
            timeline.append([[cid, round(cf, 4),
                              round(box[0], 2), round(box[1], 2),
                              round(box[2], 2), round(box[3], 2)]
                             for (_n, cid, cf, box) in items])
            if writer is not None:
                writer.write(frame)

        finally:
            cap.release()
            if writer is not None:
                writer.release()

        # 收尾时上报一次最终进度，保证前端能看到 100%
        if progress_cb:
            try:
                progress_cb(total, total_est or total)
            except Exception:
                pass
        elapsed = int((time.time() - t0) * 1000)

        # 按类别生成聚合行：平均置信度、平均框坐标
        boxes = []
        for name, a in cls_acc.items():
            n = a["cnt"]
            boxes.append({
                "cls_name": name,
                "conf": round(a["conf"] / n, 4),
                "x1": round(a["x1"] / n, 2),
                "y1": round(a["y1"] / n, 2),
                "x2": round(a["x2"] / n, 2),
                "y2": round(a["y2"] / n, 2),
                "count": n,
            })
        return total, inferred, stats, elapsed, first_frame, boxes, timeline, names_map, width, height, fps


# 与前端 _BOX_COLORS 同一套 20 色调色板（前端存的是 #RRGGBB，这里转成 BGR 供 OpenCV 用）
_PALETTE_BGR = [
    (0x38, 0x38, 0xFF), (0x97, 0x9D, 0xFF), (0x1F, 0x70, 0xFF), (0x1D, 0xB2, 0xFF),
    (0x31, 0xD2, 0xCF), (0x0A, 0xF9, 0x48), (0x17, 0xCC, 0x92),
    (0x86, 0xDB, 0x3D), (0x34, 0x93, 0x1A), (0xBB, 0xD4, 0x00), (0xA8, 0x99, 0x2C),
    (0xFF, 0xC2, 0x00), (0x93, 0x45, 0x34), (0xFF, 0x73, 0x64),
    (0xEC, 0x18, 0x00), (0xFF, 0x38, 0x84), (0x85, 0x00, 0x52), (0xFF, 0x38, 0xCB),
    (0xC8, 0x95, 0xFF), (0xC7, 0x37, 0xFF),
]


def draw_boxes_bgr(frame, boxes, names_map=None, ref_width=640):
    """在 BGR 帧上画框（后端绘制，用于「下载标注图/视频」时现场合成）。

    样式**对齐前端 canvas（drawBoxesCore）**：半透明填充 + 彩色细边框 + 标签底条白字，
    调色板与前端同一套 20 色（按类别 id 循环）——绝不能用 ultralytics 的 Annotator，
    那画出来是 YOLO 原生的粗框样式，和页面上的观感不一致（已踩坑）。

    boxes 支持两种形态：
      - 时间轴元素 [cls_id, conf, x1, y1, x2, y2]（视频逐帧）
      - 图片明细 dict {cls / cls_id, conf, x1,y1,x2,y2}
    names_map: {str(cls_id): 名称}，缺失时退回类别 id。
    ref_width: 前端显示宽度的参考值，用于把线宽/字号放大到原图分辨率下观感一致。
    返回画好框的 BGR 帧。
    """
    h, w = frame.shape[:2]
    lw = max(2, int(round(2.0 * w / ref_width)))          # 边框线宽
    fs = max(12, int(round(12.0 * w / ref_width)))        # 标签字号
    pad = max(3, lw)

    def _norm(b):
        if isinstance(b, dict):
            cid = int(b.get("cls", b.get("cls_id", 0)))
            cf = float(b.get("conf", 0))
            name = b.get("cls_name") or (names_map or {}).get(str(cid), str(cid))
            box = [float(b["x1"]), float(b["y1"]), float(b["x2"]), float(b["y2"])]
        else:
            cid = int(b[0])
            cf = float(b[1])
            name = (names_map or {}).get(str(cid), str(cid))
            box = [float(v) for v in b[2:6]]
        return cid, cf, name, box

    items = [_norm(b) for b in (boxes or [])]

    # ① 半透明填充：所有框画到 overlay 上一次混合（避免逐框整帧 addWeighted 拖慢视频合成）
    if items:
        overlay = frame.copy()
        for cid, cf, name, box in items:
            x1, y1, x2, y2 = [int(round(v)) for v in box]
            x1 = max(0, min(w - 1, x1)); x2 = max(0, min(w - 1, x2))
            y1 = max(0, min(h - 1, y1)); y2 = max(0, min(h - 1, y2))
            if x2 <= x1 or y2 <= y1:
                continue
            col = _PALETTE_BGR[cid % len(_PALETTE_BGR)]
            cv2.rectangle(overlay, (x1, y1), (x2, y2), col, -1)
        cv2.addWeighted(overlay, 0.16, frame, 0.84, 0, frame)   # 前端同款 alpha=0.16

    # ② 边框 + 标签（画在混合后的帧上，保持锐利）
    for cid, cf, name, box in items:
        x1, y1, x2, y2 = [int(round(v)) for v in box]
        x1 = max(0, min(w - 1, x1)); x2 = max(0, min(w - 1, x2))
        y1 = max(0, min(h - 1, y1)); y2 = max(0, min(h - 1, y2))
        if x2 <= x1 or y2 <= y1:
            continue
        col = _PALETTE_BGR[cid % len(_PALETTE_BGR)]
        cv2.rectangle(frame, (x1, y1), (x2, y2), col, lw)
        label = "%s %d%%" % (name, round(cf * 100))
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, fs / 24.0, max(1, lw // 2))
        ly = max(0, y1 - (th + pad * 2))                      # 标签贴框上沿，出画则贴顶
        cv2.rectangle(frame, (x1, ly), (x1 + tw + pad * 2, ly + th + pad), col, -1)
        cv2.putText(frame, label, (x1 + pad, ly + th + pad // 2),
                    cv2.FONT_HERSHEY_SIMPLEX, fs / 24.0, (255, 255, 255),
                    max(1, lw // 2), cv2.LINE_AA)
    return frame


# 全局单例
detector = Detector()
