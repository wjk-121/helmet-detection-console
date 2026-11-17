@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 YOLO 检测平台（运行 launcher.py，使用 conda 环境 yolo26）...
"C:\Users\WJK-PC\anaconda3\envs\yolo26\python.exe" launcher.py
