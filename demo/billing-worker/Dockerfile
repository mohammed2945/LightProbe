FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SERVICE_ID=billing-worker \
    BROKER_URL=http://broker:7070 \
    BUG=on

WORKDIR /app

COPY python/sdk /tmp/liveprobe-sdk
COPY demo/billing-worker/requirements.txt /tmp/requirements.txt
RUN python -m pip install --no-cache-dir --disable-pip-version-check \
    -r /tmp/requirements.txt /tmp/liveprobe-sdk

COPY demo/billing-worker/app.py demo/billing-worker/traffic.py /app/

RUN addgroup --system liveprobe \
    && adduser --system --ingroup liveprobe liveprobe \
    && chown -R liveprobe:liveprobe /app
USER liveprobe

EXPOSE 8081
HEALTHCHECK --interval=5s --timeout=2s --start-period=5s --retries=5 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8081/health', timeout=1).read()"]

CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8081"]
