/**
 * bucket-affinity.mjs — keep one agent session on one bucket member.
 *
 * A bucket picks a member per request (rotation counter, weighted tickets),
 * so consecutive turns of ONE conversation used to land on different models.
 * That is not only noisy, it breaks providers that require their own prior
 * turn state back: on chi (2026-10-10) a fleet builder session went
 * deepseek-flash -> glm-5.3 -> deepseek-flash and DeepSeek rejected the turn
 * with 400 "The `reasoning_content` in the thinking mode must be passed back".
 *
 * The session is identified by an explicit x-session-id header when the
 * caller sends one, otherwise by the conversation's opening (first system or
 * developer message plus first user message). Those stay byte-identical on
 * every turn of a session, while later turns only append. The key is scoped
 * by bucket so the same conversation asking a different bucket is free.
 *
 * Affinity only reorders: the remembered member goes first when it is still
 * eligible, and every other member stays in the failover chain. A member
 * that dropped out of the pool (throttled, quarantined, fenced) is never
 * forced; the request then routes as before and the new pick is remembered.
 *
 * @module bucket-affinity
 */

import { fnv1a } from "../proxy/decision-cache.mjs";

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (typeof part === "string") text += part;
    else if (part && typeof part.text === "string") text += part.text;
  }
  return text;
}

/**
 * @param {string} bucket  Bucket id (sk-m, sk-glm-l, ...).
 * @param {Array<{role?:string, content?:*}>} messages
 * @param {string|undefined|null} sessionId  Optional x-session-id header.
 * @returns {string|null}  Null when there is nothing stable to key on.
 */
export function bucketAffinityKey(bucket, messages, sessionId) {
  if (typeof sessionId === "string" && sessionId.trim()) {
    return `${bucket}|s:${sessionId.trim()}`;
  }
  const msgs = Array.isArray(messages) ? messages : [];
  const user = msgs.find((m) => m && m.role === "user");
  if (!user) return null;
  const system = msgs.find((m) => m && (m.role === "system" || m.role === "developer"));
  const opening = contentText(system?.content);
  const first = contentText(user.content);
  return `${bucket}|c:${opening.length}:${fnv1a(opening)}:${first.length}:${fnv1a(first)}`;
}

/**
 * True once the conversation carries a prior assistant turn. Only these
 * requests follow affinity: a first turn routes exactly as before (weights,
 * rotation), so identical one-shot prompts from unrelated callers still
 * spread across members, and its pick is what later turns stick to.
 *
 * @param {Array<{role?:string}>} messages
 * @returns {boolean}
 */
export function isContinuation(messages) {
  return Array.isArray(messages) && messages.some((m) => m && m.role === "assistant");
}

/**
 * Move the remembered member to the front: exact model first, else the same
 * family. Returns the input order unchanged when nothing eligible matches.
 *
 * @param {Array<{id:string, family?:string}>} members  Ordered eligible members.
 * @param {{id?:string, family?:string}|null} remembered
 * @returns {Array}
 */
export function preferRemembered(members, remembered) {
  if (!remembered || !Array.isArray(members) || members.length === 0) return members;
  let index = members.findIndex((m) => m && m.id === remembered.id);
  if (index < 0 && remembered.family) {
    index = members.findIndex((m) => m && m.family === remembered.family);
  }
  if (index <= 0) return members;
  return [members[index], ...members.filter((_, i) => i !== index)];
}
