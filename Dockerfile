FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    PORT=8080

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY common /app/common
COPY services /app/services
COPY world /app/world
COPY liveprobe /app/liveprobe
COPY ops /app/ops

EXPOSE 8080

CMD ["sh", "-c", "uvicorn ${MODULE}:app --host 0.0.0.0 --port ${PORT:-8080}"]
