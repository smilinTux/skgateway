import { sanitizeResponse } from "./sanitizer.mjs";

function stripReasoning(value) {
  if (!value || typeof value !== "object") return value;
  const out = Array.isArray(value) ? value.map(stripReasoning) : { ...value };
  if (!Array.isArray(out)) {
    delete out.reasoning_content;
    for (const [key, child] of Object.entries(out)) out[key] = stripReasoning(child);
  }
  return out;
}

/** Preserve requested alias separately while exposing the upstream model exactly. */
export function enforceResponseContract(response, requestedModel) {
  if (!response?.body) return { ...response, requestedModel, servedModel: null };
  const contentType = String(response.headers?.["content-type"] || response.headers?.["Content-Type"] || "");
  let servedModel = null;
  let body = response.body;

  if (contentType.includes("text/event-stream") || body.toString("utf8").includes("data:")) {
    const lines = body.toString("utf8").split("\n").map((line) => {
      if (!line.startsWith("data:")) return line;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return line;
      try {
        const parsed = JSON.parse(payload);
        if (!servedModel && typeof parsed.model === "string" && parsed.model) servedModel = parsed.model;
        const clean = stripReasoning(parsed);
        if (requestedModel) clean.requested_model = requestedModel;
        return `data: ${JSON.stringify(clean)}`;
      } catch {
        return line;
      }
    });
    body = Buffer.from(lines.join("\n"), "utf8");
  } else {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      if (typeof parsed.model === "string" && parsed.model) servedModel = parsed.model;
      const clean = stripReasoning(sanitizeResponse(parsed, { thinkMode: "strip", label: "response-contract" }));
      if (requestedModel) clean.requested_model = requestedModel;
      body = Buffer.from(JSON.stringify(clean), "utf8");
    } catch {
      // Non-JSON error bodies remain byte-identical.
    }
  }

  return {
    ...response,
    body,
    requestedModel,
    servedModel: servedModel || null,
  };
}
