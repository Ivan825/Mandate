import { isIP, BlockList } from "node:net";

// Address rules shared by everything that fetches a URL a user supplied:
// notification webhooks, event webhooks, generic proxy targets. Private,
// loopback, link-local and cloud-metadata ranges are never reachable from
// this server on a user's say-so. BlockList understands IPv4-mapped IPv6
// (`::ffff:a9fe:a9fe` is checked as 169.254.169.254), so the mapped, hex and
// dotted spellings all resolve to the same answer.

const PRIVATE = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 96], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) PRIVATE.addSubnet(net, bits, "ipv6");

// Cloud metadata endpoints: blocked even where private addresses are allowed.
const METADATA = new BlockList();
METADATA.addSubnet("169.254.0.0", 16, "ipv4");
METADATA.addAddress("100.100.100.200", "ipv4"); // Alibaba
METADATA.addSubnet("fd00:ec2::", 32, "ipv6");   // AWS IMDS v6
METADATA.addSubnet("fe80::", 10, "ipv6");

export function isPrivateAddress(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, "").split("%")[0];
  const family = isIP(v);
  if (family === 4) return PRIVATE.check(v, "ipv4");
  if (family === 6) return PRIVATE.check(v, "ipv6"); // 6to4, Teredo and NAT64 prefixes are blocked wholesale
  return true; // not an address at all: refuse
}

export function isMetadataAddress(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, "").split("%")[0];
  const family = isIP(v);
  if (family === 4) return METADATA.check(v, "ipv4");
  if (family === 6) return METADATA.check(v, "ipv6");
  return false;
}
