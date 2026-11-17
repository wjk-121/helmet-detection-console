# -*- coding: utf-8 -*-
"""机械臂串口控制器 · Jibot1-STM32 气泵吸盘版。

通信协议：
  - USB 转串口 CH340，波特率 115200
  - 单舵机：#<ID3位>P<PWM4位>T<时间4位>!
  - 多舵机同步：{#000P1500T1000!#001P0900T1000!}
  - 全局停止：$DST!
  - 动作组调用：$DGS:N!  /  $DGT:start-end,count!
  - 气泵（ID=005）：吸气 P=1200，放气 P=2400，停止 P=1500（暂定，实测确认）
"""
import time
import threading
import json
import logging
import math
import serial
import serial.tools.list_ports

import db
import config

logger = logging.getLogger("helmet.arm")


# 舵机 ID 定义（从下往上）
SERVO_BASE = 0      # 底座旋转
SERVO_SHOULDER = 1  # 大臂
SERVO_ELBOW = 2     # 小臂
SERVO_WRIST = 3     # 腕部
SERVO_WRIST2 = 4    # 腕部2
SERVO_PUMP = 5      # 气泵驱动模块

# 气泵 PWM 值从数据库 arm_config 表读取（默认：2400吸气 / 1200放气 / 1500停止）

# 安装方向相反的舵机（逻辑PWM与硬件PWM需反转：hw = 3000 - logical）
REVERSED_SERVOS = {SERVO_ELBOW}  # J3 小臂


def calc_move_duration(target_pwm, prev_pwm=None, profile=None, user_id=None):
    """按位移计算这一步该用多少毫秒走完（普通模式与高级模式动作组共用）。

    背景（真机实测）：控制器**严格按指令里的 T 参数执行**，自身没有加减速规划。
      时长给少了 -> 没走完就被下一步打断，表现为顿挫、不到位；
      时长给多了 -> 白白干等。
    因此时长必须随位移大小变化，而不是所有步骤用同一个固定值。

    公式：起步缓冲 + max( 各关节位移 × 速度档位系数 × **该关节权重** )，再钳制到 [下限, 上限]。

    为什么按关节分别算：真机实测各关节速度差异很大 —— 底座旋转/下降很快，
    而**抬大臂/抬升很慢**（要扛起小臂、腕部和工件）。若所有关节共用一个系数，
    大臂就会时间不够、走不到位（表现为"旋转能做完整、抬升做不完"）。
    因此每路各自算需要多久，取**最慢的那一路**作为整步时长
    （T 参数所有关节共享，走得最慢的决定整步，其余关节放慢配合它同时到位）。

    profile 为 None 时自动读取该用户的档位（见 db.get_arm_move_speed，**按用户隔离**）。
    """
    if profile is None:
        try:
            profile = db.get_arm_move_speed(user_id)
        except Exception:
            profile = config.MOVE_SPEED_DEFAULT
    coeff = config.MOVE_SPEED_PROFILES.get(
        profile, config.MOVE_SPEED_PROFILES[config.MOVE_SPEED_DEFAULT])
    weights = getattr(config, 'JOINT_SPEED_WEIGHTS', {}) or {}
    need = 0
    for sid in range(5):
        try:
            d = abs(int(target_pwm.get(sid, target_pwm.get(str(sid), 1500)))
                    - int((prev_pwm or {}).get(sid, (prev_pwm or {}).get(str(sid), 1500))))
        except Exception:
            d = 0
        t = d * coeff * float(weights.get(sid, 1.0))
        if t > need:
            need = t
    return int(max(config.MOVE_MIN_MS,
                   min(config.MOVE_MAX_MS, config.MOVE_BASE_MS + need)))


def _hw_pwm(servo_id, pwm):
    """逻辑 PWM → 硬件实际 PWM。"""
    pwm = int(pwm)
    if int(servo_id) in REVERSED_SERVOS:
        return 3000 - pwm
    return pwm


def _logical_pwm(servo_id, pwm):
    """硬件实际 PWM → 逻辑 PWM。"""
    pwm = int(pwm)
    if int(servo_id) in REVERSED_SERVOS:
        return 3000 - pwm
    return pwm


# 标定姿态名称
# 注意：可用姿态的唯一来源是 ArmController._all_pose_names()（home/pick + 数据库 arm_config.areas
# 里配置的动态放置位）。这里不再维护硬编码的 POSE_NAMES 列表，避免与数据库中的
# place_1/place_2/... 配置冲突。
POSE_LABELS = {
    'home': '原点',
    'pick': '抓取位',
    'place_back': '后放位',
    'place_left': '左放位',
    'place_right': '右放位',
}


def list_serial_ports():
    """列出可用串口，返回 [{device, description, hwid}]。"""
    ports = []
    for p in serial.tools.list_ports.comports():
        ports.append({
            'device': p.device,
            'description': p.description,
            'hwid': p.hwid,
        })
    return ports


def _fmt_pwm(v):
    """PWM 格式化为 4 位字符串。"""
    v = max(500, min(2500, int(v)))
    return f"{v:04d}"


def _fmt_id(v):
    """ID 格式化为 3 位字符串。"""
    return f"{int(v):03d}"


class ArmController:
    """机械臂控制器（单例）。"""

    def __init__(self):
        self.ser = None
        self.port = None
        self.baudrate = 115200
        self.connected = False
        self.lock = threading.Lock()
        self.current_pose = {}   # {servo_id: pwm} 缓存
        self.pump_state = 'off'  # suck / release / off
        self.busy = False        # 是否正在执行动作序列
        self._pump_timer = None  # 气泵超时保护定时器
        # 气泵 PWM 配置（从数据库读取，默认：2400吸气 / 1200放气 / 1500停止）
        self.pump_suck_pwm = 2400
        self.pump_release_pwm = 1200
        self.pump_off_pwm = 1500
        self.pump_timeout_sec = 10  # 吸气持续超时保护（秒）
        self._pump_suck_start = None  # 吸气开始时间戳，用于前端倒计时显示
        # 本次吸气**实际生效**的超时值：Timer 在 pump_suck 时用"当时的" pump_timeout_sec 启动，
        # 之后该配置可能被改（如动作组结束后从 120 恢复回 10），倒计时必须按生效值算，
        # 否则会出现"界面显示剩 7 秒、实际还有 117 秒才放气"的错位
        self._pump_effective_timeout = self.pump_timeout_sec
        # 去姿态行程模式：True=经原点过渡（防碰撞，默认） False=直达（更快但有碰撞风险）
        # 此处为「全局默认值」，供尚未设置个人偏好的用户回落使用；
        # 实际生效值经 get_via_home(user_id) 取用户个人偏好（users.arm_via_home）。
        # 手动点姿态按钮 与 自动分拣 都走 goto_pose，故对两者同时生效。
        self.via_home = True
        self.load_config()
        # 页面独占锁（同一时间只准一个设备进入工控页）
        self.page_lock_user_id = None
        self.page_lock_username = None
        self.page_lock_device_id = None
        self.page_lock_last_heartbeat = 0.0

    # ---------- 配置加载 ----------

    def load_config(self):
        """从数据库加载气泵 PWM 与行程模式配置。"""
        try:
            conn = db.get_db()
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT pump_suck_pwm, pump_release_pwm, via_home FROM arm_config WHERE id=1"
                )
                row = cur.fetchone()
            conn.close()
            if row:
                if row.get("pump_suck_pwm"):
                    self.pump_suck_pwm = int(row["pump_suck_pwm"])
                if row.get("pump_release_pwm"):
                    self.pump_release_pwm = int(row["pump_release_pwm"])
                if row.get("via_home") is not None:
                    self.via_home = bool(int(row["via_home"]))
        except Exception as e:
            logger.warning("[arm] 读取 arm_config 失败，使用默认 PWM 参数: %s", e)

    def get_via_home(self, user_id=None):
        """获取去姿态行程模式。

        优先取该用户的个人偏好（users.arm_via_home），每人各存一份、互不干扰。

        回落说明（重要）：users.arm_via_home 是 NOT NULL DEFAULT 1，加列时数据库已把
        所有现存用户自动填成 1，新注册用户同样为 1 —— 因此**不存在"尚未设置偏好的
        用户"这一空档**，正常登录用户必然读到自己的值。全局默认 self.via_home
        （arm_config.via_home）只在以下兜底场景生效：
          1) 调用时没有用户身份（如 sorter.reset()，其目标为 home，via_home 实际无影响）；
          2) user_id 在库中查不到；
          3) 读库异常。
        """
        if not user_id:
            return self.via_home
        try:
            conn = db.get_db()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT arm_via_home FROM users WHERE id=%s", (user_id,))
                    row = cur.fetchone()
            finally:
                conn.close()
        except Exception as e:
            logger.debug("[arm] 读取用户行程偏好失败，回落全局默认: %s", e)
            return self.via_home
        if row and row.get("arm_via_home") is not None:
            return bool(int(row["arm_via_home"]))
        return self.via_home

    def set_via_home(self, enabled, user_id=None):
        """设置去姿态行程模式（经原点/直达）。返回 (ok, msg)。

        user_id 不为 None：只改该用户的个人偏好（users.arm_via_home），
            **不影响其他用户**；
        user_id 为 None：改全局默认（arm_config.via_home），作为尚未设置偏好者的回落值。
        """
        enabled = bool(enabled)
        try:
            conn = db.get_db()
            try:
                with conn.cursor() as cur:
                    if user_id:
                        cur.execute(
                            "UPDATE users SET arm_via_home=%s WHERE id=%s",
                            (1 if enabled else 0, user_id)
                        )
                    else:
                        cur.execute(
                            "UPDATE arm_config SET via_home=%s, updated_at=NOW() WHERE id=1",
                            (1 if enabled else 0,)
                        )
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            logger.warning("[arm] 保存 via_home 失败: %s", e)
            return False, f"保存失败: {e}"
        if not user_id:
            self.via_home = enabled
        return True, ("已设为「经原点过渡」" if enabled else "已设为「直达」")

    # ---------- 页面独占锁 ----------

    def page_enter(self, user_id, username, device_id):
        """请求进入工控页。返回 (ok, msg, current_owner)。线程安全。
        同一设备刷新（device_id相同）放行；不同设备（即使同一用户）拒绝。"""
        import time
        with self.lock:
            now = time.time()
            # 检查是否超时自动释放（15秒无心跳）
            if self.page_lock_user_id and (now - self.page_lock_last_heartbeat) > 8:
                self.page_lock_user_id = None
                self.page_lock_username = None
                self.page_lock_device_id = None
            if self.page_lock_user_id is None:
                self.page_lock_user_id = user_id
                self.page_lock_username = username
                self.page_lock_device_id = device_id
                self.page_lock_last_heartbeat = now
                return True, '进入成功', None
            # 同一设备刷新（user_id 和 device_id 都相同）→ 放行
            if self.page_lock_user_id == user_id and self.page_lock_device_id == device_id:
                self.page_lock_last_heartbeat = now
                return True, '进入成功', None
            # 已被其他设备占用
            return False, '页面正被 ' + str(self.page_lock_username) + ' 使用中', self.page_lock_username

    def page_heartbeat(self, user_id):
        """占用者心跳。返回是否仍占用。线程安全。"""
        import time
        with self.lock:
            if self.page_lock_user_id == user_id:
                self.page_lock_last_heartbeat = time.time()
                return True
            return False

    def page_leave(self, user_id):
        """离开页面，释放锁。线程安全。"""
        with self.lock:
            if self.page_lock_user_id == user_id:
                self.page_lock_user_id = None
                self.page_lock_username = None
                self.page_lock_device_id = None
                self.page_lock_last_heartbeat = 0.0
                return True
            return False

    def page_lock_info(self):
        """返回当前占用者信息。线程安全。"""
        import time
        with self.lock:
            if self.page_lock_user_id:
                # 检查是否超时
                if time.time() - self.page_lock_last_heartbeat > 8:
                    self.page_lock_user_id = None
                    self.page_lock_username = None
                    self.page_lock_device_id = None
                    return None
                return {'user_id': self.page_lock_user_id, 'username': self.page_lock_username}
            return None

    # ---------- 串口基础 ----------

    def connect(self, port, baudrate=115200):
        """打开串口，返回 (ok, msg)。"""
        with self.lock:
            if self.ser and self.ser.is_open:
                try:
                    self.ser.close()
                except Exception as e:
                    logger.debug("[arm] 关闭已打开串口失败: %s", e)
            try:
                self.ser = serial.Serial(port, baudrate, timeout=1, write_timeout=2)
                time.sleep(0.5)  # 等待 CH340 就绪
                self.port = port
                self.baudrate = baudrate
                self.connected = True
                # 已知硬件行为：每次新连接，舵机会自动回到中位(1500)。
                # 先按中位重置缓存，避免残留上次姿态造成「滑块显示旧值、机械臂已在中位」的冲突；
                # 随后再回读真实位置覆盖（即使回读失败也不会留下错误旧值）。
                self.current_pose = {sid: 1500 for sid in range(6)}
                self._refresh_pose_cache()
                return True, f"已连接 {port} @ {baudrate}"
            except Exception as e:
                self.connected = False
                self.ser = None
                return False, f"连接失败: {e}"

    def disconnect(self):
        """断开串口（断开前停止所有舵机+气泵放气）。"""
        with self.lock:
            try:
                if self.ser and self.ser.is_open:
                    # 安全：停止所有舵机 + 气泵放气
                    self._raw_send("$DST!")
                    time.sleep(0.1)
                    self._raw_send(f"#{_fmt_id(SERVO_PUMP)}P{_fmt_pwm(self.pump_release_pwm)}T0500!")
                    time.sleep(0.3)
                    self.ser.close()
            except Exception as e:
                logger.warning("[arm] 断开串口时异常（已强制置为未连接）: %s", e)
            self.ser = None
            self.connected = False
            self.pump_state = 'off'
            self.busy = False

    def _raw_send(self, cmd):
        """底层发送指令（不加锁，调用方需持锁）。

        ⚠ 必须校验 write() 的返回值：串口初始化带了 write_timeout，
        超时时 pyserial 会**只写出一部分就返回，且不抛异常**。
        若不校验，被截断的指令会照样发出去 —— 控制器收到半截指令，
        表现为"某些关节没动/某个动作被跳过"（真机故障，难以复现）。
        这里先补写剩余字节，仍写不全则明确报错，绝不静默丢字节。
        """
        if not self.ser or not self.ser.is_open:
            raise RuntimeError("串口未连接")
        data = cmd.encode('ascii')
        total = len(data)
        sent = self.ser.write(data)
        if sent is None:
            # 个别平台/后端不返回字节数：退化为原来的行为（无法校验）
            self.ser.flush()
            return
        if sent < total:
            sent2 = self.ser.write(data[sent:])
            sent = sent + (sent2 or 0)
            if sent < total:
                raise RuntimeError(
                    f"串口指令发送不完整：{sent}/{total} 字节，已中止该条指令")
        self.ser.flush()

    def _raw_send_and_read(self, cmd, timeout=0.5):
        """发送指令并读取响应（不加锁）。"""
        self._raw_send(cmd)
        time.sleep(0.05)
        buf = b''
        end = time.time() + timeout
        while time.time() < end:
            if self.ser.in_waiting:
                buf += self.ser.read(self.ser.in_waiting)
                if b'!' in buf:
                    break
            else:
                time.sleep(0.02)
        return buf.decode('ascii', errors='replace').strip()

    def send_cmd(self, cmd):
        """发送指令（线程安全），返回响应字符串。"""
        with self.lock:
            return self._raw_send_and_read(cmd)

    # ---------- 舵机控制 ----------

    def move_servo(self, servo_id, pwm, duration=1000):
        """移动单个舵机（手动调节用）：立即发送不等待，不设 busy。"""
        hw = _hw_pwm(servo_id, pwm)
        cmd = f"#{_fmt_id(servo_id)}P{_fmt_pwm(hw)}T{int(duration):04d}!"
        with self.lock:
            self._raw_send(cmd)
            self.current_pose[int(servo_id)] = int(pwm)

    def _wait_reached(self, servos, timeout=None, tol=None):
        """回读校验：等待舵机真正到达目标位置。返回 True=已到位。

        按预设时长 sleep 只是"盲等"——机械臂带负载/惯性时可能尚未走完，
        此时发下一条指令会打断它（表现为"没到位就被拉到下一个动作"）。
        这里用 PRAD 回读补足；**回读不可用或异常时立即返回 True（不阻塞）**，
        退回原来的盲等行为，绝不会卡死。
        """
        if timeout is None:
            timeout = getattr(config, 'MOVE_SETTLE_TIMEOUT_SEC', 3.0)
        if tol is None:
            tol = getattr(config, 'MOVE_SETTLE_TOL', 15)
        if timeout <= 0:
            return True
        end = time.time() + timeout
        while time.time() < end:
            try:
                ok = True
                for sid, pwm in servos.items():
                    cur = self.read_position(int(sid))
                    if abs(cur - int(pwm)) > tol:
                        ok = False
                        break
                if ok:
                    return True
            except Exception:
                return True      # 回读不可用 -> 立即放行，不阻塞
            time.sleep(0.2)
        logger.debug("[arm] 到位确认超时（额外等了 %.1fs 仍未完全到位）", timeout)
        return False

    def move_servos(self, servos, duration=1000, wait_reached=False):
        """同步移动多个舵机。servos = {id: pwm}。

        wait_reached: True 时在预设时长之后再回读校验一次是否真的到位，
                      未到位则补等（上限 config.MOVE_SETTLE_TIMEOUT_SEC）。
                      用于动作组/自动分拣这类"必须走完才能下一步"的场景；
                      手动拖滑块不启用（避免操作发黏）。
        """
        if not servos:
            return
        self.busy = True
        try:
            parts = []
            for sid, pwm in servos.items():
                hw = _hw_pwm(sid, pwm)
                parts.append(f"#{_fmt_id(sid)}P{_fmt_pwm(hw)}T{int(duration):04d}!")
            cmd = "{" + "".join(parts) + "}"
            with self.lock:
                self._raw_send(cmd)
                for sid, pwm in servos.items():
                    self.current_pose[int(sid)] = int(pwm)
            # 上限需 >= config.MOVE_MAX_MS/1000，否则算出的时长会被这里截断
            time.sleep(min(duration / 1000.0 + 0.05, 10))
            # 默认关闭（见 config.MOVE_WAIT_REACHED 说明）：回读会占用串口，
            # 气泵开启时串口繁忙会导致每步都等满超时，表现为明显变慢
            if wait_reached and getattr(config, 'MOVE_WAIT_REACHED', False):
                self._wait_reached(servos)
        finally:
            self.busy = False

    def stop_all(self):
        """急停：所有舵机停止在当前位置 + 气泵放气。"""
        with self.lock:
            self._raw_send("$DST!")
            time.sleep(0.1)
            self._raw_send(f"#{_fmt_id(SERVO_PUMP)}P{_fmt_pwm(self.pump_release_pwm)}T0500!")
            self.pump_state = 'off'
            self.busy = False

    def stop_servo(self, servo_id):
        """停止单个舵机。"""
        cmd = f"$DST:{_fmt_id(servo_id)}!"
        with self.lock:
            self._raw_send(cmd)

    def read_position(self, servo_id):
        """读取舵机当前位置，返回 PWM 值。"""
        cmd = f"#{_fmt_id(servo_id)}PRAD!"
        with self.lock:
            resp = self._raw_send_and_read(cmd)
        # 响应格式：#000P1500!
        try:
            pwm_str = resp.split('P')[1].split('!')[0]
            return _logical_pwm(servo_id, int(pwm_str))
        except Exception:
            return self.current_pose.get(int(servo_id), 1500)

    def _refresh_pose_cache(self):
        """刷新所有舵机位置缓存（调用方需持锁）。

        仅在「建立连接」时调用：此时硬件已知会回到中位，因此回读失败也直接取 1500，
        不用 setdefault —— 否则会残留上一次连接的旧姿态，导致滑块与机械臂实际位置不符。
        """
        for sid in range(6):
            try:
                resp = self._raw_send_and_read(f"#{_fmt_id(sid)}PRAD!", timeout=0.3)
                pwm_str = resp.split('P')[1].split('!')[0]
                # 反向舵机转换（下一行赋值处用转换后的值）
                self.current_pose[sid] = _logical_pwm(sid, int(pwm_str))
            except Exception:
                self.current_pose[sid] = 1500

    def read_current_pose(self):
        """从硬件回读 5 路运动关节当前 PWM（逻辑值），并刷新缓存，返回 {sid: pwm}。

        供前端滑块实时跟随机械臂姿态使用。仅在空闲时调用（运动中回读会得到中间值，
        且串口读写会干扰动作时序）。

        注意：回读到的是「控制器记录的当前 PWM」。若舵机为普通 PWM 舵机（无编码器
        反馈），手掰机械臂后回读值不会变化；若为带反馈的总线舵机则反映真实角度。
        """
        if not self.connected or not self.ser or not self.ser.is_open:
            return {}
        result = {}
        with self.lock:
            for sid in range(5):
                try:
                    resp = self._raw_send_and_read(f"#{_fmt_id(sid)}PRAD!", timeout=0.3)
                    pwm = _logical_pwm(sid, int(resp.split('P')[1].split('!')[0]))
                except Exception:
                    pwm = self.current_pose.get(sid, 1500)
                self.current_pose[sid] = pwm
                result[sid] = pwm
        return result

    # ---------- 气泵控制 ----------

    def _cancel_pump_timer(self):
        """取消气泵超时保护定时器。"""
        t = self._pump_timer
        self._pump_timer = None
        if t is not None:
            t.cancel()

    def _on_pump_timeout(self):
        """气泵超时保护：吸气持续时间超过上限时自动放气并停止，避免长时间堵转/过热。"""
        logger.warning("[arm] 气泵吸气超过 %s 秒，触发超时保护，自动放气", self.pump_timeout_sec)
        try:
            self.pump_release()
        except Exception as e:
            logger.warning("[arm] 气泵超时保护放气失败: %s", e)
        try:
            self.pump_off()
        except Exception as e:
            logger.warning("[arm] 气泵超时保护停止失败: %s", e)

    def pump_suck(self):
        """气泵吸气（带超时保护，超时自动放气并停止）。"""
        with self.lock:
            self._raw_send(f"#{_fmt_id(SERVO_PUMP)}P{_fmt_pwm(self.pump_suck_pwm)}T0500!")
            self.pump_state = 'suck'
        # 记录本次吸气实际生效的超时值（下面的 Timer 就是用它启动的）。
        # 动作组运行期间会把 pump_timeout_sec 临时放宽，结束后又恢复——
        # 倒计时必须锁定生效值，否则恢复瞬间界面剩余时间会突变、与真实放气对不上。
        self._pump_effective_timeout = self.pump_timeout_sec
        time.sleep(0.5)  # 等待建立负压
        # 再多停一会儿，让吸盘把工件真正吸牢再进入下一步移动
        # （否则会出现"还没吸住就被带走"的吸取失败）。0 表示不额外停留。
        dwell = getattr(config, 'PUMP_SUCK_DWELL_MS', 0) or 0
        if dwell > 0:
            time.sleep(dwell / 1000.0)
        # 吸气是持续状态，异常中断时可能长时间保持，这里起一个超时保护
        self._cancel_pump_timer()
        self._pump_timer = threading.Timer(self.pump_timeout_sec, self._on_pump_timeout)
        self._pump_timer.daemon = True
        self._pump_timer.start()
        self._pump_suck_start = time.time()

    def pump_release(self):
        """气泵放气：瞬时释放真空，然后停止抽气（非持续状态）。"""
        self._cancel_pump_timer()
        self._pump_suck_start = None
        with self.lock:
            self._raw_send(f"#{_fmt_id(SERVO_PUMP)}P{_fmt_pwm(self.pump_release_pwm)}T0500!")
        time.sleep(0.5)  # 等待真空释放
        with self.lock:
            self._raw_send(f"#{_fmt_id(SERVO_PUMP)}P{_fmt_pwm(self.pump_off_pwm)}T0100!")
            self.pump_state = 'off'
        # 真机实测：放气是**两条**指令(释放+停止)，第二条发完若立即返回，
        # 紧随其后的多合一舵机指令(5 路，较长)会被串口/控制器堵住而明显变慢
        # ——表现为"放气卡之后的那一步被严重拖慢"。这里留一点时间让它消化。
        # （吸气只有一条指令且后面有 0.5s 等待，所以不受影响）
        time.sleep(0.15)

    def pump_off(self):
        """气泵停止。"""
        self._cancel_pump_timer()
        self._pump_suck_start = None
        with self.lock:
            self._raw_send(f"#{_fmt_id(SERVO_PUMP)}P{_fmt_pwm(self.pump_off_pwm)}T0100!")
            self.pump_state = 'off'

    # ---------- 动作组 ----------

    def run_action_group(self, group_id):
        """调用单个动作组 $DGS:N!。"""
        with self.lock:
            self._raw_send(f"$DGS:{int(group_id)}!")

    def run_action_range(self, start, end, count=1):
        """调用动作组范围 $DGT:start-end,count!。"""
        with self.lock:
            self._raw_send(f"$DGT:{int(start)}-{int(end)},{int(count)}!")

    # ---------- 标定姿态 ----------

    def _write_poses(self, poses, user_id=None, mode='normal'):
        """写回姿态字典。**按用户隔离**（公用设备轮流使用，各人各一套）。

        user_id 为空时回落到全局 arm_config.poses_json（兼容旧调用）。
        mode 参数保留仅为兼容，实际忽略（不再按普通/高级分两套）。
        """
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                if user_id:
                    cur.execute(
                        "UPDATE users SET normal_poses_json=%s WHERE id=%s",
                        (json.dumps(poses, ensure_ascii=False), user_id)
                    )
                else:
                    cur.execute(
                        "UPDATE arm_config SET poses_json=%s, updated_at=NOW() WHERE id=1",
                        (json.dumps(poses, ensure_ascii=False),)
                    )
            conn.commit()
        finally:
            conn.close()

    def save_pose(self, name, user_id=None, mode='normal'):
        """将当前各舵机 PWM 保存为命名姿态（合并写入，不覆盖其他姿态）。

        按用户隔离：写到该用户的 users.normal_poses_json。
        """
        valid = {k for k, _ in self._all_pose_names(user_id)}
        if name not in valid:
            return False, f"未知姿态名: {name}"
        poses = self.load_poses(user_id, mode)
        existed = name in poses          # 已标定过 -> 文案用"更新"，与前端按钮一致
        poses[name] = {str(sid): self.current_pose.get(sid, 1500) for sid in range(6)}
        try:
            self._write_poses(poses, user_id, mode)
        except Exception as e:
            logger.warning("[arm] 保存姿态失败: %s", e)
            return False, f"保存失败: {e}"
        label = dict(self._all_pose_names(user_id)).get(name, name)
        verb = "已更新姿态" if existed else "已保存姿态"
        return True, f"{verb}: {label}"

    def _all_pose_names(self, user_id=None):
        """返回所有姿态 (key, label)：home/pick + 动态放置位。

        放置位列表**按用户隔离**（user_id 为空时回落到全局 arm_config.areas）。
        """
        names = [('home', '原点'), ('pick', '抓取位')]
        areas = None
        if user_id:
            try:
                areas = db.ensure_user_arm_config(user_id).get('areas')
            except Exception as e:
                logger.debug("[arm] 读取用户放置位失败，回落全局: %s", e)
        if areas is None:
            conn = db.get_db()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT areas FROM arm_config WHERE id=1")
                    row = cur.fetchone()
                    if row and row.get('areas'):
                        areas = json.loads(row['areas'])
            finally:
                conn.close()
        for a in (areas or []):
            names.append((a['key'], a.get('label', a['key'])))
        return names

    def load_poses(self, user_id=None, mode='normal'):
        """加载标定姿态，返回 {pose_name: {sid: pwm}}。

        按用户隔离（users.normal_poses_json）；user_id 为空时回落全局。
        """
        if user_id:
            try:
                cfg = db.ensure_user_arm_config(user_id)
                return cfg.get('normal_poses_json') or {}
            except Exception as e:
                logger.debug("[arm] 读取用户姿态失败，回落全局: %s", e)
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT poses_json FROM arm_config WHERE id=1")
                row = cur.fetchone()
                if row and row.get('poses_json'):
                    return json.loads(row['poses_json'])
            return {}
        finally:
            conn.close()

    def _at_pose(self, target, tol=20):
        """判断当前缓存姿态是否已在目标姿态（偏差容差 tol PWM）。"""
        for sid, pwm in target.items():
            if abs(self.current_pose.get(int(sid), 1500) - int(pwm)) > tol:
                return False
        return True

    def goto_point(self, servos, duration=None, via_home=None, user_id=None, mode='normal'):
        """移动到任意关节点位（编辑器里"途经点"卡片单步执行用）。

        逻辑与 goto_pose 完全一致 —— 关键是**同样受 via_home 行程开关控制**：
        开了"近远点"就先回原点再过去，选"直达"就直接过去。

        servos: {关节id: pwm}，只取前 5 路（不含气泵通道）。
        duration: None 时按位移自动计算。
        """
        if via_home is None:
            via_home = self.via_home
        servos = {int(k): int(v) for k, v in (servos or {}).items() if int(k) < 5}
        if not servos:
            return False, "点位数据为空"
        if via_home:
            poses = self.load_poses(user_id, mode)
            if poses and 'home' in poses:
                home_servos = {int(k): int(v) for k, v in poses['home'].items() if int(k) < 5}
                if home_servos and not self._at_pose(home_servos):
                    d = duration if duration else calc_move_duration(
                        home_servos, self.current_pose, user_id=user_id)
                    self.move_servos(home_servos, duration=d, wait_reached=True)
        d2 = duration if duration else calc_move_duration(
            servos, self.current_pose, user_id=user_id)
        self.move_servos(servos, duration=d2, wait_reached=True)
        return True, "已到达该点位"

    def goto_pose(self, name, duration=None, via_home=None, user_id=None, mode='normal'):
        """移动到标定姿态。

        duration: 指定这一步用多少毫秒。**为 None（默认）时按位移自动计算**
                  （见 calc_move_duration）—— 控制器严格按 T 参数执行，固定时长会导致
                  大幅移动顿挫、小幅移动白等。指定具体值则按该值执行（向后兼容）。
        via_home: True=先经过原点过渡（防碰撞）；False=直达目标（更快但有碰撞风险）。
                  为 None（默认）时取全局开关 self.via_home —— 手动点姿态按钮与
                  自动分拣都经由本函数，因此该全局开关对两者同时生效。
        user_id/mode: 决定读取哪一套标定姿态。
        """
        if via_home is None:
            via_home = self.via_home
        poses = self.load_poses(user_id, mode)
        if name not in poses:
            return False, "姿态未标定，请先保存"
        # 非原点目标：若当前不在原点，先回原点
        if via_home and name != 'home' and 'home' in poses:
            home_servos = {int(k): int(v) for k, v in poses['home'].items() if int(k) < 5}
            if not self._at_pose(home_servos):
                # 两段位移不同，各算各的（原先共用一个 duration，短的那段会白等）
                d = duration if duration else calc_move_duration(
                    home_servos, self.current_pose, user_id=user_id)
                self.move_servos(home_servos, duration=d, wait_reached=True)
        # 再移动到目标
        pose = poses[name]
        servos = {int(k): int(v) for k, v in pose.items() if int(k) < 5}
        d2 = duration if duration else calc_move_duration(
            servos, self.current_pose, user_id=user_id)
        self.move_servos(servos, duration=d2, wait_reached=True)
        label = dict(self._all_pose_names(user_id)).get(name, name)
        return True, f"已移动到: {label}"

    def list_poses_status(self, user_id=None, mode='normal'):
        """返回各姿态标定状态（home/pick + 动态放置位），按用户 + 按模式。"""
        poses = self.load_poses(user_id, mode)
        result = {}
        for name, label in self._all_pose_names(user_id):
            result[name] = {
                'label': label,
                'calibrated': name in poses,
                'pose': poses.get(name, {}),
            }
        return result

    # 注：原「高层动作（自动分拣用）」的 pick_sequence() / place_sequence()
    # 已由 sorter._sort_sequence() 取代，且全项目无任何调用点（含前端与文档），
    # 于 2026-10-12 作为死代码移除。如需单独触发"抓取/放置"，改调 sorter 或直接
    # 组合 goto_pose() + 气泵接口即可。

    def check_connection(self):
        """已连接时探测串口是否还通，断开则自动关闭并返回 False。"""
        if not self.connected or not self.ser:
            return False
        try:
            with self.lock:
                self._raw_send_and_read("#000PRAD!", timeout=0.4)
            return True
        except Exception as e:
            logger.warning("[arm] 串口读写失败，已关闭连接: %s", e)
            try:
                self.ser.close()
            except Exception as e2:
                logger.debug("[arm] 关闭串口失败: %s", e2)
            self.ser = None
            self.connected = False
            self.busy = False
            self.pump_state = 'off'
            return False

    def get_status(self):
        """返回控制器状态字典。"""
        return {
            'connected': self.connected,
            'port': self.port,
            'baudrate': self.baudrate,
            'busy': self.busy,
            'via_home': self.via_home,
            'pump_state': self.pump_state,
            'pump_timeout_sec': self.pump_timeout_sec,
            'pump_remaining_sec': (
                # 用 ceil 而非 round：倒计时要走稳定的整数阶梯（115.2 与 115.9 都显示 116），
                # 若用 round 会在 x.5 附近抖动，与前端本地递减的计数器互相拉扯，
                # 表现为数字在两个值之间来回跳、偶尔吞秒
                max(0, int(math.ceil(self._pump_effective_timeout - (time.time() - self._pump_suck_start))))
                if (self.pump_state == 'suck' and self._pump_suck_start is not None) else None
            ),
            'current_pose': self.current_pose,
        }


# 全局单例
arm = ArmController()
