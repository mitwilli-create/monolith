// Qodo finding 1 (SSRF): the URL guard must reject every private surface.
import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, isPrivateIp } from "../src/netguard.js";

const publicLookup = async () => ["93.184.216.34"];
const privateLookup = async () => ["10.0.0.5"];
const mixedLookup = async () => ["93.184.216.34", "127.0.0.1"];

describe("isPrivateIp", () => {
  const privates = [
    "127.0.0.1", "127.255.255.255", "10.0.0.1", "172.16.0.1", "172.31.255.1",
    "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "192.0.2.1", "198.18.0.1",
    "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:192.168.1.1",
  ];
  const publics = ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"];

  for (const ip of privates) {
    it(`treats ${ip} as private`, () => expect(isPrivateIp(ip)).toBe(true));
  }
  for (const ip of publics) {
    it(`treats ${ip} as public`, () => expect(isPrivateIp(ip)).toBe(false));
  }
});

describe("assertPublicHttpUrl", () => {
  it("accepts a public https URL", async () => {
    await expect(
      assertPublicHttpUrl("https://example.com/product", publicLookup),
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects non-http schemes", async () => {
    for (const u of ["file:///etc/passwd", "ftp://example.com", "gopher://x"]) {
      await expect(assertPublicHttpUrl(u, publicLookup)).rejects.toThrow(/scheme|Invalid/i);
    }
  });

  it("rejects localhost by name", async () => {
    await expect(assertPublicHttpUrl("http://localhost:4600/", publicLookup)).rejects.toThrow(/Blocked host/);
    await expect(assertPublicHttpUrl("http://api.localhost/", publicLookup)).rejects.toThrow(/Blocked host/);
  });

  it("rejects loopback/private address literals, IPv4 and IPv6", async () => {
    for (const u of ["http://127.0.0.1/", "http://10.1.2.3/", "http://[::1]/", "http://169.254.169.254/latest/meta-data"]) {
      await expect(assertPublicHttpUrl(u, publicLookup)).rejects.toThrow(/Blocked address/);
    }
  });

  it("rejects hostnames that resolve to private addresses", async () => {
    await expect(assertPublicHttpUrl("https://evil.example/", privateLookup)).rejects.toThrow(/Blocked address/);
  });

  it("rejects hostnames where ANY resolved address is private (rebinding posture)", async () => {
    await expect(assertPublicHttpUrl("https://evil.example/", mixedLookup)).rejects.toThrow(/Blocked address/);
  });

  it("rejects unresolvable hosts and oversized URLs", async () => {
    const failLookup = async () => { throw new Error("ENOTFOUND"); };
    await expect(assertPublicHttpUrl("https://nope.invalid/", failLookup)).rejects.toThrow(/resolve/);
    await expect(assertPublicHttpUrl(`https://example.com/${"a".repeat(2050)}`, publicLookup)).rejects.toThrow(/too long/i);
  });
});
