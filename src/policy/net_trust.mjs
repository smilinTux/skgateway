/**
 * net_trust.mjs — the network trust boundary for the "allow internal, gate
 * external" authz posture (SKWorld authz std, skgateway PEP).
 *
 * `isInternalRemote(remoteAddress)` decides whether a request's TCP peer is on a
 * trusted internal network. It reads the OS-reported `req.socket.remoteAddress`,
 * which is the real established-connection peer, NOT a client-settable header, so
 * it cannot be spoofed at the IP layer as long as no trusted proxy sits in front
 * (skgateway binds directly, no X-Forwarded-For trust).
 *
 * Internal =
 *   • IPv4 loopback 127.0.0.0/8
 *   • Tailscale CGNAT 100.64.0.0/10  (the fleet tailnet)
 *   • RFC1918: 10/8, 172.16/12, 192.168/16
 *   • IPv6 loopback ::1, ULA fc00::/7 (incl. Tailscale fd7a:…), link-local fe80::/10
 * Everything else — and anything unparseable/missing — is EXTERNAL (fail-closed:
 * an unknown peer gets gated, never trusted).
 *
 * @module policy/net_trust
 */

/**
 * @param {unknown} remote  Value of req.socket.remoteAddress (string | null).
 * @returns {boolean} true iff the peer is on a trusted internal network.
 */
export function isInternalRemote(remote) {
  if (typeof remote !== "string") return false;
  let ip = remote.trim().toLowerCase();
  if (!ip) return false;
  ip = ip.split("%")[0]; // drop IPv6 zone id (fe80::1%eth0)
  if (ip.startsWith("::ffff:")) ip = ip.slice(7); // IPv4-mapped IPv6 → its IPv4

  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const o = ip.split(".").map((n) => Number(n));
    if (o.some((n) => n > 255)) return false;
    const [a, b] = o;
    if (a === 127) return true; // loopback 127/8
    if (a === 10) return true; // RFC1918 10/8
    if (a === 192 && b === 168) return true; // RFC1918 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
    if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT 100.64/10
    return false;
  }

  // IPv6
  if (ip === "::1") return true; // loopback
  if (/^fe[89ab]/.test(ip)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(ip)) return true; // ULA fc00::/7 (incl. Tailscale fd7a:…)
  return false;
}
