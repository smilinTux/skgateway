/**
 * z.ai ZCode subscription credential adapter.
 *
 * ZCode owns the OAuth lifecycle and stores the current access token in
 * ~/.zcode/v2/credentials.json under oauth:zai:access_token. SKGateway reads
 * that file read-only and never refreshes or writes it. The official ZCode
 * process remains the sole token owner.
 */

import fs from "node:fs";
import { homedir } from "node:os";

export const ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
// ZCode's active Coding Plan key is currently stored in config.json. The
// OAuth artifact in credentials.json is also supported below because ZCode
// versions have used both stores during login and account transitions.
export const ZAI_CREDENTIALS_PATH = "~/.zcode/v2/config.json";

/**
 * Return true when a backend is the OpenAI-compatible z.ai subscription route.
 * @param {object|null} backend
 * @returns {boolean}
 */
export function isZaiBackend(backend) {
  if (!backend) return false;
  return backend.auth_type === "zai_oauth" || /api\.z\.ai\//i.test(String(backend.url || ""));
}

/**
 * Read the ZCode access token without mutating the credential file.
 *
 * @param {string|null} filePath
 * @returns {Record<string,string>|null}
 */
export function readZaiAuthHeaders(filePath) {
  if (!filePath) return null;
  try {
    const resolved = filePath.startsWith("~/")
      ? `${homedir()}/${filePath.slice(2)}`
      : filePath;
    const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
    const oauthToken = raw && typeof raw === "object"
      ? raw["oauth:zai:access_token"]
      : null;
    const planKey = raw?.provider?.["builtin:zai-coding-plan"]?.options?.apiKey;
    const token = typeof planKey === "string" && planKey
      ? planKey
      : oauthToken;
    if (typeof token !== "string" || !token) return null;
    return { authorization: `Bearer ${token}` };
  } catch {
    return null;
  }
}
