# DeepSeek public synthetic qualification

This harness evaluates a focused `sk-deepseek-s`, `sk-deepseek-m`, or
`sk-deepseek-l` route through SKGateway. The committed case set contains only
public synthetic text. It covers tool use, multiple tool calls, JSON schema,
repository navigation, code repair, test diagnosis, long context,
rejected-tool recovery, and adversarial instruction preservation.

Call `evaluateDeepSeekQualification()` with an explicit gateway URL and
focused route. Production callers supply an injected `fetchImpl` and a
`gatewayAuth` callback backed by the existing SKGateway authentication path.
The API has no provider-key argument. It rejects unknown options, embedded URL
credentials, local file URLs, home paths, Matter paths, HammerTime Inbox paths,
and non-DeepSeek routes.

Tests pass an exact map of in-memory fixture responses. No fixture path is
accepted. Fixture IDs must exactly equal the immutable case IDs, which prevents
an arbitrary local file or a partial case selection from entering the run.

The returned JSON contains only attribution, lowercase SHA256 identifiers,
bounded token and latency counts, and a reason for each pass or failure. It
does not retain prompts, responses, tool arguments, reasoning, credentials, or
capability material.

Reviewed card overrides carry an expiry. Generic bucket membership uses the
minimum of the declared prior, existing measured ceilings, and the reviewed
qualified class. Failed, malformed, or expired reviewed evidence removes the
model from generic membership. Direct and focused routing continue through the
existing health, trust, authorization, and target gates.
