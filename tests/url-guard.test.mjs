import test from "node:test";
import assert from "node:assert/strict";

import { guardFetchUrl, isBlockedAddress, isBlockedHostname, looksLikeUrl } from "../scripts/lib/url-guard.mjs";

test("looksLikeUrl recognises a scheme and nothing else", () => {
  assert.equal(looksLikeUrl("https://example.com/x"), true);
  assert.equal(looksLikeUrl("ftp://example.com"), true);
  assert.equal(looksLikeUrl("what is https"), false);
  assert.equal(looksLikeUrl("example.com"), false);
});

// http and https are WHATWG "special schemes": no "//" is required, and any
// number of leading "/" or "\" is accepted in its place, so all of these
// resolve to the same address as the slashed form.
test("looksLikeUrl recognises http and https with no slashes or with backslashes", () => {
  assert.equal(looksLikeUrl("http:127.0.0.1"), true);
  assert.equal(looksLikeUrl("https:127.0.0.1"), true);
  assert.equal(looksLikeUrl("http:\\127.0.0.1"), true);
  assert.equal(looksLikeUrl("http:/127.0.0.1"), true);
  // Only http and https get this extra allowance; every other scheme still
  // needs "//" to be recognised as a URL at all.
  assert.equal(looksLikeUrl("ftp:127.0.0.1"), false);
  assert.equal(looksLikeUrl("http:"), false);
});

for (const ip of [
  // Loopback, RFC 1918, link-local, and the metadata address.
  "127.0.0.1", "127.9.9.9", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "169.254.1.1", "0.0.0.0",
  // Carrier-grade NAT / Tailscale, 100.64.0.0/10.
  "100.64.0.1", "100.100.100.100", "100.127.255.255",
  // Multicast, limited broadcast, benchmarking, and IETF protocol assignments.
  "224.0.0.1", "239.255.255.255", "255.255.255.255", "198.18.0.1", "198.19.255.255", "192.0.0.1",
  // IPv6 loopback, unspecified, link-local, and unique-local.
  "::1", "::", "fe80::1", "fc00::1", "fd12::1",
  // IPv4-mapped IPv6, both the dotted and the URL-parser's hex spelling.
  "::ffff:127.0.0.1", "::ffff:10.1.1.1", "::ffff:7f00:1", "::ffff:a00:1",
  // IPv4-translated IPv6 (RFC 2765): same ffff marker as mapped, one group
  // earlier, with an explicit zero group before the embedded IPv4 address.
  "::ffff:0:127.0.0.1", "::ffff:0:10.0.0.1",
  // IPv4-compatible IPv6 (deprecated but still a valid, parseable address).
  "::127.0.0.1", "::7f00:1",
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16), embedding the same loopback address.
  "64:ff9b::7f00:1", "64:ff9b::127.0.0.1", "2002:7f00:1::",
  // IPv6 multicast, ff00::/8.
  "ff02::1"
]) {
  test(`isBlockedAddress blocks ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
}
for (const ip of [
  "8.8.8.8", "93.184.216.34", "172.32.0.1", "172.15.0.1",
  // Just outside the widened ranges: 100.63/100.128 flank CGNAT, 198.17/198.20
  // flank benchmarking, 192.0.1.0 is outside the /24 protocol-assignment block.
  "100.63.255.255", "100.128.0.1", "223.255.255.255", "240.0.0.1", "198.17.255.255", "198.20.0.1", "192.0.1.1",
  "2606:4700::1111", "::ffff:93.184.216.34", "::ffff:5db8:d822", "::ffff:0:93.184.216.34"
]) {
  test(`isBlockedAddress allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false));
}

test("isBlockedHostname blocks localhost and the metadata host", () => {
  for (const host of ["localhost", "LOCALHOST", "foo.localhost", "metadata.google.internal", "metadata"]) {
    assert.equal(isBlockedHostname(host), true, host);
  }
  assert.equal(isBlockedHostname("example.com"), false);
});

const resolveTo = (addresses) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

test("guardFetchUrl accepts a public https url", async () => {
  const out = await guardFetchUrl("https://example.com/path?q=1", resolveTo(["93.184.216.34"]));
  assert.equal(out.ok, true);
  assert.equal(out.url.href, "https://example.com/path?q=1");
});

test("guardFetchUrl rejects schemes other than http and https", async () => {
  const out = await guardFetchUrl("ftp://example.com/x", resolveTo(["93.184.216.34"]));
  assert.equal(out.ok, false);
  assert.match(out.reason, /http or https/);
});

test("guardFetchUrl rejects credentials in the url", async () => {
  const out = await guardFetchUrl("https://user:pw@example.com/", resolveTo(["93.184.216.34"]));
  assert.equal(out.ok, false);
  assert.match(out.reason, /credentials/);
});

test("guardFetchUrl rejects a host that resolves to a private or loopback address", async () => {
  const out = await guardFetchUrl("https://internal.example/", resolveTo(["93.184.216.34", "10.0.0.5"]));
  assert.equal(out.ok, false);
  assert.match(out.reason, /10\.0\.0\.5/);
});

test("guardFetchUrl rejects a literal blocked address and a blocked hostname without resolving", async () => {
  let resolved = false;
  const spy = async () => { resolved = true; return []; };
  assert.equal((await guardFetchUrl("http://169.254.169.254/latest", spy)).ok, false);
  assert.equal((await guardFetchUrl("http://localhost:8080/", spy)).ok, false);
  assert.equal(resolved, false);
});

// The WHATWG URL parser normalises any spelling of a bracketed IPv6 literal
// to compressed hex, so a mapped loopback address reaches isBlockedAddress
// as "::ffff:7f00:1" even though the user typed the dotted form. A guard that
// only recognised the dotted spelling would let this one through.
test("guardFetchUrl rejects a bracketed IPv6 literal however the mapped address was spelled", async () => {
  let resolved = false;
  const spy = async () => { resolved = true; return []; };
  const loopback = await guardFetchUrl("http://[::1]/", spy);
  assert.equal(loopback.ok, false);
  assert.match(loopback.reason, /::1/);
  const mapped = await guardFetchUrl("http://[::ffff:127.0.0.1]/", spy);
  assert.equal(mapped.ok, false);
  assert.match(mapped.reason, /::ffff:7f00:1/);
  assert.equal(resolved, false);
});

test("guardFetchUrl rejects a host that does not resolve", async () => {
  const out = await guardFetchUrl("https://nope.invalid/", async () => { throw new Error("ENOTFOUND"); });
  assert.equal(out.ok, false);
  assert.match(out.reason, /resolve/);
});

// An empty resolver answer is a shape this guard's "find a blocked address in
// the list" check would otherwise pass through as "none found"; a security
// control has to refuse an answer it does not understand, not treat it as
// clean.
test("guardFetchUrl fails closed on an empty resolver answer", async () => {
  const out = await guardFetchUrl("https://empty-answer.example/", async () => []);
  assert.equal(out.ok, false);
  assert.match(out.reason, /no usable address/);
});

// A `{ address: "not-an-ip" }` entry, or one missing `address` altogether,
// would never match `isBlockedAddress` and so would fall through the
// original "find a blocked address in the list" check as "none found". The
// guard has to refuse an entry it cannot read as an IP address, not skip it.
test("guardFetchUrl fails closed on a resolver entry it cannot read as an address", async () => {
  const out = await guardFetchUrl("https://garbage-answer.example/", async () => [{ address: "not-an-ip" }]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /could not read/);
});
