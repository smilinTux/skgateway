/** Model-only and single-process request admission for an exact trusted scope. */
export function createSkLegalRequestAdmission(policy, now = () => performance.now()) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)
    || Object.keys(policy).sort().join(",") !== "max_requests,model_only,window_ms"
    || policy.model_only !== true
    || !Number.isSafeInteger(policy.max_requests) || policy.max_requests < 1 || policy.max_requests > 1000
    || !Number.isSafeInteger(policy.window_ms) || policy.window_ms < 1 || policy.window_ms > 3600000) {
    throw new Error("SKLegal request policy requires bounded model-only admission");
  }
  const { max_requests: limit, window_ms: windowMs } = policy;
  let started = null;
  let admitted = 0;
  return function admit(body) {
    let request;
    try { request = JSON.parse(body.toString("utf8")); } catch { /* Deny below. */ }
    if (!request || typeof request !== "object" || Array.isArray(request)
      || ["tools", "tool_choice", "parallel_tool_calls", "functions", "function_call"].some(key => Object.hasOwn(request, key))
      || !Array.isArray(request.messages)
      || request.messages.some(message => !message || typeof message !== "object" || Array.isArray(message)
        || !["system", "developer", "user", "assistant"].includes(message.role)
        || ["tool_calls", "tool_call_id", "function_call"].some(key => Object.hasOwn(message, key))
        || (Array.isArray(message.content) && message.content.some(part =>
          ["tool_use", "tool_result", "function_call", "function_call_output"].includes(part?.type))))) {
      return { status: 403, code: "model_only_required", message: "Model-only request required" };
    }
    const current = now();
    // Each configured scope owns one counter. Restart intentionally resets it.
    if (started === null || current - started >= windowMs) {
      started = current;
      admitted = 0;
    }
    if (admitted >= limit) {
      return { status: 429, code: "request_rate_limited", message: "Request admission limit reached",
        retryAfter: Math.max(1, Math.ceil((windowMs - (current - started)) / 1000)) };
    }
    admitted++;
    return null;
  };
}
