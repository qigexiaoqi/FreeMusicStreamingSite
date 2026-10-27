# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# FreeMusicStreamingSite · 免费音乐播放站
# 单阶段镜像：只依赖 Python 标准库，镜像小、构建快
#   docker build -t freemusicstreamingsite:latest .
#   docker run -d -p 7788:7788 -v freemusic-data:/app/data freemusicstreamingsite:latest
# ---------------------------------------------------------------------------
FROM python:3.12-slim

LABEL org.opencontainers.image.title="FreeMusicStreamingSite" \
      org.opencontainers.image.description="免费音乐播放站 · 本地部署的在线音乐播放站（搜索 / 歌词 / 下载 / 账号同步 / 管理后台）" \
      org.opencontainers.image.source="https://github.com/qigexiaoqi/Free-MusicStreamingSite" \
      org.opencontainers.image.url="https://github.com/qigexiaoqi/Free-MusicStreamingSite" \
      org.opencontainers.image.licenses="MIT"

# 容器内必须监听 0.0.0.0，且不能尝试拉起浏览器
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    XQ_HOST=0.0.0.0 \
    XQ_PORT=7788 \
    XQ_NO_BROWSER=1 \
    TZ=Asia/Shanghai

WORKDIR /app

COPY server.py ./
COPY public/ ./public/

# 非 root 运行；data 目录留给卷挂载
RUN useradd --create-home --uid 10001 appuser \
 && mkdir -p /app/data \
 && chown -R appuser:appuser /app

USER appuser

VOLUME ["/app/data"]
EXPOSE 7788

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:7788/health', timeout=2).status == 200 else 1)"

CMD ["python", "server.py"]
