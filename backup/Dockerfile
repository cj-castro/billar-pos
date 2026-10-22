# Nightly offsite backup sidecar. Based on the SAME image as the database so
# pg_dump is 15.x and its -Fc archives restore with Restore-Database.ps1.
FROM postgres:15-alpine

# aws-cli: upload to S3. tzdata: crond must fire at 04:30 America/Mexico_City.
RUN apk add --no-cache aws-cli tzdata \
 && mkdir -p /var/lib/backup

COPY backup.sh entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
