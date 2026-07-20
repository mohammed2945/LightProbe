FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY common /app/common
COPY liveprobe /app/liveprobe

EXPOSE 8000

CMD ["uvicorn", "liveprobe.daemon:app", "--host", "0.0.0.0", "--port", "8000"]
