# -*- coding: utf-8 -*-
"""自定义动作组（高级行程模式）服务层。

职责：
  - 途经点卡片（waypoints）与动作组（action_groups）的 CRUD，**按 user_id 隔离**；
  - 画布图（nodes + edges）的**合法性校验**与**编译**（图 -> 有序步骤）；
  - 动作组的**顺序执行**（整组运行 + 可中止）。

设计要点：
  - 位置卡存**引用**（pose 名 / waypoint id），不存数值快照 —— 重新标定后自动跟随；
  - 执行用 arm.move_servos() **绕过 goto_pose()**，因此不受「经原点/直达」开关影响；
  - 连线分两种 kind：main（主链，蓝）/ action（随行动作，绿），跨色一律拒绝。
"""
import time
import threading
import logging
import json

import db
import config
from arm_controller import arm, calc_move_duration
from detector import detector

logger = logging.getLogger("helmet.action_group")

# 功能卡合法动作：吸气 / 放气 / 等待（等待 = 不吸不放，停留）
VALID_ACTIONS = ('suck', 'release', 'off')
# 位置卡类型
POSITION_TYPES = ('pose', 'waypoint')
PWM_MIN, PWM_MAX = 500, 2500
ACTION_LABELS = {'suck': '吸气', 'release': '放气', 'off': '等待'}


def _dump(value):
    """序列化为 JSON 字符串（中文不转义）。"""
    return __import__('json').dumps(value, ensure_ascii=False)


class ActionGroupService:
    """自定义动作组服务（单例）。"""

    def __init__(self):
        self._run_lock = threading.Lock()
        self._running = False          # 是否正在执行动作组
        self._stop = False             # 中止请求
        self._status = {               # 供前端轮询的执行进度
            'running': False,
            'group_id': None,
            'group_name': '',
            'step': 0,
            'step_total': 0,
            'label': '',
            'error': '',
        }

    # ---------- 状态 ----------

    def get_status(self):
        with self._run_lock:
            return dict(self._status)

    def stop(self):
        """请求中止当前动作组（急停也走这里）。"""
        self._stop = True
        try:
            arm.stop_all()
            # 放气收尾（pump_release 内部要等 0.65s）放后台线程：
            # 急停/中止接口必须立刻返回，不能让前端 toast 跟着拖秒
            threading.Thread(target=self._pump_after_stop, daemon=True).start()
        except Exception as e:
            logger.warning("[action_group] 中止时停止机械臂失败: %s", e)
        return True, '已请求中止'

    def _pump_after_stop(self):
        """中止/急停后的气泵收尾（后台线程执行，不阻塞接口返回）。"""
        try:
            arm.pump_release()
            arm.pump_off()
        except Exception as e:
            logger.warning("[action_group] 中止后气泵收尾失败: %s", e)

    # ---------- 途经点卡片 ----------

    def list_waypoints(self, user_id):
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, name, pwm_json, updated_at FROM waypoints"
                    " WHERE user_id=%s ORDER BY id", (user_id,)
                )
                rows = cur.fetchall() or []
        finally:
            conn.close()
        out = []
        for r in rows:
            pwm = r.get('pwm_json')
            if isinstance(pwm, str):
                try:
                    pwm = __import__('json').loads(pwm)
                except Exception:
                    pwm = {}
            out.append({
                'id': r['id'], 'name': r['name'], 'pwm': pwm or {},
                'updated_at': str(r.get('updated_at') or ''),
            })
        return out

    def save_waypoint(self, user_id, name, pwm):
        """新增或更新途经点卡片。pwm = {sid: value}（5 路）。"""
        name = (name or '').strip()
        if not name:
            return False, '请输入卡片名称', None
        pwm = self._norm_pwm(pwm)
        if not pwm:
            return False, '姿态数据无效', None
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                # 同名则更新，否则新增（同一用户内名称不重复）
                cur.execute("SELECT id FROM waypoints WHERE user_id=%s AND name=%s",
                            (user_id, name))
                row = cur.fetchone()
                if row:
                    cur.execute(
                        "UPDATE waypoints SET pwm_json=%s WHERE id=%s",
                        (_dump(pwm), row['id'])
                    )
                    wid = row['id']
                else:
                    cur.execute(
                        "INSERT INTO waypoints (user_id, name, pwm_json) VALUES (%s, %s, %s)",
                        (user_id, name, _dump(pwm))
                    )
                    wid = cur.lastrowid
            conn.commit()
        except Exception as e:
            logger.warning("[action_group] 保存途经点失败: %s", e)
            return False, '保存失败', None
        finally:
            conn.close()
        return True, '已保存途经点「%s」' % name, wid

    def delete_waypoint(self, waypoint_id, user_id):
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM waypoints WHERE id=%s AND user_id=%s",
                            (waypoint_id, user_id))
                affected = cur.rowcount
            conn.commit()
        finally:
            conn.close()
        if not affected:
            return False, '卡片不存在或无权删除'
        return True, '已删除途经点'

    def capture_waypoint(self, user_id, name):
        """读取机械臂当前姿态，存为途经点卡片。"""
        if not arm.connected:
            return False, '机械臂未连接', None
        if arm.busy:
            return False, '机械臂正忙，请稍候', None
        pwm = arm.read_current_pose()
        if not pwm:
            return False, '读取当前姿态失败', None
        return self.save_waypoint(user_id, name, pwm)

    # ---------- 动作组 ----------

    def list_groups(self, user_id):
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, name, remark, updated_at FROM action_groups"
                    " WHERE user_id=%s ORDER BY id", (user_id,)
                )
                rows = cur.fetchall() or []
        finally:
            conn.close()
        return [{
            'id': r['id'], 'name': r['name'], 'remark': r.get('remark') or '',
            'updated_at': str(r.get('updated_at') or ''),
        } for r in rows]

    def get_group(self, group_id, user_id):
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, name, remark, graph_json FROM action_groups"
                    " WHERE id=%s AND user_id=%s", (group_id, user_id)
                )
                row = cur.fetchone()
        finally:
            conn.close()
        if not row:
            return None
        graph = row.get('graph_json')
        if isinstance(graph, str):
            try:
                graph = __import__('json').loads(graph)
            except Exception:
                graph = {'nodes': [], 'edges': []}
        return {
            'id': row['id'], 'name': row['name'],
            'remark': row.get('remark') or '',
            'graph': graph or {'nodes': [], 'edges': []},
        }

    def save_group(self, group_id, user_id, name, graph, remark=''):
        name = (name or '').strip()
        if not name:
            return False, '请输入动作组名称', None
        ok, err = self.validate_graph(graph, user_id)
        if not ok:
            return False, err, None
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                if group_id:
                    # 存在性必须单独 SELECT 判断：UPDATE 的 rowcount 是「实际改变的行数」，
                    # 当提交内容与库里完全一致时会返回 0（matched=1, changed=0），
                    # 若拿它当"组不存在"会误报（典型场景：先画卡片→新建→立刻再保存）。
                    cur.execute(
                        "SELECT id FROM action_groups WHERE id=%s AND user_id=%s",
                        (group_id, user_id)
                    )
                    if not cur.fetchone():
                        return False, '动作组不存在或无权修改', None
                    cur.execute(
                        "UPDATE action_groups SET name=%s, remark=%s, graph_json=%s"
                        " WHERE id=%s AND user_id=%s",
                        (name, remark or '', _dump(graph), group_id, user_id)
                    )
                else:
                    cur.execute(
                        "INSERT INTO action_groups (user_id, name, remark, graph_json)"
                        " VALUES (%s, %s, %s, %s)",
                        (user_id, name, remark or '', _dump(graph))
                    )
                    group_id = cur.lastrowid
            conn.commit()
        except Exception as e:
            logger.warning("[action_group] 保存动作组失败: %s", e)
            return False, '保存失败', None
        finally:
            conn.close()
        return True, '已保存动作组「%s」' % name, group_id

    def delete_group(self, group_id, user_id):
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM action_groups WHERE id=%s AND user_id=%s",
                            (group_id, user_id))
                affected = cur.rowcount
            conn.commit()
        finally:
            conn.close()
        if not affected:
            return False, '动作组不存在或无权删除'
        # 连带清理类别映射中指向该组的引用：
        #   - 全局"当前"份 class_group_map；
        #   - 每个模型各存的那份 group_map_by_model（只清全局会残留：
        #     切回该模型后高级模式拿着已删除的组 id 去跑，必然失败）。
        try:
            conn = db.get_db()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT class_group_map, group_map_by_model"
                                " FROM users WHERE id=%s", (user_id,))
                    row = cur.fetchone() or {}
                    cmap = row.get('class_group_map') or {}
                    if isinstance(cmap, str):
                        cmap = json.loads(cmap) if cmap else {}
                    new_map = {k: v for k, v in cmap.items() if v != group_id}
                    gbm = row.get('group_map_by_model') or {}
                    if isinstance(gbm, str):
                        gbm = json.loads(gbm) if gbm else {}
                    changed = len(new_map) != len(cmap)
                    for _m in list(gbm.keys()):
                        _mm = gbm.get(_m)
                        if isinstance(_mm, dict):
                            _new = {k: v for k, v in _mm.items() if v != group_id}
                            if len(_new) != len(_mm):
                                gbm[_m] = _new
                                changed = True
                    if changed:
                        cur.execute(
                            "UPDATE users SET class_group_map=%s, group_map_by_model=%s"
                            " WHERE id=%s",
                            (_dump(new_map), _dump(gbm), user_id))
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            logger.debug("[action_group] 清理类别映射引用失败: %s", e)
        return True, '已删除动作组'

    # ---------- 姿态解析（按用户 + 按模式） ----------

    def _user_poses(self, user_id, mode):
        """姿态标定**按用户隔离**（各人一套）。

        mode 参数保留仅为兼容，实际忽略（不再按普通/高级分两套）。
        """
        return arm.load_poses(user_id)

    def _area_keys(self, user_id):
        cfg = db.ensure_user_arm_config(user_id)
        return [a.get('key') for a in (cfg.get('areas') or [])]

    # ---------- 校验与编译 ----------

    @staticmethod
    def _norm_pwm(pwm):
        """整理并校验 5 路 PWM：{sid: value}，范围 500~2500。"""
        if not isinstance(pwm, dict):
            return None
        out = {}
        for sid in range(5):
            v = pwm.get(sid, pwm.get(str(sid)))
            if v is None:
                return None
            try:
                v = int(v)
            except Exception:
                return None
            if v < PWM_MIN or v > PWM_MAX:
                return None
            out[sid] = v
        return out

    def validate_graph(self, graph, user_id, mode='advanced'):
        """校验画布图。返回 (ok, err_msg)。

        规则：
          - 位置卡（pose/waypoint）：主链出口 ≤1、主链入口 ≤1、动作入口 ≤1
          - 功能卡（action）：只有出口，且 ≤1；不能被主链穿过
          - 颜色合法性：kind=main 两端必须都是位置卡；kind=action 必须 功能卡 → 位置卡
        """
        if not isinstance(graph, dict):
            return False, '画布数据格式错误'
        nodes = graph.get('nodes') or []
        edges = graph.get('edges') or []
        # 空画布允许保存（新建动作组时画布就是空的）；是否为空只在【运行】时要求
        if not nodes:
            return True, ''

        by_id = {}
        for n in nodes:
            nid = n.get('id')
            if not nid:
                return False, '存在缺少 id 的卡片'
            if nid in by_id:
                return False, '卡片 id 重复：%s' % nid
            by_id[nid] = n
            ntype = n.get('type')
            if ntype in POSITION_TYPES:
                if ntype == 'pose' and not n.get('ref'):
                    return False, '姿态卡缺少引用'
                if ntype == 'waypoint' and n.get('ref') is None:
                    return False, '途经点卡缺少引用'
            elif ntype == 'action':
                if n.get('action') not in VALID_ACTIONS:
                    return False, '功能卡动作无效：%s' % n.get('action')
            else:
                return False, '未知卡片类型：%s' % ntype

        main_out, main_in, act_in, act_out = {}, {}, {}, {}
        for e in edges:
            src, dst, kind = e.get('from'), e.get('to'), e.get('kind', 'main')
            if src not in by_id or dst not in by_id:
                return False, '连线指向了不存在的卡片'
            if src == dst:
                return False, '卡片不能连自己'
            stype, dtype = by_id[src].get('type'), by_id[dst].get('type')
            if kind == 'main':
                # 蓝色：位置卡 -> 位置卡
                if stype not in POSITION_TYPES or dtype not in POSITION_TYPES:
                    return False, '主链（蓝色）只能连接位置卡'
                main_out[src] = main_out.get(src, 0) + 1
                main_in[dst] = main_in.get(dst, 0) + 1
                if main_out[src] > 1:
                    return False, '一张位置卡只能连出一条主链（禁止分支）'
                if main_in[dst] > 1:
                    return False, '一张位置卡只能有一条主链进入'
            elif kind == 'action':
                # 绿色：功能卡 -> 位置卡
                if stype != 'action' or dtype not in POSITION_TYPES:
                    return False, '随行动作（绿色）只能由功能卡连到位置卡'
                act_out[src] = act_out.get(src, 0) + 1
                act_in[dst] = act_in.get(dst, 0) + 1
                if act_out[src] > 1:
                    return False, '一个功能卡只能挂到一张位置卡'
                if act_in[dst] > 1:
                    return False, '一张位置卡只能挂一个随行动作'
            else:
                return False, '未知连线类型：%s' % kind
        return True, ''

    def resolve_sequence(self, graph, user_id, mode='advanced'):
        """把画布图编译成有序步骤。返回 (steps, err)。

        steps 元素：{"kind":"move"|"action", "pwm":{...}, "duration":ms,
                     "action":"suck|release|off", "ms":ms, "label":str}
        """
        ok, err = self.validate_graph(graph, user_id, mode)
        if not ok:
            return None, err
        if not (graph.get('nodes') or []):
            return None, '画布上还没有任何卡片，请先添加卡片再运行'

        nodes = {n['id']: n for n in (graph.get('nodes') or [])}
        edges = graph.get('edges') or []

        pos_ids = {i for i, n in nodes.items() if n.get('type') in POSITION_TYPES}
        main_next, act_of = {}, {}
        has_main_in = set()
        for e in edges:
            if e.get('kind', 'main') == 'main':
                main_next[e['from']] = e['to']
                has_main_in.add(e['to'])
            else:
                act_of[e['from']] = e['to']

        # 起点：位置卡中无主链入线的（多条链取最长）
        starts = [i for i in pos_ids if i not in has_main_in]
        if not starts:
            return None, '没有找到起点（主链可能成环）'

        def chain_len(s):
            n, seen, c = s, set(), 0
            while n in main_next and n not in seen:
                seen.add(n)
                n = main_next[n]
                c += 1
                if c > 500:
                    break
            return c

        start = max(starts, key=chain_len)
        # 隐藏 bug 防护：画布上没有任何主链连线时（全是孤立卡），max 会随机选中
        # 一张孤立卡并"运行一步"——按既定规则（孤立卡忽略、只跑主链）应当拒绝
        if chain_len(start) == 0:
            return None, '画布上还没有连线，请先用蓝色主链把卡片连起来'

        # 沿主链走
        order, cur, seen = [], start, set()
        while cur is not None:
            if cur in seen:
                return None, '主链存在环，无法执行'
            seen.add(cur)
            order.append(cur)
            cur = main_next.get(cur)

        poses = self._user_poses(user_id, mode)
        # 第 1 步的起点 = 机械臂当前姿态；之后每步起点 = 上一步的目标
        prev_pwm = {sid: int(arm.current_pose.get(sid, 1500)) for sid in range(5)}
        # 速度档位（**按用户隔离**：谁触发运行就按谁的档位）
        try:
            speed_profile = db.get_arm_move_speed(user_id)
        except Exception as e:
            logger.debug("[action_group] 读取速度档位失败，用默认值: %s", e)
            speed_profile = config.MOVE_SPEED_DEFAULT
        # 步骤标签用中文显示名，避免前端出现 home/pick/place_1 这类英文 key
        pose_labels = {}
        try:
            st = arm.list_poses_status(user_id)   # 姿态按用户隔离
            pose_labels = {k: (v.get('label') or k) for k, v in (st or {}).items()}
        except Exception as e:
            logger.debug("[action_group] 读取姿态显示名失败: %s", e)
        wp_names = self._waypoint_names(user_id)

        steps = []
        for idx, nid in enumerate(order):
            node = nodes[nid]
            if node.get('type') == 'pose':
                ref = node.get('ref')
                if ref not in poses:
                    return None, '姿态「%s」尚未标定，请先标定后再运行' % pose_labels.get(ref, ref)
                pwm = self._norm_pwm(poses[ref])
                label = '姿态 %s' % pose_labels.get(ref, ref)
            else:
                wref = node.get('ref')
                wp = self._get_waypoint(wref, user_id)
                if not wp:
                    return None, '途经点卡片不存在或已被删除'
                pwm = self._norm_pwm(wp)
                label = '途经点 %s' % wp_names.get(wref, wref)
            if not pwm:
                return None, '%s 的姿态数据无效' % label
            # 按时长 = f(位移) 智能计算：控制器严格按 T 参数执行，时长给不够就会
            # 出现"没走完就被下一步打断"的顿挫；给太多则白白浪费时间。
            # 位移取 5 路里差值最大的那一关节（T 为所有关节共享，走得最多的决定总时长）。
            duration = calc_move_duration(pwm, prev_pwm, speed_profile)
            prev_pwm = dict(pwm)

            # 挂在该位置卡上的随行动作
            action, ms = None, 0
            for src, dst in act_of.items():
                if dst == nid:
                    anode = nodes.get(src) or {}
                    action = anode.get('action')
                    try:
                        ms = int(anode.get('ms', 500))
                    except Exception:
                        ms = 500
                    break

            steps.append({
                'kind': 'move', 'pwm': pwm, 'duration': duration,
                'action': action, 'ms': max(0, min(ms, 60000)),
                'label': '%d. %s' % (idx + 1, label),
                'node_id': nid,
            })
        return steps, ''

    def _waypoint_names(self, user_id):
        """返回该用户所有途经点卡片的 {id: 名称}，用于步骤显示中文名。"""
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT id, name FROM waypoints WHERE user_id=%s", (user_id,))
                rows = cur.fetchall() or []
            return {r['id']: r['name'] for r in rows}
        except Exception as e:
            logger.debug("[action_group] 读取途经点名称失败: %s", e)
            return {}
        finally:
            conn.close()

    def _get_waypoint(self, waypoint_id, user_id):
        conn = db.get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT pwm_json FROM waypoints WHERE id=%s AND user_id=%s",
                            (waypoint_id, user_id))
                row = cur.fetchone()
        finally:
            conn.close()
        if not row:
            return None
        pwm = row.get('pwm_json')
        if isinstance(pwm, str):
            try:
                pwm = __import__('json').loads(pwm)
            except Exception:
                return None
        return pwm

    # ---------- 执行 ----------

    def run_group_async(self, group_id, user_id, username, defect_class=None, confidence=None):
        """在后台线程运行动作组（不阻塞请求）。

        defect_class: 触发本次运行的类别（视觉自动分拣时传入），用于在动作组
        **成功跑完后**补写一条分拣记录 —— 否则高级模式的计分统计会永远是 0
        （普通模式走 sorter.submit_detection 自行写库，不受影响）。
        """
        with self._run_lock:
            if self._running:
                return False, '已有动作组正在运行'
            self._running = True
            self._stop = False
            self._trigger_class = (defect_class or '').strip()
            self._trigger_uid = user_id
            self._trigger_username = username
            self._trigger_conf = confidence
            self._status = {
                'running': True, 'group_id': group_id, 'group_name': '',
                'step': 0, 'step_total': 0, 'label': '准备中', 'error': '',
            }
        self._run_t0 = time.time()
        group = self.get_group(group_id, user_id)
        if not group:
            with self._run_lock:
                self._running = False
                self._status['running'] = False
            return False, '动作组不存在或无权运行'
        self._status['group_name'] = group['name']
        # 记录里存**动作组 id**（而非名字）：改名后历史记录能显示新名字，
        # 存名字的话改名不会追溯（用户反馈"改了组名刷新也不更新"）
        self._status['group_id'] = group['id']
        t = threading.Thread(
            target=self._run, args=(group, user_id, username), daemon=True
        )
        t.start()
        return True, '已开始运行「%s」' % group['name']

    def run_group(self, group_id, user_id, username):
        """同步运行（供手动调用）。"""
        ok, msg = self.run_group_async(group_id, user_id, username)
        return ok, msg

    def _run(self, group, user_id, username):
        # 动作组可能很长（多步移动累计可达几十秒）。气泵的"吸气超时自动放气"保护
        # 默认只有 10 秒，若在运行途中触发会导致工件半路掉落。
        # 这里临时放宽，_finish 时恢复原值。
        self._old_pump_timeout = getattr(arm, 'pump_timeout_sec', None)
        try:
            arm.pump_timeout_sec = max(self._old_pump_timeout or 10, 120)
        except Exception as e:
            logger.debug("[action_group] 放宽气泵超时保护失败: %s", e)
        try:
            steps, err = self.resolve_sequence(group['graph'], user_id, 'advanced')
            if err:
                self._finish(error=err)
                return
            if not arm.connected:
                self._finish(error='机械臂未连接')
                return
            total = len(steps)
            with self._run_lock:
                self._status.update({'step_total': total, 'step': 0})
            for i, st in enumerate(steps):
                if self._stop:
                    self._finish(error='已中止')
                    return
                if not arm.connected:
                    self._finish(error='机械臂连接已断开')
                    return
                # 先更新进度、再执行动作：否则整个步骤执行期间（1.2s+）状态条仍停留在
                # 上一步（或 0/6「准备中」），且最后一步做完立刻 _finish 换成「完成」，
                # 「N/N」永远来不及被轮询看到 —— 表现为步骤乱跳、最后一步不显示
                with self._run_lock:
                    # 带出本步时长，便于界面显示与真机标定（判断某个关节是否给够时间）
                    self._status.update({'step': i + 1, 'label': st['label'], 'dur': st['duration']})
                # 逐步重新置位 busy：move_servos 结束会清掉 busy，
                # 不重新置位的话「吸气/等待」等步骤间隙会被 UI 误判为空闲而放开操作
                arm.busy = True
                # 步间小间隔：给串口/控制器消化上一条指令的时间。
                # 真机实测"放气卡之后的那一步被严重拖慢" —— 放气要发两条指令，
                # 紧接着发下一步的多合一舵机指令会被堵住，这里留出喘息时间。
                gap_ms = getattr(config, 'MOVE_STEP_GAP_MS', 0) or 0
                if i > 0 and gap_ms > 0:
                    time.sleep(gap_ms / 1000.0)
                t0 = time.time()
                try:
                    # wait_reached：等完预设时长后再回读校验，没到位就补等，
                    # 避免"机械臂还没走完就被下一步指令打断"
                    arm.move_servos(st['pwm'], st['duration'], wait_reached=True)
                    # move_servos 内部结束会清 busy；本组还没跑完，继续保持占用，
                    # 避免随后的吸气/放气/等待期间出现 busy=False 的空窗
                    arm.busy = True
                    if st.get('action') == 'suck':
                        arm.pump_suck()
                    elif st.get('action') == 'release':
                        arm.pump_release()
                    elif st.get('action') == 'off':
                        time.sleep(st.get('ms', 500) / 1000.0)
                except Exception as e:
                    logger.warning("[action_group] 执行步骤失败: %s", e)
                    self._finish(error='执行失败：%s' % e)
                    return
                # 诊断：记录每步"实际耗时 vs 预定时长"，便于定位某一步为何被拖慢
                logger.info("[action_group] 步骤 %d/%d 「%s」预设 %dms，实际 %.2fs，随行动作=%s",
                            i + 1, total, st['label'], st['duration'],
                            time.time() - t0, st.get('action') or '无')
            self._finish(error='')
        except Exception as e:
            logger.warning("[action_group] 运行动作组异常: %s", e)
            self._finish(error='运行异常：%s' % e)

    def _finish(self, error=''):
        cls = getattr(self, '_trigger_class', '')
        with self._run_lock:
            self._running = False
            self._status['running'] = False
            self._status['error'] = error
            if not error:
                self._status['label'] = '完成'
                # 触发类别保留在状态里（随后 _trigger_class 被清空），
                # 供前端完成通知显示「分拣完成「类别」→ 动作组」
                self._status['trigger_class'] = cls
        # 高级模式：动作组**成功跑完**才补写分拣记录（普通模式由 sorter 自行写库）
        if not error and cls:
            self._save_advanced_record(cls)
        self._trigger_class = ''
        # 释放机械臂占用，让工控页恢复可操作
        try:
            arm.busy = False
        except Exception:
            pass
        # 恢复气泵吸气超时保护（运行期间被临时放宽）
        ot = getattr(self, '_old_pump_timeout', None)
        if ot is not None:
            try:
                arm.pump_timeout_sec = ot
            except Exception:
                pass
            self._old_pump_timeout = None

    def _save_advanced_record(self, defect_class):
        """高级模式：动作组**成功跑完后**补写一条分拣记录。

        背景：普通模式走 sorter.submit_detection，内部会自行写 sort_records；
        而高级模式走 action_groups.run_group_async 这条路径，以前**完全不落库**，
        导致「今日计分统计」在高级模式下恒为 0。
        """
        if not defect_class:
            return
        try:
            conn = db.get_db()
            try:
                with conn.cursor() as cur:
                    # place_area 列存**动作组 id**（高级模式没有单一"放置位"概念）。
                    # 存 id 而非名字：动作组改名后，历史记录自动显示新名字；
                    # 存名字则改名无法追溯。旧记录里存的是名字，前端仍能兼容显示。
                    gid = self._status.get('group_id')
                    gname = (str(gid) if gid else (self._status.get('group_name') or ''))[:16]
                    cur.execute(
                        "INSERT INTO sort_records "
                        "(user_id, username, defect_class, confidence, place_area, "
                        " pick_success, duration_ms, model_name) "
                        "VALUES (%s, %s, %s, %s, %s, 1, %s, %s)",
                        (self._trigger_uid or 1, self._trigger_username or 'system',
                         defect_class,
                         float(self._trigger_conf) if self._trigger_conf is not None else None,
                         gname,
                         int((time.time() - (self._run_t0 or time.time())) * 1000),
                         detector.current_file or ''),
                    )
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            logger.warning("[action_group] 分拣记录落库失败: %s", e)


# 全局单例
action_groups = ActionGroupService()
