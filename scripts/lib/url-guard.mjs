import dns from "node:dns";
import net from "node:net";

// Fetch mode hands a URL to agy, which reads it with its own tools from this
// machine. This guard resolves the host and checks it once, before agy ever
// sees the URL: loopback, RFC 1918, link-local (which holds the cloud
// metadata address), carrier-grade NAT, multicast, broadcast, and a few
// other IANA special-purpose ranges, in every IPv4 and IPv6 form it can
// recognise (mapped, translated, IPv4-compatible, NAT64, 6to4).
//
// What this cannot do: it runs once, in this process, before the request is
// handed to agy, which performs the actual fetch in its own process
// afterward. A redirect from a passed URL to a blocked one is invisible
// here, since the guard only ever sees the URL it was given, not what that
// URL's server sends back. A DNS answer that changes between this check and
// agy's own connection (rebinding) is likewise invisible: this guard's
// `lookup` call and agy's own resolution are two separate lookups with no
// way to bind them together from here. A pass from this guard means "the
// URL given did not point at this machine's own network when checked," not
// a guarantee about where the connection ultimately lands.

export function looksLikeUrl(text) {
  const token = String(text ?? "").trim();
  if (/\s/.test(token)) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
    return true;
  }
  // http, https, ftp, ws, and wss are WHATWG "special schemes": Node's URL
  // parser (and any standards-compliant client, including agy's own)
  // accepts each of them with no "//" at all, and treats any number of
  // leading "/" and "\" the same way, so "http:127.0.0.1",
  // "http:\127.0.0.1", "http:/127.0.0.1", and "ftp:127.0.0.1" all parse a
  // host exactly like the slashed form does. Routing "ftp:127.0.0.1" here
  // matters even though the guard only ever accepts http and https: without
  // it, this token matched neither the "//" form above nor this one, so it
  // reached agy as an unchecked search query instead of being refused for
  // its scheme, the same way "ftp://127.0.0.1" already is. Every other
  // scheme still needs "//" to be recognised as a URL at all: an arbitrary
  // "word:word" is ordinary text ("RFC:3986", "todo:buy milk"), and
  // routing it to the fetch path would refuse a one-word search query for
  // a scheme it never claimed to name.
  return /^(?:https?|ftp|wss?):\S/i.test(token);
}

function ipv4Parts(address) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function blockedIpv4(parts) {
  const [a, b, c, d] = parts;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale, 100.64.0.0/10
  if (a >= 224 && a <= 239) return true; // multicast, 224.0.0.0/4
  if (a === 255 && b === 255 && c === 255 && d === 255) return true; // limited broadcast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking, 198.18.0.0/15
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments, 192.0.0.0/24
  return false;
}

// Expands any address net.isIPv6 already accepted into its eight 16-bit
// groups, including a trailing dotted-decimal IPv4 tail (the
// "::ffff:127.0.0.1" style), so every embedded-IPv4 and reserved-range check
// below works the same whichever way the address was compressed or spelled.
// A single generic expansion, checked against each known embedding, is what
// let the mapped-address fix generalise to IPv4-compatible, NAT64, and 6to4
// addresses instead of needing one more spelling-specific regex per class.
function ipv6Groups(ip) {
  const expandSide = (side) =>
    side
      .split(":")
      .filter(Boolean)
      .flatMap((group) => {
        if (group.includes(".")) {
          const octets = group.split(".").map(Number);
          return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
        }
        return [parseInt(group, 16)];
      });

  const compressedAt = ip.indexOf("::");
  if (compressedAt === -1) {
    return expandSide(ip);
  }
  const head = expandSide(ip.slice(0, compressedAt));
  const tail = expandSide(ip.slice(compressedAt + 2));
  const zeros = new Array(Math.max(0, 8 - head.length - tail.length)).fill(0);
  return [...head, ...zeros, ...tail];
}

function embeddedIpv4(groups, fromIndex) {
  const hi = groups[fromIndex];
  const lo = groups[fromIndex + 1];
  return [hi >>> 8, hi & 255, lo >>> 8, lo & 255];
}

export function isBlockedAddress(address) {
  const ip = String(address ?? "").trim().toLowerCase();
  if (net.isIPv4(ip)) {
    return blockedIpv4(ipv4Parts(ip));
  }
  if (!net.isIPv6(ip)) {
    return false;
  }
  const groups = ipv6Groups(ip);
  if (groups.length !== 8) {
    // An address net.isIPv6 accepted but this guard could not expand to
    // eight groups is an answer it does not understand; refuse it rather
    // than treat the failed expansion as "not blocked".
    return true;
  }
  const allZero = (from, to) => groups.slice(from, to).every((g) => g === 0);

  // IPv4-mapped, ::ffff:0:0/96 (RFC 4291, "::ffff:a.b.c.d"): the low 32
  // bits are an embedded IPv4 address, in whichever spelling the caller or
  // the URL parser produced.
  if (allZero(0, 5) && groups[5] === 0xffff) {
    return blockedIpv4(embeddedIpv4(groups, 6));
  }
  // IPv4-translated (RFC 2765, "::ffff:0:a.b.c.d"): the same ffff marker,
  // shifted one group earlier, with an explicit zero group between it and
  // the embedded IPv4 address. A guard that only recognised the mapped
  // form's group position would let this spelling of the same embedded
  // address through.
  if (allZero(0, 4) && groups[4] === 0xffff && groups[5] === 0) {
    return blockedIpv4(embeddedIpv4(groups, 6));
  }
  // IPv4-compatible, ::/96 (deprecated, but still a valid address this host
  // could resolve or be handed as a literal): same embedding, no ffff
  // marker. This also covers the bare "::" and "::1", whose embedded
  // addresses (0.0.0.0 and 0.0.0.1) already fall under the 0.0.0.0/8 rule
  // in blockedIpv4.
  if (allZero(0, 6)) {
    return blockedIpv4(embeddedIpv4(groups, 6));
  }
  // NAT64 well-known prefix, 64:ff9b::/96.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && allZero(2, 6)) {
    return blockedIpv4(embeddedIpv4(groups, 6));
  }
  // 6to4, 2002::/16: the next 32 bits after the fixed prefix are the
  // embedded IPv4 address.
  if (groups[0] === 0x2002) {
    return blockedIpv4(embeddedIpv4(groups, 1));
  }
  if (groups[0] >= 0xfe80 && groups[0] <= 0xfebf) return true; // link-local fe80::/10
  if (groups[0] >= 0xfc00 && groups[0] <= 0xfdff) return true; // unique local fc00::/7
  if ((groups[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
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
      ? { ok: false, reason: `address ${host} is a local or reserved address` }
      : { ok: true, url };
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch (error) {
    return { ok: false, reason: `could not resolve ${host}: ${error.message}` };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    // A resolver answer this guard cannot read as a non-empty address list
    // is refused, not treated as "no blocked address found in it".
    return { ok: false, reason: `host ${host} resolved to no usable address` };
  }
  const resolved = addresses.map((entry) => String(entry?.address ?? ""));
  const unreadable = resolved.find((address) => !net.isIP(address));
  if (unreadable !== undefined) {
    // Same rule as the empty-answer case: an entry this guard cannot parse
    // as an IP address is refused rather than skipped over as "not a match".
    return { ok: false, reason: `host ${host} resolved to an address this guard could not read` };
  }
  const blocked = resolved.find((address) => isBlockedAddress(address));
  if (blocked) {
    return { ok: false, reason: `host ${host} resolves to ${blocked}, a local or reserved address` };
  }
  return { ok: true, url };
}
