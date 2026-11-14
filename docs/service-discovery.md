# Shared service discovery

Set `SKGATEWAY_HEALTH_URL` to the deployment health URL reachable by other
cluster nodes, for example `https://gateway.example/health`. This is a liveness
check, not proof that all model providers are available.

The SKCapstone registry is shared between hosts. An unset or invalid URL leaves
an existing record untouched. Loopback, wildcard, and credential-bearing URLs
are rejected without logging their contents. Local development and test servers
therefore cannot replace a working shared record with a temporary local port.
