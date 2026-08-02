FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc curl && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

COPY --chmod=755 entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Run as non-root for container security
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser \
    && chown -R appuser:appgroup /app
USER appuser

EXPOSE 5000

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -s http://localhost:5000/api/v1/auth/me \
      | grep -q "msg" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
