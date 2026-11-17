# 基于 YOLO 的智能检测平台 · 业务源码

> 本仓库只纳管**业务源码**。打包构建脚本、便携运行环境、安装包（`YOLO-Detection-Setup.exe`）与项目文档位于上层项目目录，不在本仓库内。

## 产品定位

支持自定义训练多类型目标检测模型、动态切换模型权重，对任意目标进行识别推理；在 YOLO 基础推理能力之上可扩展各类业务功能，适用于**企业项目、教学实训与学科竞赛**。安全帽检测只是其中一个比赛项目分支，平台本身不绑定任何具体被检测物体。

## 目录结构

| 路径 | 说明 |
|---|---|
| `index.html` / `css/` / `js/` / `assets/` | 前端页面（含 ECharts 离线库与演示图） |
| `backend/app.py` | Flask 后端主程序与全部 API 路由 |
| `backend/db.py` | MySQL 建表、迁移与连接管理 |
| `backend/detector.py` | YOLO 推理封装（图片 / 视频 / 实时流） |
| `backend/trainer.py` | 自定义训练流程 |
| `backend/config.py` | 数据库连接、目录、端口、管理员配置 |
| `backend/action_group.py` / `arm_controller.py` / `sorter.py` | 业务扩展模块 |
| `backend/db_export.py` / `db_reset.py` | 运维用导入导出脚本 |
| `launcher.py` / `启动后端.bat` | 开发环境启动入口 |
| `requirements.txt` | Python 依赖清单 |

## 本地开发环境

- **Python 3.12 + conda 虚拟环境**（项目约定不使用系统 Python），`pip install -r requirements.txt`
- GPU 版 `torch` 需按本机 CUDA 版本单独从 PyTorch 源安装，详见 `requirements.txt` 注释
- **MySQL 8.x**：库名 `helmet_console`，开发环境默认连接本机 `3306`（`root/root`）
- 双击 `启动后端.bat` 启动；后端默认监听 `5000`

> ⚠ `启动后端.bat` 与 `launcher.py` 中写有开发机的 conda 解释器绝对路径。clone 到新机器后，请把它们改成你本机虚拟环境的 `python.exe` 路径；`requirements.txt` 与代码注释里若出现本机路径，同理按实际情况调整。

## 模型权重不入库

`pretrained_models/`（官方预训练权重）与 `models_lib/`（用户自训权重）合计约 650 MB，其中两个权重超过 GitHub **100 MB 单文件硬上限**，因此已在 `.gitignore` 中排除。

请自行下载官方 YOLO 权重或备份自训权重，并保持两个目录**语义分离、不做去重**：前者是训练新模型的起跑点，后者是已训练产物，不可互换。

## 安全提示

- `backend/config.py` 的 `ADMIN_PHONE` 与初始密码 `admin` 是**产品出厂默认管理员凭据**，随客户安装包一同分发。部署后请**立即在网页修改管理员密码与手机号**。
- Flask 会话签名密钥 `backend/.secret_key` 由程序首次启动自动生成，已排除入库。数据库凭据、上传文件、日志、训练产物同样不入库。
- 本系统「密码登录」按手机号查账号（不按用户名），修改默认手机号后请用新号码登录。

## 打包与发布

便携安装包由上层 `build/build_portable.py` 生成：Cython `.pyd` 后端代码保护、前端 JS/CSS/HTML 混淆压缩、随包便携 MySQL（独立端口 3307，不碰系统 3306）、Inno Setup 安装向导与增量升级。相关流程见项目文档《开发者手册》。
