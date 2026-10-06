import test from "node:test";
import assert from "node:assert/strict";
import { formatIpv4, parseCidr, parseIpv4, prefixMask } from "../ipv4";

test("解析 IPv4 为无符号 32 位并可逆格式化", () => {
  assert.equal(parseIpv4("0.0.0.0"), 0);
  assert.equal(parseIpv4("255.255.255.255"), 0xffffffff);
  assert.equal(parseIpv4("10.1.2.3"), 0x0a010203);
  assert.equal(formatIpv4(0xffffffff), "255.255.255.255");
});

test("CIDR 主机位会规范化为网络地址", () => {
  const parsed = parseCidr("10.1.2.99/24");
  assert.equal(parsed.cidr, "10.1.2.0/24");
  assert.equal(parsed.network, 0x0a010200);
  assert.equal(parsed.normalized, true);
  assert.equal(parseCidr("0.0.0.0/0").cidr, "0.0.0.0/0");
  assert.equal(parseCidr("255.255.255.255/32").cidr, "255.255.255.255/32");
});

test("掩码避免有符号移位错误", () => {
  assert.equal(prefixMask(0), 0);
  assert.equal(prefixMask(1), 0x80000000);
  assert.equal(prefixMask(32), 0xffffffff);
});

test("拒绝非法地址、越界前缀和有歧义数字", () => {
  assert.throws(() => parseIpv4("256.0.0.1"), /IPv4 段越界/);
  assert.throws(() => parseIpv4("01.0.0.1"), /禁止使用带前导零/);
  assert.throws(() => parseIpv4("1.2.3"), /非法点分十进制/);
  assert.throws(() => parseCidr("1.2.3.4/33"), /前缀长度越界/);
  assert.throws(() => parseCidr("1.2.3.4/-1"), /前缀长度格式非法/);
});
