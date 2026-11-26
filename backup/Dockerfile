# Nightly offsite backup sidecar. Same postgres major as the database so
# pg_dump is 15.x and its -Fc archives restore with Restore-Database.ps1.
# Pinned (15.17 / Alpine 3.23, which ships the aws-cli package); bump on purpose.
FROM postgres:15.17-alpine3.23

# aws-cli: upload to S3. tzdata: crond must fire at 02:00 America/Mexico_City.
RUN apk add --no-cache aws-cli tzdata \
 && mkdir -p /var/lib/backup

COPY backup.sh entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
