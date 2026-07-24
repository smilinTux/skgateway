# Mission

SKGateway exists to be the network chokepoint for AI inference: a transparent, auditing proxy between any AI client and any LLM backend, so every prompt and every token is governed before it reaches the model.

It applies the BlueCoat/Zscaler idea to AI traffic. Each request passes through identity verification, a policy engine, prompt classifiers, and a SIEM event bus, giving operators enterprise SOC/SIEM control over AI usage that most deployments bolt on as an afterthought.

## Scope

- Identity (CapAuth, session, reputation), policy (rules, DLP/PII scanning, rate limiting), and classifiers (intent, risk, jailbreak, PII).
- Per-agent cost accounting, model routing, a real-time SOC dashboard, and a full audit event stream.
- Sovereign operation: no third-party telemetry, no cloud dependency, your data stays in your logs.

Within the SKCapstone framework, SKGateway is the inference chokepoint for Lumina and the full agent swarm, the single point where AI traffic is verified, classified, and logged.

## Non-goals

- SKGateway is not an LLM or an inference engine; it proxies to whatever backend you run.
- It is not a general web proxy; its scope is AI inference traffic.
- It does not store model weights or replace the identity, memory, or comms pillars it sits alongside.
