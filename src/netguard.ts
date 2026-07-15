// SSRF guard for the extraction fetcher (Qodo finding 1).
// Only public http(s) destinations are fetchable; loopback, private,
// link-local, CGNAT, and multicast ranges are rejected for both address
// literals and DNS-resolved hostnames.

import dns from "node:dns/promises";
import net from "node:net";

export type LookupFn = (hostname: string) => Promise<string[]>;

const defaultLookup: LookupFn = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

export function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true; // not an IP: treat as unsafe when asked directly
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-net, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // IETF special 192.0.0/24 + 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const lc = ip.toLowerCase();
  // IPv4-mapped (::ffff:1.2.3.4): judge the embedded v4
  const mapped = lc.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]!);
  if (lc === "::" || lc === "::1") return true; // unspecified, loopback
  if (lc.startsWith("fc") || lc.startsWith("fd")) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(lc)) return true; // link-local fe80::/10
  if (lc.startsWith("ff")) return true; // multicast
  return false;
}

/**
 * Throws unless `raw` is an http(s) URL whose host resolves only to public
 * addresses. Returns the parsed URL.
 * Residual risk (accepted for a personal LAN app): DNS rebinding between this
 * check and the actual fetch. Full mitigation would require pinning the
 * resolved address into the connection.
 */
export async function assertPublicHttpUrl(
  raw: string,
  lookup: LookupFn = defaultLookup,
): Promise<URL> {
  if (raw.length > 2048) throw new Error("URL too long.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked scheme: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!host || host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("Blocked host.");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Blocked address range.");
    return url;
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new Error(`Could not resolve host: ${host}`);
  }
  if (addresses.length === 0) throw new Error(`Could not resolve host: ${host}`);
  if (addresses.some((a) => isPrivateIp(a))) {
    throw new Error("Blocked address range.");
  }
  return url;
}
