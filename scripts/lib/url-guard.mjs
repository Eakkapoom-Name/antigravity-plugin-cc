import dns from "node:dns";
import net from "node:net";

// Fetch mode hands a URL to agy, which reads it with its own tools from this
// machine. Anything that resolves inside the machine's own network is refused
// before agy sees it: loopback, RFC 1918, link-local (which holds the cloud
// metadata address), and their IPv6 and IPv4-mapped forms.

export function looksLikeUrl(text) {
  const token = String(text ?? "").trim();
  return !/\s/.test(token) && /^[a-z][a-z0-9+.-]*:\/\//i.test(token);
}

function ipv4Parts(address) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function blockedIpv4(parts) {
  const [a, b] = parts;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function isBlockedAddress(address) {
  const ip = String(address ?? "").trim().toLowerCase();
  if (net.isIPv4(ip)) {
    return blockedIpv4(ipv4Parts(ip));
  }
  if (!net.isIPv6(ip)) {
    return false;
  }
  // An IPv4-mapped IPv6 address reaches here in either spelling: the dotted
  // form a resolver's getaddrinfo returns (::ffff:127.0.0.1), or the pure-hex
  // form the WHATWG URL parser normalises a literal [::ffff:127.0.0.1] to
  // (::ffff:7f00:1). Checking only one spelling would let a literal URL slip
  // past a check the resolved form would have caught.
  const mappedDotted = ip.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) {
    return blockedIpv4(ipv4Parts(mappedDotted[1]));
  }
  const mappedHex = ip.match(/^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return blockedIpv4([hi >>> 8, hi & 255, lo >>> 8, lo & 255]);
  }
  if (ip === "::" || ip === "::1") return true;
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true; // unique local fc00::/7
  return false;
}

export function isBlockedHostname(host) {
  const name = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost") || name === "metadata" || name === "metadata.google.internal";
}

export async function guardFetchUrl(text, lookup = dns.promises.lookup) {
  let url;
  try {
    url = new URL(String(text ?? "").trim());
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme ${url.protocol.replace(":", "")} is not allowed; use http or https` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "the URL carries credentials; remove them" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(host)) {
    return { ok: false, reason: `host ${host} is a local name` };
  }
  if (net.isIP(host)) {
    return isBlockedAddress(host)
      ? { ok: false, reason: `address ${host} is loopback, private, or link-local` }
      : { ok: true, url };
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch (error) {
    return { ok: false, reason: `could not resolve ${host}: ${error.message}` };
  }
  const blocked = addresses.map((entry) => entry.address).find((address) => isBlockedAddress(address));
  if (blocked) {
    return { ok: false, reason: `host ${host} resolves to ${blocked}, which is loopback, private, or link-local` };
  }
  return { ok: true, url };
}
