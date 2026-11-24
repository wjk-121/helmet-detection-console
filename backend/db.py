# -*- coding: utf-8 -*-
"""MySQL 连接与建表。"""
import json
import logging
import queue
import random
import string
import threading
import pymysql
from pymysql.cursors import DictCursor
logger = logging.getLogger("yolo.db")
from config import DB_CONFIG, DB_NAME, DB_POOL_SIZE


def _conn(database=None):
    cfg = dict(DB_CONFIG)
    if database:
        cfg["database"] = database
    return pymysql.connect(cursorclass=DictCursor, **cfg)


# ---------- 轻量连接池 ----------
# 业务代码只用到 conn.cursor() / commit() / close()，封装一个薄包装即可安全复用连接；
# 归还时回滚未提交事务，避免脏事务跨请求复用。无第三方依赖（DBUtils 未安装）。
class _PooledConnection:
    def __init__(self, pool, conn):
        self._pool = pool
        self._conn = conn
        self._closed = False

    def cursor(self, *a, **k):
        return self._conn.cursor(*a, **k)

    def commit(self):
        return self._conn.commit()

    def rollback(self):
        return self._conn.rollback()

    def ping(self, *a, **k):
        return self._conn.ping(*a, **k)

    def close(self):
        if self._closed:
            return
        self._closed = True
        self._pool._return(self._conn)

    # 兼容 `with db.get_db() as conn` 写法（业务代码目前用的是 finally: conn.close()）
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False


class _ConnectionPool:
    def __init__(self, maxsize, **kwargs):
        self.maxsize = maxsize
        self.kwargs = kwargs
        self._queue = queue.Queue(maxsize=maxsize)
        self._created = 0
        self._lock = threading.Lock()

    def _create(self):
        return pymysql.connect(cursorclass=DictCursor, **self.kwargs)

    def _discard(self, conn):
        try:
            conn.close()
        except Exception:
            pass
        with self._lock:
            if self._created > 0:
                self._created -= 1

    def get(self):
        try:
            conn = self._queue.get_nowait()
        except queue.Empty:
            with self._lock:
                if self._created < self.maxsize:
                    self._created += 1
                    return _PooledConnection(self, self._create())
            conn = self._queue.get()  # 已达上限，阻塞等待归还
        try:
            conn.ping(reconnect=True)  # 健康检查（含断线重连）
        except Exception:
            self._discard(conn)
            return self.get()
        return _PooledConnection(self, conn)

    def _return(self, conn):
        try:
            conn.rollback()  # 清理可能残留的未提交事务
        except Exception:
            pass
        try:
            self._queue.put_nowait(conn)
        except queue.Full:
            self._discard(conn)


_POOL = None
_POOL_LOCK = threading.Lock()


def get_db():
    """从连接池取一个连接（使用后请 close，close 实际归还到池中）。"""
    global _POOL
    if _POOL is None:
        with _POOL_LOCK:
            if _POOL is None:
                cfg = dict(DB_CONFIG)
                cfg["database"] = DB_NAME
                _POOL = _ConnectionPool(maxsize=DB_POOL_SIZE, **cfg)
    return _POOL.get()


# ---------- 机械臂配置：按用户隔离 + 全局模板 ----------

# 用户级机械臂配置项（气泵 PWM 是硬件参数，保持全局，不在此列）
USER_ARM_CONFIG_KEYS = (
    "areas",
    "normal_class_map",
    "selected_classes",
    "normal_poses_json",
    "advanced_poses_json",
    "class_group_map",
)

# 用户列 -> arm_config(id=1) 模板列（无对应模板的项即高级模式专属，保持 NULL）
_USER_ARM_TEMPLATE_MAP = {
    "areas": "areas",
    "normal_class_map": "class_area_map",
    "selected_classes": "selected_classes",
    "normal_poses_json": "poses_json",
}

# 解析失败或为空时的回落值
_USER_ARM_FALLBACK = {
    "areas": [],
    "selected_classes": [],
    "normal_class_map": {},
    "class_group_map": {},
    "normal_poses_json": {},
    "advanced_poses_json": {},
    "arm_move_speed": 'normal',
}


def ensure_user_arm_config(user_id):
    """确保该用户拥有自己的机械臂配置副本；缺失项从 arm_config(id=1) 模板复制。

    机械臂是公共设施、同一时刻只进一人（页面独占锁），故每人一套配置互不干扰。
    - 已存在用户：把当前全局值复制为初始副本 —— **现有标定/映射不会丢失**；
    - 新用户：同样拿到模板副本，保证有默认放置位，不会"一个位都没有"。

    气泵 PWM（pump_suck_pwm / pump_release_pwm）保持全局，不复制。

    返回 dict：{"advanced_mode": bool, 各配置键: 已解析的 Python 对象}
    """
    if not user_id:
        return {}
    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT advanced_mode, " + ", ".join(USER_ARM_CONFIG_KEYS) +
                " FROM users WHERE id=%s",
                (user_id,)
            )
            row = cur.fetchone()
            if not row:
                return {}
            missing = [k for k in USER_ARM_CONFIG_KEYS if row.get(k) is None]
            if missing:
                cur.execute(
                    "SELECT areas, class_area_map, selected_classes, poses_json"
                    " FROM arm_config WHERE id=1"
                )
                tpl = cur.fetchone() or {}
                sets, vals = [], []
                for k in missing:
                    tcol = _USER_ARM_TEMPLATE_MAP.get(k)
                    v = tpl.get(tcol) if tcol else None
                    if v is None:
                        # 无模板来源（高级模式专属）：初始化为空值，
                        # 避免每次调用都因 NULL 再查一次模板表
                        v = "{}" if k.endswith(("map", "json")) else "[]"
                    sets.append("%s=%%s" % k)
                    vals.append(v)
                    row[k] = v
                if sets:
                    vals.append(user_id)
                    cur.execute("UPDATE users SET " + ", ".join(sets) + " WHERE id=%s", vals)
        conn.commit()
    except Exception as e:
        logger.warning("[db] 初始化用户机械臂配置失败(user_id=%s): %s", user_id, e)
        try:
            conn.rollback()
        except Exception:
            pass
        return {}
    finally:
        conn.close()

    out = {"advanced_mode": bool(row.get("advanced_mode") or 0)}
    for k in USER_ARM_CONFIG_KEYS:
        raw = row.get(k)
        if raw is None:
            out[k] = _USER_ARM_FALLBACK.get(k)
        elif isinstance(raw, (dict, list)):
            out[k] = raw
        else:
            try:
                out[k] = json.loads(raw)
            except Exception:
                out[k] = _USER_ARM_FALLBACK.get(k)
    return out


def get_user_model_cfg(user_id, model_file=None):
    """按**当前模型**解析用户的机械臂配置（已选类别 / 类别→动作组 / 类别→放置位）。

    解析口径与 /api/arm/config、/api/arm/class-group-map、
    sorter.load_class_area_map 完全一致（保证"界面显示与执行端读同一份"）：
        users.<key>_by_model[model_file]  →  该键缺失(None)才回落 users.<key>（全局"当前"份）

    为什么必须有这个函数：
    - `/api/models/switch` 切模型时会把全局"当前"份清空（旧模型的类别名对新模型无效），
      按模型那一份则永久保留 —— 切回来能自动恢复；
    - `ensure_user_arm_config()` 的白名单 USER_ARM_CONFIG_KEYS **不含** `*_by_model`
      这些列，用 `ucfg.get('selected_classes')` 读到的只是全局份，切模型后恒为空，
      导致"界面显示有映射、执行端读不到"（2026-10-21 实测：自动分拣每次触发都被
      "不在已选类别中，已忽略"拒掉，界面看似正常却毫无反应）。

    ⚠ 用户主动清空（[]/{}）与从未配置(None)是两回事：**只有 None 才回落全局**，
      主动清空必须保持为空（清空已选类别 = 什么都不分拣）。
    """
    if model_file is None:
        try:
            from detector import detector as _det
            model_file = (_det.current_file or "").strip()
        except Exception:
            model_file = ""
    out = {"selected_classes": [], "class_group_map": {}, "class_area_map": {}}
    if not user_id:
        return out
    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT selected_classes, class_group_map, normal_class_map,"
                " selected_cls_by_model, group_map_by_model, class_map_by_model"
                " FROM users WHERE id=%s",
                (user_id,)
            )
            row = cur.fetchone() or {}
    finally:
        conn.close()

    def _load(v, empty):
        """JSON 列 -> Python 对象；None/解析失败/类型不符都按空值处理。"""
        if isinstance(v, type(empty)):
            return v
        if isinstance(v, str) and v:
            try:
                r = json.loads(v)
                return r if isinstance(r, type(empty)) else empty
            except Exception:
                return empty
        return empty

    g_sel = _load(row.get("selected_classes"), [])
    g_gmap = _load(row.get("class_group_map"), {})
    g_cmap = _load(row.get("normal_class_map"), {})
    if model_file:
        by_sel = _load(row.get("selected_cls_by_model"), {})
        by_gmap = _load(row.get("group_map_by_model"), {})
        by_cmap = _load(row.get("class_map_by_model"), {})
        out["selected_classes"] = (by_sel.get(model_file)
                                   if by_sel.get(model_file) is not None else g_sel)
        out["class_group_map"] = (by_gmap.get(model_file)
                                  if by_gmap.get(model_file) is not None else g_gmap)
        out["class_area_map"] = (by_cmap.get(model_file)
                                 if by_cmap.get(model_file) is not None else g_cmap)
    else:
        out["selected_classes"] = g_sel
        out["class_group_map"] = g_gmap
        out["class_area_map"] = g_cmap
    return out


def get_arm_move_speed(user_id=None):
    """读取「动作速度档位」（slow / normal / fast）——**按用户隔离**。

    该档位决定动作组/自动分拣每步「按位移计算时长」所用的速度系数
    （见 config.MOVE_SPEED_PROFILES）。

    优先级：当前用户的 users.arm_move_speed → 全局 arm_config.move_speed →
    config.MOVE_SPEED_DEFAULT。任一步读取失败就往下回落，保证动作仍能执行。

    ⚠ 注意：不要把本列加进 USER_ARM_CONFIG_KEYS —— 那是给 JSON 列用的，
       ensure_user_arm_config() 会对其做 json.loads()，字符串 'slow' 解析失败会
       静默回落成默认值，导致"改了存不上"（2026-10-15 实测踩坑）。
    """
    if user_id:
        try:
            conn = get_db()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT arm_move_speed FROM users WHERE id=%s", (user_id,))
                    r = cur.fetchone()
            finally:
                conn.close()
            v = (r or {}).get('arm_move_speed')
            if v:
                return v
        except Exception as e:
            logger.debug("[db] 读取用户速度档位失败(user_id=%s): %s", user_id, e)
    try:
        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT move_speed FROM arm_config WHERE id=1")
                row = cur.fetchone()
            return (row or {}).get('move_speed') or 'normal'
        finally:
            conn.close()
    except Exception as e:
        logger.debug("[db] 读取动作速度档位失败，回落默认值: %s", e)
        return 'normal'


def gen_user_code(cur=None):
    """生成不重复、首位非 0 的 8 位数字用户编号（与 _migrate 回填口径一致）。

    cur 传入时复用当前游标（迁移同一条连接，避免 N+1 连接）；
    否则自开连接。调用方负责 commit。users.user_code 为 UNIQUE，
    极端并发下若仍冲突，UNIQUE 约束会在 commit 时报错，由上层重试。
    """
    own_conn = None
    if cur is None:
        own_conn = get_db()
        cur = own_conn.cursor()
    try:
        while True:
            code = ''.join(random.choices(string.digits, k=8))
            if code[0] == '0':
                code = str(random.randint(1, 9)) + code[1:]
            cur.execute("SELECT id FROM users WHERE user_code=%s", (code,))
            if not cur.fetchone():
                return code
    finally:
        if own_conn is not None:
            own_conn.close()


def init_db():
    """创建数据库（如不存在）并建表。"""
    # 先不指定库连接，确保数据库存在
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` "
                f"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
        conn.commit()
    finally:
        conn.close()

    conn = _conn(DB_NAME)
    try:
        with conn.cursor() as cur:
            # 用户表
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    username VARCHAR(64) NOT NULL UNIQUE,
                    password_hash VARCHAR(255) NOT NULL,
                    role VARCHAR(16) NOT NULL DEFAULT 'user',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            # 检测记录表
            cur.execute("""
                CREATE TABLE IF NOT EXISTS detection_records (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    username VARCHAR(64) NOT NULL,
                    image_name VARCHAR(255) DEFAULT '',
                    image_url VARCHAR(512) DEFAULT '',
                    result_url VARCHAR(512) DEFAULT '',
                    source_url VARCHAR(512) DEFAULT '',
                    media_type VARCHAR(16) DEFAULT 'image',
                    conclusion VARCHAR(255) DEFAULT '',
                    stats_json TEXT,
                    boxes_json TEXT,
                    model_name VARCHAR(128) DEFAULT '',
                    duration_ms INT DEFAULT 0,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_user (user_id),
                    INDEX idx_time (created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            # 模型表
            cur.execute("""
                CREATE TABLE IF NOT EXISTS models (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(128) NOT NULL,
                    file_name VARCHAR(255) NOT NULL UNIQUE,
                    description VARCHAR(255) DEFAULT '',
                    -- tags 早期只有 255 字，但系统会把「类别名逗号串」回填进来：
                    -- 常规 COCO 模型 80 类就有 620 字，会直接触发 1406 Data too long，
                    -- 导致 tags/params/classes 三项一起写库失败。故改为 TEXT。
                    tags TEXT,
                    map_val VARCHAR(16) DEFAULT '',
                    params VARCHAR(32) DEFAULT '',
                    size_bytes BIGINT DEFAULT 0,
                    status VARCHAR(16) DEFAULT 'ready',
                    note TEXT,
                    is_current TINYINT DEFAULT 0,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            # 安全文章表（预留，前端宣教页后续可接）
            cur.execute("""
                CREATE TABLE IF NOT EXISTS articles (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    title VARCHAR(255) NOT NULL,
                    summary VARCHAR(512) DEFAULT '',
                    content TEXT,
                    category VARCHAR(64) DEFAULT '',
                    cover_url VARCHAR(512) DEFAULT '',
                    status VARCHAR(16) DEFAULT 'published',
                    author VARCHAR(64) DEFAULT '',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            # 模型训练任务表
            cur.execute("""
                CREATE TABLE IF NOT EXISTS training_jobs (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    job_name VARCHAR(128) NOT NULL UNIQUE,
                    dataset_name VARCHAR(128) DEFAULT '',
                    backbone_file VARCHAR(255) DEFAULT '',
                    epochs INT DEFAULT 100,
                    batch VARCHAR(16) DEFAULT '16',
                    imgsz INT DEFAULT 640,
                    optimizer VARCHAR(32) DEFAULT 'auto',
                    lr0 DECIMAL(8,5) DEFAULT NULL,
                    mosaic DECIMAL(4,2) DEFAULT NULL,
                    degrees DECIMAL(4,2) DEFAULT NULL,
                    mixup DECIMAL(4,2) DEFAULT NULL,
                    patience INT DEFAULT 50,
                    device VARCHAR(16) DEFAULT 'auto',
                    status VARCHAR(16) DEFAULT 'running',
                    progress_epoch INT DEFAULT 0,
                    total_epochs INT DEFAULT 0,
                    best_map50 DECIMAL(8,4) DEFAULT NULL,
                    final_loss DECIMAL(12,4) DEFAULT NULL,
                    elapsed_sec INT DEFAULT 0,
                    model_id INT DEFAULT NULL,
                    model_file VARCHAR(255) DEFAULT '',
                    report_path VARCHAR(512) DEFAULT '',
                    log_tail TEXT,
                    note VARCHAR(255) DEFAULT '',
                    created_by VARCHAR(64) DEFAULT '',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    started_at DATETIME NULL,
                    finished_at DATETIME NULL,
                    INDEX idx_status (status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            # 机械臂配置表（单条记录，存标定姿态等）
            cur.execute("""
                CREATE TABLE IF NOT EXISTS arm_config (
                    id INT PRIMARY KEY,
                    serial_port VARCHAR(16) DEFAULT '',
                    baudrate INT DEFAULT 115200,
                    pump_suck_pwm INT DEFAULT 2400,
                    pump_release_pwm INT DEFAULT 1200,
                    poses_json JSON DEFAULT NULL,
                    class_area_map JSON DEFAULT NULL,
                    areas JSON DEFAULT NULL,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            # 兼容旧表：添加 areas 字段
            try:
                cur.execute("ALTER TABLE arm_config ADD COLUMN areas JSON DEFAULT NULL")
            except Exception as e:
                logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
            # 兼容旧表：添加 selected_classes 字段（用户选中用于分拣的类别，最多4个）
            try:
                cur.execute("ALTER TABLE arm_config ADD COLUMN selected_classes JSON DEFAULT NULL")
            except Exception as e:
                logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
            # 兼容旧表：添加 via_home 字段（去姿态行程是否经原点过渡，1=经原点 0=直达）
            try:
                cur.execute("ALTER TABLE arm_config ADD COLUMN via_home TINYINT(1) NOT NULL DEFAULT 1")
            except Exception as e:
                logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
            # 动作组每步移动时长的速度档位（slow/normal/fast），决定"按位移算时长"的系数
            try:
                cur.execute("ALTER TABLE arm_config ADD COLUMN move_speed VARCHAR(16) NOT NULL DEFAULT 'normal'")
            except Exception as e:
                logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
            # 初始化默认配置（单条记录 id=1）
            cur.execute("SELECT id FROM arm_config WHERE id=1")
            if not cur.fetchone():
                default_areas = json.dumps([
                    {"key": "place_1", "label": "放置位1"},
                    {"key": "place_2", "label": "放置位2"},
                    {"key": "place_3", "label": "放置位3"},
                ])
                cur.execute(
                    "INSERT INTO arm_config (id, class_area_map, areas) VALUES (1, %s, %s)",
                    ('{}', default_areas)
                )

            # 分拣记录表
            cur.execute("""
                CREATE TABLE IF NOT EXISTS sort_records (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    username VARCHAR(64) NOT NULL,
                    defect_class VARCHAR(32) DEFAULT '',
                    confidence FLOAT DEFAULT 0,
                    place_area VARCHAR(16) DEFAULT '',
                    pick_success TINYINT DEFAULT 1,
                    duration_ms INT DEFAULT 0,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_user (user_id),
                    INDEX idx_time (created_at),
                    INDEX idx_class (defect_class)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            # 兼容旧表：sort_records 添加 model_name 字段
            try:
                cur.execute("ALTER TABLE sort_records ADD COLUMN model_name VARCHAR(128) DEFAULT ''")
            except Exception as e:
                logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        conn.commit()
    finally:
        conn.close()

    _migrate()


def _migrate():
    """轻量列迁移：老库缺的列这里补。"""
    conn = _conn(DB_NAME)
    try:
      with conn.cursor() as cur:
        # ---- 表注释：标明每张表用途（幂等，每次启动同步一遍，改注释只改这里） ----
        _TABLE_COMMENTS = {
            'users':             '用户账号表；并存放按用户隔离的机械臂策略配置（模式开关/行程偏好/类别映射/选中类别/标定等）',
            'detection_records': '检测记录：图片/视频推理结果与产物路径',
            'models':            '模型库元信息（models_lib 内可用权重）；is_current=1 为当前推理模型；classes 为类别名 JSON 数组',
            'articles':          '知识文章（原“安全宣教”，页面文案已去安全帽化）',
            'training_jobs':     '训练任务记录（状态/进度/产物）',
            'arm_config':        '机械臂全局单行配置：串口、气泵 PWM、超时保护；另作新用户放置位列表与标定的默认模板',
            'sort_records':      '自动分拣记录（按模型+日期；含触发用户名与放置位）',
            'waypoints':         '动作组编辑器的途经点卡片（5 路 PWM），按用户隔离',
            'action_groups':     '自定义动作组（流程图节点+连线 graph_json），按用户隔离；高级模式下按类别映射触发执行',
            'feedbacks':         '用户反馈主表（类型/状态/回复）',
            'feedback_messages': '反馈的往来消息（用户与管理员的对话记录）',
            'ext_module_access': '拓展模块访问授权（哪个用户被授予哪个模块，如 industrial 工控页）',
        }
        for _t, _c in _TABLE_COMMENTS.items():
            try:
                cur.execute("ALTER TABLE `%s` COMMENT='%s'" % (_t, _c))
            except Exception as e:
                logger.debug("表注释同步失败 %s: %s", _t, e)

        # users 表历史新增列
        try:
            cur.execute("ALTER TABLE users ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'user'")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        try:
            cur.execute("ALTER TABLE users ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'active'")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        try:
            cur.execute("ALTER TABLE users ADD COLUMN session_version INT NOT NULL DEFAULT 0")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        try:
            cur.execute("ALTER TABLE users ADD COLUMN last_seen DATETIME NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        # 机械臂去姿态行程偏好（按用户区分：1=经原点过渡 0=直达）
        # 独立 try 块：避免与上一段共用 try 时被已有列的失败连带跳过
        try:
            cur.execute("ALTER TABLE users ADD COLUMN arm_via_home TINYINT(1) NOT NULL DEFAULT 1")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)

        # ---- 自定义动作组（高级行程模式）· 按用户隔离的配置列 ----
        # 机械臂是公共设施，同一时刻只进一人，故每人一套（气泵 PWM 保持全局，不在此列）
        try:
            cur.execute("ALTER TABLE users ADD COLUMN advanced_mode TINYINT(1) NOT NULL DEFAULT 0")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        try:
            cur.execute("ALTER TABLE users ADD COLUMN areas JSON DEFAULT NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        try:
            cur.execute("ALTER TABLE users ADD COLUMN normal_class_map JSON DEFAULT NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        try:
            cur.execute("ALTER TABLE users ADD COLUMN selected_classes JSON DEFAULT NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        # 按模型分组的映射（普通模式：类别→放置位）
        # 结构 {"模型文件名": {"类别": "放置位key"}}
        try:
            cur.execute("ALTER TABLE users ADD COLUMN class_map_by_model JSON DEFAULT NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        # 按模型分组的映射（高级模式：类别→动作组 id）
        # 结构 {"模型文件名": {"类别": 动作组id}}
        try:
            cur.execute("ALTER TABLE users ADD COLUMN group_map_by_model JSON DEFAULT NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        # 按模型分组的「已选类别」：换模型回来自动恢复上次选的类别
        # 结构 {"模型文件名": ["bottle", "person"]}
        try:
            cur.execute("ALTER TABLE users ADD COLUMN selected_cls_by_model JSON DEFAULT NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        try:
            cur.execute("ALTER TABLE users ADD COLUMN normal_poses_json JSON DEFAULT NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        # 按模型分组的「类别触发规则」：控制识别到哪些类别才动作、怎么挑、多久动一次
        # 结构 {"模型文件名": {"类别": {priority, min_count, conf, cooldown, action}}}
        # action: sort=走映射分拣 / alarm=仅报警不动作
        # priority 允许重复（高级规则中同级别按置信度决胜）
        try:
            cur.execute("ALTER TABLE users ADD COLUMN class_trigger_by_model JSON DEFAULT NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        # 触发规则模式（按模型分组）：basic=普通规则（选中类别中取置信度最高，
        # 并列依次比目标数量、随机） / advanced=高级规则（四道检查 + 优先级分组）
        try:
            cur.execute("ALTER TABLE users ADD COLUMN trigger_mode_by_model JSON DEFAULT NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        # 触发仲裁窗（按模型分组）：{frames: N} 首个合格类别出现后等待 N 帧再放行，
        # 期间更高优先级/更高置信度的后到类别可反超（0=关闭，单帧决胜）
        try:
            cur.execute("ALTER TABLE users ADD COLUMN trigger_arb_by_model JSON DEFAULT NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        try:
            cur.execute("ALTER TABLE users ADD COLUMN advanced_poses_json JSON DEFAULT NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        try:
            cur.execute("ALTER TABLE users ADD COLUMN class_group_map JSON DEFAULT NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        try:
            cur.execute("ALTER TABLE users ADD COLUMN arm_move_speed VARCHAR(16) NOT NULL DEFAULT 'normal'")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)

        # 模型类别名（JSON 数组）：入库后无需加载模型即可拿到类别名
        try:
            cur.execute("ALTER TABLE models ADD COLUMN classes JSON DEFAULT NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)

        # models.tags 扩容：旧库是 VARCHAR(255)，装不下 80 类模型的类别名逗号串
        # （yolo26m.pt 实测 620 字），写库会报 1406 Data too long → 元信息永远填不上。
        # 只在确认仍是定长字符类型时才 ALTER，避免每次启动都重建一次表。
        try:
            cur.execute(
                "SELECT DATA_TYPE FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA=%s AND TABLE_NAME='models' AND COLUMN_NAME='tags'",
                (DB_NAME,),
            )
            _tag_col = cur.fetchone()
            _tag_type = str((_tag_col or {}).get("DATA_TYPE", "")).lower()
            if _tag_type in ("varchar", "char"):
                cur.execute("ALTER TABLE models MODIFY COLUMN tags TEXT")
                logger.info("[db] models.tags 已从 %s 扩容为 TEXT（类别名可超 255 字）",
                            _tag_type.upper())
        except Exception as e:
            logger.warning("[db] models.tags 扩容失败（元信息可能仍写不进去）: %s", e)

        # ---- 自定义动作组相关新表 ----
        try:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS waypoints (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    name VARCHAR(64) NOT NULL,
                    pwm_json JSON NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_user (user_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
        except Exception as e:
            logger.warning("[db] 创建 waypoints 表失败: %s", e)
        try:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS action_groups (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    name VARCHAR(64) NOT NULL,
                    remark VARCHAR(255) DEFAULT '',
                    graph_json JSON NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_user (user_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
        except Exception as e:
            logger.warning("[db] 创建 action_groups 表失败: %s", e)
        # 用户可见的 8 位编号
        try:
            cur.execute("ALTER TABLE users ADD COLUMN user_code VARCHAR(8) NULL UNIQUE")
            cur.execute("ALTER TABLE users ADD COLUMN phone VARCHAR(11) NULL UNIQUE")
            cur.execute("ALTER TABLE users ADD COLUMN bark_key VARCHAR(128) NULL")
            # 反馈表
            cur.execute("""
                CREATE TABLE IF NOT EXISTS feedbacks (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    username VARCHAR(64) NOT NULL,
                    category VARCHAR(20) NOT NULL DEFAULT 'usage',
                    title VARCHAR(200) NOT NULL,
                    content TEXT,
                    images TEXT,
                    status VARCHAR(16) NOT NULL DEFAULT 'pending',
                    reply TEXT,
                    replied_by VARCHAR(64),
                    replied_at DATETIME NULL,
                    notify_admin TINYINT DEFAULT 0,
                    notify_user TINYINT DEFAULT 0,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_user (user_id),
                    INDEX idx_status (status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS feedback_messages (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    feedback_id INT NOT NULL,
                    sender VARCHAR(10) NOT NULL DEFAULT 'user',
                    sender_id INT NULL,
                    content TEXT,
                    images TEXT,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_fb (feedback_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS ext_module_access (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    module_name VARCHAR(50) NOT NULL,
                    user_id INT NOT NULL,
                    granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY uk_module_user (module_name, user_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        # 文章表 updated_at
        try:
            cur.execute("ALTER TABLE articles ADD COLUMN updated_at DATETIME NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        # 检测记录：视频原始上传文件路径（删除记录时连带清理，避免文件残留）
        try:
            cur.execute(
                "ALTER TABLE detection_records ADD COLUMN source_url VARCHAR(512) DEFAULT ''"
            )
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        # 检测记录：视频逐帧框时间轴 URL（前端在原始视频上画框用；图片记录为空）
        try:
            cur.execute(
                "ALTER TABLE detection_records ADD COLUMN boxes_url VARCHAR(512) DEFAULT ''"
            )
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        # 检测记录：类别数 / 目标数冗余列（历史列表排序用）
        # 原来只能按 id 倒序排；要按「类别数 / 目标数」排就得在 ORDER BY 里解析 stats_json，
        # 每条记录都要 JSON 解析一遍，几万条直接拖死列表。这里落成实列，写入时顺手填，
        # 排序和分页都走普通列比较。
        for _col in ("cls_count", "obj_count"):
            try:
                cur.execute(
                    "ALTER TABLE detection_records ADD COLUMN %s INT NOT NULL DEFAULT 0" % _col
                )
            except Exception as e:
                logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        # 老数据回填：只处理「两列还都是 0 且 stats_json 非空非空对象」的行。
        # 每次启动最多扫 2000 行，分多次启动补齐，避免升级后首启卡在回填上。
        try:
            cur.execute(
                "SELECT id, stats_json FROM detection_records "
                "WHERE cls_count=0 AND obj_count=0 "
                "AND stats_json IS NOT NULL AND stats_json NOT IN ('', '{}') LIMIT 2000"
            )
            _backfill = cur.fetchall()
            if _backfill:
                logger.info("[migrate] 回填检测记录排序计数 %d 行", len(_backfill))
            for row in _backfill:
                try:
                    st = json.loads(row["stats_json"] or "{}")
                    if not isinstance(st, dict):
                        st = {}
                except Exception:
                    st = {}
                try:
                    obj_n = sum(int(v) for v in st.values())
                except Exception:
                    obj_n = 0
                cur.execute(
                    "UPDATE detection_records SET cls_count=%s, obj_count=%s WHERE id=%s",
                    (len(st), obj_n, row["id"]),
                )
        except Exception as e:
            logger.debug("迁移兼容（回填排序计数失败）: %s", e)
        try:
            cur.execute("UPDATE articles SET updated_at=created_at WHERE updated_at IS NULL")
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
        # 给已有用户补 user_code（老库升级路径；全新库由 init_admin 直接预置）
        cur.execute("SELECT id FROM users WHERE user_code IS NULL")
        for row in cur.fetchall():
            code = gen_user_code(cur)
            cur.execute("UPDATE users SET user_code=%s WHERE id=%s", (code, row["id"]))
        # 训练任务：进程重启后，残留 running 标记为 interrupted
        try:
            cur.execute(
                "UPDATE training_jobs SET status='interrupted', finished_at=NOW() "
                "WHERE status='running'"
            )
        except Exception as e:
            logger.debug("迁移兼容（列/表已存在或旧库不支持）: %s", e)
      conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    init_db()
    logger.info("数据库初始化完成")
