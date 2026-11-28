# billar-pos-updater: the bar PC's nightly updater (python -m updater daemon).
# It drives Docker on the host through the mounted socket, so it carries the
# docker CLI and the compose v2 plugin, both pinned and checksum-verified.
# The same image also runs the short-lived self-update helper
# (`docker run --entrypoint docker ...`, see updater/run.py self_update).
#
# Bump on purpose: change a version AND its two sha256 values together.
#   docker CLI 28.5.2 (static build from download.docker.com; Docker publishes
#     no checksum file for 28.x, so these were computed on 2026-11-27)
#   compose 2.40.3 (sha256 = the .sha256 files published with the release)
FROM python:3.11-slim

ARG TARGETARCH
ENV DOCKER_VERSION=28.5.2 \
    COMPOSE_VERSION=2.40.3 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY fetch_binary.py /tmp/fetch_binary.py
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x86_64; \
             docker_sha=ea90cfd12e1eeb12aa1c971741adb8bd4ed88e2a574eaac13f5029a1dbc6300d; \
             compose_sha=dba9d98e1ba5bfe11d88c99b9bd32fc4a0624a30fafe68eea34d61a3e42fd372 ;; \
      arm64) arch=aarch64; \
             docker_sha=9e4f82996ab790724094475ebed33a736434bfe5d45231b676fef22ffb80044d; \
             compose_sha=d26373b19e89160546d15407516cc59f453030d9bc5b43ba7faf16f7b4980137 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    python /tmp/fetch_binary.py \
      "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_VERSION}.tgz" \
      "$docker_sha" /tmp/docker.tgz; \
    tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 docker/docker; \
    mkdir -p /usr/local/lib/docker/cli-plugins; \
    python /tmp/fetch_binary.py \
      "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${arch}" \
      "$compose_sha" /usr/local/lib/docker/cli-plugins/docker-compose; \
    chmod 0755 /usr/local/bin/docker /usr/local/lib/docker/cli-plugins/docker-compose; \
    rm -f /tmp/docker.tgz /tmp/fetch_binary.py; \
    docker --version; \
    docker compose version

WORKDIR /app
COPY updater/ /app/updater/

CMD ["python", "-m", "updater", "daemon"]
