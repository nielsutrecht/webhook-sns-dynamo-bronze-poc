SELECT
    transactionType,
    day,
    txCount,
    totalCents
FROM {database}.gold_daily_volume_by_type
ORDER BY day DESC, txCount DESC
LIMIT 1000
