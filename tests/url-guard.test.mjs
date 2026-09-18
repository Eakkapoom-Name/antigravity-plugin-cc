import test from "node:test";
import assert from "node:assert/strict";

import { guardFetchUrl, isBlockedAddress, isBlockedHostname, looksLikeUrl } from "../scripts/lib/url-guard.mjs";

test("looksLikeUrl recognises a scheme and nothing else", () => {
  assert.equal(looksLikeUrl("https://example.com/x"), true);
  assert.equal(looksLikeUrl("ftp://example.com"), true);
  assert.equal(looksLikeUrl("what is https"), false);
  assert.equal(looksLikeUrl("example.com"), false);
});

for (const ip of ["127.0.0.1", "127.9.9.9", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "169.254.1.1", "0.0.0.0", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.1.1.1", "::ffff:7f00:1", "::ffff:a00:1"]) {
  test(`isBlockedAddress blocks ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
}
for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "172.15.0.1", "2606:4700::1111", "::ffff:93.184.216.34", "::ffff:5db8:d822"]) {
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
  assert.equal((await guardFetchUrl("http://[::1]/", spy)).ok, false);
  assert.equal((await guardFetchUrl("http://[::ffff:127.0.0.1]/", spy)).ok, false);
  assert.equal(resolved, false);
});

test("guardFetchUrl rejects a host that does not resolve", async () => {
  const out = await guardFetchUrl("https://nope.invalid/", async () => { throw new Error("ENOTFOUND"); });
  assert.equal(out.ok, false);
  assert.match(out.reason, /resolve/);
});
