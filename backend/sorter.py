# -*- coding: utf-8 -*-
"""自动分拣状态机。

流程：检测到类别 → 抓取位 → 吸气 → 对应放置位 → 放气 → 回原点
类别→区域映射从数据库 arm_config.class_area_map 动态读取（切换模型后需重新配置），
不硬编码具体类别与放置位的对应关系。
"""
import time
import threading
import logging
logger = logging.getLogger("yolo.sorter")
import json

import db
import config
from detector import detector
from arm_controller import arm, POSE_LABELS, calc_move_duration


# 放置位标识 -> 显示名（从配置动态更新）
AREA_LABELS = {}


def build_area_labels(areas):
    """由放置位列表构造 {key: 显示名}（纯函数，不碰全局变量）。"""
    return {a["key"]: a.get("label", a["key"]) for a in (areas or [])}


def load_area_labels(user_id=None):
    """读取**该用户**的放置位显示名。返回 {key: label}。

    独立函数，避免把结果写进模块级全局造成多用户串味。
    """
    if user_id:
        try:
            import db
            cfg = db.ensure_user_arm_config(user_id)
            return build_area_labels(cfg.get('areas'))
        except Exception as e:
            logger.warning("[sorter] 读取用户放置位标签失败: %s", e)
            return {}
    try:
        import db
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT areas FROM arm_config WHERE id=1")
                row = cur.fetchone()
            if row and row["areas"]:
                return build_area_labels(json.loads(row["areas"]))
        finally:
            conn.close()
    except Exception as e:
        logger.warning("[sorter] 读取放置位标签失败: %s", e)
    return {}


def load_class_area_map(user_id=None):
    """读取类别->放置位映射（**不再修改模块级全局**，标签请用 load_area_labels）。

    user_id 不为空时读**该用户自己的**配置（每人一套，公共设施轮流使用）；
    为空时读全局 arm_config（兼容旧调用 / 新用户模板）。
    """
    class_map = {}
    if user_id:
        try:
            import db
            cfg = db.ensure_user_arm_config(user_id)
            class_map = cfg.get('normal_class_map') or {}
            # 按当前模型优先：界面配置写的是 class_map_by_model[当前模型]，
            # 若这里仍只读 normal_class_map，切换模型后会出现
            # 「界面显示 A 模型的映射、执行却用上一个模型的映射」的错位。
            # 该模型名下有配置就用它，否则回落旧字段（兼容迁移前的数据）。
            try:
                _m = (detector.current_file or '').strip()
                if _m:
                    conn = db.get_db()
                    try:
                        with conn.cursor() as cur:
                            cur.execute("SELECT class_map_by_model FROM users WHERE id=%s",
                                        (user_id,))
                            row = cur.fetchone() or {}
                    finally:
                        conn.close()
                    raw = row.get('class_map_by_model')
                    if isinstance(raw, str):
                        raw = json.loads(raw) if raw else {}
                    by_m = (raw or {}).get(_m)
                    if isinstance(by_m, dict):
                        class_map = by_m
            except Exception as e:
                logger.debug("[sorter] 读取按模型映射失败，沿用通用映射: %s", e)
            return class_map
        except Exception as e:
            logger.warning("[sorter] 读取用户类别映射失败，回落全局: %s", e)
    try:
        import db
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT class_area_map, areas FROM arm_config WHERE id=1")
                row = cur.fetchone()
            if row:
                if row["class_area_map"]:
                    class_map = json.loads(row["class_area_map"])
        finally:
            conn.close()
    except Exception as e:
        logger.warning("[sorter] 读取配置失败: %s", e)
    return class_map

# 阶段中文标签（分拣为固定 5 步序列，顺序即步骤号）
PHASE_LABELS = {
    'idle': '待机',
    'picking': '移动到抓取位',
    'sucking': '吸气抓取',
    'placing': '移动到放置位',
    'releasing': '放气释放',
    'returning': '返回原点',
}

# 分拣动作的固定步骤顺序与步骤总数（供前端显示"步骤 X / 5"）
SORT_STEPS = ['picking', 'sucking', 'placing', 'releasing', 'returning']
SORT_STEP_TOTAL = len(SORT_STEPS)


class Sorter:
    """自动分拣状态机（单例）。"""

    def __init__(self):
        self.running = False
        self.busy = False
        self.lock = threading.Lock()
        self.current_phase = 'idle'
        self.last_result = None
        self.total_count = 0
        self.success_count = 0
        self._last_detect_time = 0
        self._stop_requested = False
        self._estop_triggered = False
        self.class_area_map = load_class_area_map()

    def start(self, user_id=None):
        """启动自动分拣。检查连接和标定（按该用户自己的普通模式标定检查）。"""
        if not arm.connected:
            return False, '机械臂未连接'
        self.reload_config(user_id)  # 启动时重新加载最新映射
        poses = arm.list_poses_status(user_id)   # 姿态按用户隔离
        needed = list(poses.keys())
        missing = [n for n in needed if not poses.get(n, {}).get('calibrated')]
        if missing:
            labels = {k: v.get('label', k) for k, v in poses.items()}
            return False, '请先标定: ' + '、'.join(labels.get(n, n) for n in missing)
        self.running = True
        self.current_phase = 'idle'
        self.busy = False
        self._stop_requested = False
        self._estop_triggered = False
        return True, '自动分拣已启动'

    def stop(self):
        """优雅停止：完成当前一轮动作后停止，不接受新检测。"""
        self._stop_requested = True
        if not self.busy:
            self.running = False
            self.current_phase = 'idle'
            return True, '自动分拣已停止'
        return True, '正在完成当前动作，完成后停止'

    def estop(self):
        """急停：立即停止所有舵机 + 放气。

        气泵放气收尾（release → 等 0.65s → off）挪到后台线程执行：
        急停接口必须立刻返回，否则前端 toast 会跟着拖近 1 秒。
        """
        self._stop_requested = True
        self._estop_triggered = True
        self.running = False
        try:
            arm.stop_all()
        except Exception as e:
            logger.warning('[sorter] 急停时停止舵机失败: %s', e)

        def _pump_cleanup():
            try:
                arm.pump_release()
                time.sleep(0.2)
                arm.pump_off()
            except Exception as e:
                logger.warning('[sorter] 急停时气泵放气失败: %s', e)

        threading.Thread(target=_pump_cleanup, daemon=True).start()
        self.busy = False
        self.current_phase = 'idle'
        return True, '已急停，舵机已停止，气泵已放气'

    def reset(self, user_id=None):
        """复位：清除急停状态，回原点（按该用户自己的普通模式标定）。"""
        self._estop_triggered = False
        self._stop_requested = False
        self.busy = False
        self.current_phase = 'idle'
        if arm.connected:
            try:
                arm.goto_pose('home', user_id=user_id)
            except Exception as e:
                logger.warning('[sorter] 复位回原点失败: %s', e)
        return True, '已复位，机械臂回原点'

    def _normalize_class(self, defect_class, class_map=None):
        """大小写不敏感匹配类别，返回标准 key 或 None。"""
        cmap = self.class_area_map if class_map is None else class_map
        target = (defect_class or '').strip().lower()
        for k in cmap:
            if k.strip().lower() == target:
                return k
        return None

    def submit_detection(self, defect_class, confidence, user_id=1, username='system'):
        """提交检测结果，触发分拣。

        机械臂正忙时忽略，防止重复触发。
        """
        if not self.running:
            return False, '分拣未启动'
        if self._estop_triggered:
            return False, '已急停，请先复位'
        if self._stop_requested:
            return False, '正在停止中'
        if not arm.connected:
            return False, '机械臂未连接'
        if self.busy:
            return False, '机械臂正忙'
        # 类别映射按触发者 user_id 运行时解析（每人一套；不再是启动时全局加载）
        class_map = load_class_area_map(user_id)
        norm_class = self._normalize_class(defect_class, class_map)
        logger.info("[sorter] 收到类别: '%s', 映射keys: %s, 匹配结果: %s",
                    defect_class, list(class_map.keys()), norm_class)
        if norm_class is None:
            return False, f'未知类别: {defect_class}（可用: {list(class_map.keys())}）'
        defect_class = norm_class
        place_area = class_map.get(defect_class, '')

        # 防抖：两次触发最小间隔 1 秒
        now = time.time()
        if now - self._last_detect_time < 1.0:
            return False, '触发间隔过短'
        self._last_detect_time = now

        # 异步执行分拣序列
        thread = threading.Thread(
            target=self._sort_sequence,
            args=(defect_class, confidence, user_id, username, place_area,
                  load_area_labels(user_id)),
            daemon=True
        )
        thread.start()
        return True, '已触发分拣'

    def _sort_sequence(self, defect_class, confidence, user_id, username, place_area=None,
                       area_labels=None):
        """执行完整分拣序列（在独立线程中运行）。"""
        with self.lock:
            if self.busy:
                return
            self.busy = True

        start_time = time.time()
        success = False
        if place_area is None:
            place_area = load_class_area_map(user_id).get(defect_class, '')
        error_msg = ''
        # 行程（经原点/直达）取触发本次分拣的用户的个人偏好，不影响他人
        via_home = arm.get_via_home(user_id)

        try:
            # 1. 移动到抓取位（姿态按用户隔离）
            # 路径诊断：记录每步"去哪个姿态 / 经原点与否 / 耗时"，
            # 便于排查"机械臂看起来乱走"时究竟按什么路径在动
            def _log_step(phase, target):
                logger.info('[sorter] 步骤 %s -> 目标「%s」(via_home=%s, 类别=%s)',
                            phase, target, via_home, defect_class)

            # 步间间隔：与动作组保持一致。
            # 放气要连发多条指令，若紧接着就发下一步的多合一舵机指令，
            # 串口/控制器还没消化完会被堵住 —— 表现为"回原点没走到、停在半路"。
            _gap_ms = getattr(config, 'MOVE_STEP_GAP_MS', 0) or 0

            def _gap():
                if _gap_ms > 0:
                    time.sleep(_gap_ms / 1000.0)

            self.current_phase = 'picking'
            _t = time.time()
            _gap()
            _log_step('1/5 去抓取位', 'pick')
            ok, msg = arm.goto_pose('pick', via_home=via_home, user_id=user_id)
            if not ok:
                raise Exception(msg)
            time.sleep(0.3)
            logger.info('[sorter]   抓取位耗时 %.2fs', time.time() - _t)

            # 2. 吸气
            self.current_phase = 'sucking'
            arm.pump_suck()
            time.sleep(0.6)  # 等待建立负压

            # 3. 移动到放置位
            self.current_phase = 'placing'
            _t = time.time()
            _gap()      # 吸气也是多条指令，留出消化时间
            _log_step('3/5 去放置位', place_area)
            ok, msg = arm.goto_pose(place_area, via_home=via_home, user_id=user_id)
            if not ok:
                raise Exception(msg)
            time.sleep(0.3)
            logger.info('[sorter]   放置位耗时 %.2fs', time.time() - _t)

            # 4. 放气
            self.current_phase = 'releasing'
            arm.pump_release()
            time.sleep(0.4)
            arm.pump_off()

            # 5. 回原点
            self.current_phase = 'returning'
            _t = time.time()
            _gap()      # 放气(多条指令)之后必须先喘一口，否则回原点走不到位
            _log_step('5/5 回原点', 'home')
            if getattr(config, 'SORTER_SPLIT_BASE_RETURN', True):
                # 分两步：先收回除底座外的关节（缩小转动惯量），再单独转底座。
                # 机械臂在放置位是伸展状态，此时底座带整条臂旋转负载最大，
                # 实测会出现"其他关节都回中位了、唯独底座转不动"。
                _home = arm.load_poses(user_id, 'normal').get('home') or {}
                _base = {0: int(_home.get('0', 1500))}
                _others = {int(k): int(v) for k, v in _home.items()
                           if int(k) < 5 and int(k) != 0}
                if _others:
                    arm.move_servos(_others, duration=calc_move_duration(
                        _others, arm.current_pose, user_id=user_id), wait_reached=True)
                    _gap()
                # 诊断：底座这一步的目标值与位移（排查"底座不转"时用）
                logger.info('[sorter]   底座单独回中：目标=%s，当前=%s',
                            _base.get(0), arm.current_pose.get(0))
                arm.move_servos(_base, duration=calc_move_duration(
                    _base, arm.current_pose, user_id=user_id), wait_reached=True)
            else:
                ok, msg = arm.goto_pose('home', via_home=via_home, user_id=user_id)
                # 原先这里**没有检查返回值**：home 未标定/失败时会被当成成功，
                # 机械臂就停在放置位不动（表现为"跑完没回原点、停在不知哪"）
                if not ok:
                    raise Exception('回原点失败：' + msg)
            logger.info('[sorter]   回原点耗时 %.2fs', time.time() - _t)

            success = True

        except Exception as e:
            error_msg = str(e)
            # 动作出错 → 急停：停止所有舵机 + 放气
            self._estop_triggered = True
            self.running = False
            try:
                arm.stop_all()
            except Exception as e:
                logger.warning('[sorter] 动作异常后停止舵机失败: %s', e)
            try:
                arm.pump_release()
                time.sleep(0.2)
                arm.pump_off()
            except Exception as e:
                logger.warning('[sorter] 动作异常后气泵放气失败: %s', e)
        finally:
            duration_ms = int((time.time() - start_time) * 1000)
            self.busy = False
            self.current_phase = 'idle'
            self.total_count += 1
            # 优雅停止：完成当前一轮后停止
            if self._stop_requested and not self._estop_triggered:
                self.running = False
            if success:
                self.success_count += 1

            self.last_result = {
                'defect_class': defect_class,
                'confidence': round(float(confidence), 4),
                'place_area': place_area,
                'place_label': (area_labels or {}).get(place_area, place_area),
                'success': success,
                'duration_ms': duration_ms,
                'error': error_msg,
                'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
            }

            # 成功才落库
            if success:
                try:
                    self._save_record(defect_class, confidence, place_area, duration_ms, user_id, username)
                except Exception as e:
                    logger.warning('[sorter] 记录落库失败: %s', e)

    def _save_record(self, defect_class, confidence, place_area, duration_ms, user_id, username):
        """分拣记录落库。"""
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO sort_records "
                    "(user_id, username, defect_class, confidence, place_area, pick_success, duration_ms, model_name) "
                    "VALUES (%s, %s, %s, %s, %s, 1, %s, %s)",
                    (user_id, username, defect_class, float(confidence), place_area, duration_ms, detector.current_file or '')
                )
            conn.commit()
        finally:
            conn.close()

    def reload_config(self, user_id=None):
        """重新从数据库加载配置（运行时调用）。带 user_id 时按该用户加载。"""
        self.class_area_map = load_class_area_map(user_id)
        return True

    def get_status(self):
        """获取分拣状态（含步骤序号，供前端显示"步骤 X / 5"）。"""
        phase = self.current_phase
        step = (SORT_STEPS.index(phase) + 1) if phase in SORT_STEPS else 0
        return {
            'running': self.running,
            'busy': self.busy,
            'current_phase': phase,
            'phase_label': PHASE_LABELS.get(phase, phase),
            'step': step,
            'step_total': SORT_STEP_TOTAL,
            'estop': self._estop_triggered,
            'stop_requested': self._stop_requested,
            'last_result': self.last_result,
            'total_count': self.total_count,
            'success_count': self.success_count,
        }


# 全局单例
sorter = Sorter()
