FROM python:3.11-slim

# Tesseract OCR + Nederlandse taaldata
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-nld \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies installeren
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App kopiëren
COPY server.py .
COPY tankprijs-app/ ./tankprijs-app/

# Railway stelt PORT automatisch in
EXPOSE 8080

CMD sh -c "gunicorn --bind 0.0.0.0:${PORT:-8080} --workers 2 --timeout 30 server:app"
