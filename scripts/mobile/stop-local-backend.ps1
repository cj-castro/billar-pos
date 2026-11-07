# Stops (keeps containers and data volume) the isolated billarmobile project. Idempotent.
docker compose -p billarmobile -f "$PSScriptRoot\..\..\docker-compose.yml" stop postgres backend frontend
