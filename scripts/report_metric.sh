# Sourced by run_ingest.sh and run_backup.sh (not run on its own).
#
# report_metric NAME VALUE publishes one data point to CloudWatch, namespace
# Phoebe: 1 when the job succeeded, 0 when it failed. Two kinds of alarm read
# these (docs/operations.md, "Alarms"): a 0 fires "failed" within the hour, and
# no 1 for 26 hours fires "stale", which also catches a job that never ran
# (cron, the server or this very call broken).
#
# The host's instance role may only call PutMetricData into the Phoebe
# namespace (inline policy phoebe-put-metrics). A failed call is logged and
# never changes the job's own exit code.
report_metric() {
  aws cloudwatch put-metric-data --region us-east-2 --namespace Phoebe \
    --metric-name "$1" --value "$2" \
    --cli-connect-timeout 10 --cli-read-timeout 20 >> "$LOG_FILE" 2>&1 \
    || echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') metric $1=$2 NOT sent" >> "$LOG_FILE"
}
