# -*- coding: utf-8 -*-
"""后端配置：MySQL 连接、目录路径、服务端口。
如需改 MySQL 密码，直接改下面的 DB_PASSWORD，或设置环境变量 HELMET_DB_PASSWORD。
"""
import os
import secrets

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(BASE_DIR)

# ---------- MySQL ----------
DB_CONFIG = {
    "host": os.environ.get("HELMET_DB_HOST", "127.0.0.1"),
    "port": int(os.environ.get("HELMET_DB_PORT", "3306")),
    "user": os.environ.get("HELMET_DB_USER", "root"),
    "password": os.environ.get("HELMET_DB_PASSWORD", "root"),
    "charset": "utf8mb4",
}
DB_NAME = "helmet_console"

# ---------- 管理员手机号 ----------
# 默认管理员（admin/admin）的手机号，用于验证码登录 / 找回密码。
# 优先级：环境变量 HELMET_ADMIN_PHONE > 本默认值。
# 打包侧由 launcher 把 config.env 的 ADMIN_PHONE 经 HELMET_ADMIN_PHONE 注入，
# 使后端取值与 config.env 一致；开发环境无 config.env，直接用本默认值。
ADMIN_PHONE = os.environ.get("HELMET_ADMIN_PHONE", "18313133034")

# ---------- Flask ----------
def _load_secret_key():
    """加载 session 签名密钥。

    优先级：环境变量 HELMET_SECRET > backend/.secret_key 文件 > 临时随机值。
    密钥文件在首次启动时自动生成并持久化，避免每次重启都让已登录用户掉线；
    生产环境请显式设置 HELMET_SECRET。
    """
    env = os.environ.get("HELMET_SECRET")
    if env:
        return env
    path = os.path.join(BASE_DIR, ".secret_key")
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                v = f.read().strip()
            if v:
                return v
        v = secrets.token_hex(24)
        with open(path, "w", encoding="utf-8") as f:
            f.write(v)
        return v
    except OSError:
        # 无法落盘时退化为进程内随机值（重启后会话失效，但不会中断启动）
        return secrets.token_hex(24)


SECRET_KEY = _load_secret_key()
HOST = "0.0.0.0"
PORT = int(os.environ.get("HELMET_PORT", "5000"))

# ---------- 数据库连接池 ----------
# 复用 MySQL 连接，避免每请求新建连接带来的握手开销与连接数飙升。
DB_POOL_SIZE = 8

# ---------- 目录 ----------
# 模型加载目录（用户指定）
MODELS_DIR = os.path.join(PROJECT_DIR, "models_lib")
# 上传与结果
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
UPLOAD_IMAGES = os.path.join(UPLOAD_DIR, "images")
UPLOAD_VIDEOS = os.path.join(UPLOAD_DIR, "videos")
# 框数据（图片 boxes / 视频逐帧时间轴）——落盘策略改为「只存原文件 + 框数据」后，
# 原来的 results/images 与 results/videos 两个子目录已合并成一个 boxes/（磁盘上不再有带框文件）
UPLOAD_BOXES = os.path.join(UPLOAD_DIR, "boxes")
# 下载标注文件时现场合成的临时产物（合成完浏览器直接流式下载，随后自动清理）
UPLOAD_TMP = os.path.join(UPLOAD_DIR, "tmp")

# 允许的上传类型
ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
ALLOWED_VIDEO_EXT = {".mp4", ".avi", ".mov", ".mkv"}

# ---------- 模型训练 ----------
# 官方预训练权重（训练起点）
PRETRAINED_DIR = os.path.join(PROJECT_DIR, "pretrained_models")
# 数据集根目录（每个子文件夹是一个数据集）
DATASETS_DIR = os.path.join(PROJECT_DIR, "datasets")
# 训练任务输出根目录（每个任务一个子文件夹）
RUNS_DIR = os.path.join(PROJECT_DIR, "runs")
# HTML 训练报告目录
REPORTS_DIR = os.path.join(PROJECT_DIR, "reports")

# 推理默认置信度阈值
DEFAULT_CONF = 0.5

# 同时驻留在内存/显存中的模型数量上限（超出时自动释放最久未用的那个）。
# 当前使用的模型不会被释放。笔记本级显卡（如 8GB 显存）建议保持较小值。
MAX_LOADED_MODELS = 3

# 模型加载超时（秒）：超过则放弃等待并向上抛错，避免请求线程被权重加载无限期
# 阻塞（如 CUDA 繁忙 / OOM / 权重文件异常）。与前端“切换模型”遮罩 600s 档对齐。
MODEL_LOAD_TIMEOUT_SEC = 600
# 批量读元信息（刷新元信息 / 列表懒回填）时，加载下一个模型前要求的最小剩余显存(MB)。
# 8GB 显存建议 1500：够装一个中等 YOLO 模型（含 CUDA 工作区约 600MB~1GB）后再留 ≥500MB
# 给正在跑的推理；正常负载下仍允许刷新，只在显存真紧张时跳过该模型。
MIN_FREE_VRAM_MB = 1500
# 严格模式：批量读元信息时若有活跃推理则直接拒绝刷新。
# 默认 False（只提示 busy 不阻断）——管理员主动刷新属运维操作，有三道闸兜底即可。
META_REFRESH_STRICT = False
# 判定"有活跃推理"的时间窗（秒）：最近一次推理发生在此窗口内即视为活跃。
# 覆盖图片/视频/网络流全部检测类型（不再只看网络流槽位）；10 秒足够区分"正在跑"与"刚跑过"。
INFER_ACTIVE_WINDOW_SEC = 10

# ---------- 上传与长任务保护 ----------
# 单个请求体上限（MB）：视频直传 + 逐帧同步处理，过大会长时间占用请求线程。
# 设为 1GB 才能让 10 分钟 1080p 视频真正传上来；图片另有独立的 MAX_IMAGE_MB 限制。
MAX_UPLOAD_MB = 1024
# 单张图片独立上限（MB）：图片整张解码（解码后约为文件 10 倍），过大有 OOM 风险，
# 故不跟随视频的 1GB，单独收紧到 50MB（见检测页优化方案 P0-4）。
MAX_IMAGE_MB = 50
# 视频检测上限：超过则拒绝，避免请求线程被长视频长时间独占
MAX_VIDEO_FRAMES = 36000     # = 600s × 60fps，可让 25/30/60fps 都跑满 10 分钟
MAX_VIDEO_SECONDS = 600
# 处理前要求结果目录至少有这么多的剩余空间（MB）
MIN_FREE_DISK_MB = 1000
# 批量图片/视频的软上限（前端校验 + 后端兜底，仅防误操作用途，非安全边界）：
# 总量必须 ≥ 个数上限 × 单文件上限，否则后者会被架空（见检测页优化方案 3.2 / 3.5）
MAX_BATCH_IMAGE_FILES = 200
MAX_BATCH_VIDEO_FILES = 30
MAX_BATCH_IMAGE_TOTAL_MB = 10240    # = 200 张 × 50MB
MAX_BATCH_VIDEO_TOTAL_MB = 30720    # = 30 个 × 1024MB
# 视频推理临时降分辨率的上限宽度（px）：逐帧送模型前等比缩到该宽度，检测后再放大回原尺寸，
# 不影响输出分辨率与帧数，可显著降低推理耗时（P1-6，与网络流检测一致）。
INFER_MAX_WIDTH = 960

# ---- 视频输出框的「时间维度平滑 / 插帧」 ----
# 逐帧独立推理出来的框天然会抖（模型输出本身有抖动），抽帧(skip>1)时中间帧更是完全没有框，
# 观感上就是"框一跳一跳 / 断断续续"。这里对同一目标跨帧做指数平滑，并给未推理的中间帧
# 按速度外推补框，让输出视频里的框连续移动。
#   0   = 关闭（保持原始逐帧结果，中间帧不画框）
#   0~1 = 平滑系数：越小越平滑、越大越跟手（推荐 0.35~0.6）
INFER_BOX_SMOOTH = 0.5
# 同一目标跨帧匹配的最大中心位移（占帧宽的比例）
INFER_BOX_MATCH_RATIO = 0.15
# 连续多少次推理没匹配上就判定目标消失并移除
INFER_BOX_MISS_MAX = 2

# 同时进行的网络流检测路数上限（每路独占一个请求线程并持续推理）
MAX_CONCURRENT_STREAMS = 4
# 网络流存活但静默超过此时长（秒），看门狗强制回收其名额，避免 4 路槽位被卡死的
# 连接永久占满（阻塞的 C 层读无法被 kill，仅归还计数器，让新连接不被误拒）。
STREAM_REAP_SILENT_SEC = 600

# ---- 动作组：每步移动时长按位移智能计算（解决大幅移动顿挫 / 小幅移动浪费时间） ----
# 公式：时长 = 起步缓冲 + 最大位移(PWM) × 速度系数，再钳制到 [下限, 上限]。
# 说明：控制器严格按指令里的 T 参数执行（无自身加减速规划），因此时长必须给够，
#       否则表现为"没走完就被下一步打断"的顿挫。
# 起步缓冲：覆盖加减速的固定开销。
# 原为 400ms —— 它占比过大，导致小幅动作"慢悠悠"、大幅动作"嗖一下"，
# 同一档位下节奏明显不均（实测单位位移速度差近 5 倍）。砍半到 200ms，
# 线性系数同步上调（+0.2），使大幅动作时长保持不变、只加快小幅动作。
MOVE_BASE_MS = 200
MOVE_MIN_MS = 300           # 下限：低于此值物理上无法完成
# 上限：原为 3000，实测满行程的大幅移动 3 秒不够（表现为"没走完就被下一步打断"），
# 调到最慢档时会被这个上限截断、根本没变长。放宽到 6000。
# 注意：arm_controller.move_servos 内的 sleep 上限必须 >= 本值/1000，否则等待仍会被截断。
MOVE_MAX_MS = 6000
# 到位确认：按预设时长等完之后，再用 PRAD 回读校验是否真的到位，
# 没到位就继续等（最多再等 MOVE_SETTLE_TIMEOUT_SEC 秒）。
# 这是"算不准也能走完"的兜底 —— 回读不可用时会自动跳过，不会卡死。
# ⚠ 默认关闭：真机实测发现"带上气泵卡片后动作变慢、跑不完全程" ——
# 气泵开启时串口更忙，PRAD 回读容易失败/返回异常值，导致每步都要等满超时才放行。
# 保留代码（想启用时改为 True 即可），但在 PRAD 回读的可靠性被单独验证前不要开。
MOVE_WAIT_REACHED = False
MOVE_SETTLE_TIMEOUT_SEC = 3.0   # 额外补等上限（秒）
MOVE_SETTLE_TOL = 15            # 判定"已到位"的容差（PWM）
# 动作组相邻两步之间的小间隔（毫秒）：给串口/控制器消化上一条指令的时间。
# 真机实测：放气卡之后的那一步会被明显拖慢，加这个间隔可缓解；0 表示不加。
MOVE_STEP_GAP_MS = 300
# 吸气后的"保持时间"（毫秒）：pump_suck 内部已有 0.5s 等待负压建立，
# 这个是在此基础上**再多停一会儿**，让吸盘有足够时间把工件真正吸牢再移动，
# 否则会出现"还没吸住就被下一步带走"的吸取失败。0 表示不额外停留。
PUMP_SUCK_DWELL_MS = 650
# 三档速度（单位 ms / PWM，数值越大越慢）。
# ⚠ 系数已按新的起步缓冲(200ms)重新标定，使**大幅动作的时长与旧参数完全一致**，
#   只加快小幅动作 —— 不要单独改某一个值，否则节奏会重新变得不均匀。
# 注意 T 参数的物理含义：它是"用多久走完这段位移"。给得越长，舵机走得越慢、越"绵软"
# ——所以不能为了防不到位就一味加时间，要在"走得完"和"走得利索"之间找平衡。
# 有了关节权重（大臂 2.5）后不再需要靠高系数兜底，因此整体下调：
# 目标：标准档 ≈ 略慢于原来的固定 1200ms；快档明显快于原来。
# 回原点时是否"分两步"：先收回其他关节（缩小转动惯量），再单独转底座。
# 真机问题：机械臂在放置位是伸展状态，此时底座要带着整条伸出去的臂旋转，
# 负载最大 —— 实测会出现"其他关节都回到中位了，唯独底座转不动"。
# 先收臂再转底座可显著降低惯量。False 则恢复为一次性回原点。
# 2026-10-15 实测：分两步后**底座仍转不动** → 判定为硬件问题（非软件时序/惯量问题），
# 故恢复为一次性回原点。若将来换舵机/改善供电后可再试 True。
SORTER_SPLIT_BASE_RETURN = False

MOVE_SPEED_PROFILES = {
    'slow': 1.7,      # 慢：负载重 / 大幅抬升 / 追求平稳（保持不变）
    'normal': 0.75,   # 标准：默认 —— 真机实测这个速度就能走完整程，作为日常档
    'fast': 0.45,     # 快：追求节拍（原 0.38 与标准档区分不明显，再拉快一档；
                      #     更激进，若出现丢步/不到位请退回标准档）
}
# 各关节的"速度权重"（相对值，越大代表这个关节越慢）。
# 真机实测：底座旋转、下降这类动作跑得很快；**抬大臂/抬升非常慢**（要扛起小臂+腕+工件），
# 若所有关节用同一个系数，大臂就会时间不够、走不到位。
# 因此每一步的时长 = 起步缓冲 + max(各关节位移 × 系数 × 该关节权重)。
# 关节编号见 arm_controller：0=底座 1=大臂 2=小臂 3=腕部 4=腕部2
JOINT_SPEED_WEIGHTS = {
    # 0 底座：原为 1.0（按"旋转最快"设定），耐久测试发现约 10~20 次会出现一次
    #   "转不过来抖两下、然后立刻追下一个动作" —— 即堵转未到位就被下一条指令覆盖。
    #   底座要带动整条机械臂转动（惯量最大，且重心随姿态变化），实际比腕关节慢得多，
    #   故上调到 1.6 给它更充裕的时间。
    0: 1.6,
    1: 2.5,   # 大臂：负载最重（抬整条臂），明显更慢 —— 实测不到位的主因
    2: 1.8,   # 小臂
    3: 1.0,   # 腕部
    4: 1.0,   # 腕部2
}
MOVE_SPEED_DEFAULT = 'normal'
