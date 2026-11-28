# billar-pos-release: holds only the two files the bar's updater reads
# (updater/updater/ops.py pull_release copies /release.json and
# /docker-compose.bar.yml with `docker create` + `docker cp`).
# Render them first: python release/make_release.py --sha <commit>
# busybox only so that `docker run --rm <image>` can print release.json.
FROM busybox:1.37.0
COPY release.json docker-compose.bar.yml /
CMD ["cat", "/release.json"]
