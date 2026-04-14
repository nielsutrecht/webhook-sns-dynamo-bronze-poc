SELECT
    accountId,
    day,
    creditCents,
    debitCents,
    netCents
FROM {database}.gold_daily_net_flow_by_account
ORDER BY day DESC, netCents DESC
LIMIT 1000
