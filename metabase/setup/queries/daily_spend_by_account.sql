SELECT
    accountId,
    day,
    totalCents,
    txCount
FROM {database}.gold_daily_spend_by_account
ORDER BY day DESC, totalCents DESC
LIMIT 1000
