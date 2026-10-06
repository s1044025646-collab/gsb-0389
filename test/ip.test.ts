import { test } from "node:test";
import assert from "node:assert/strict";
import { formatIPv4, parseCidrStrict, parseIPv4Strict, prefixMask } from "../src/ip.ts";

test("严格解析 IPv4 与拒绝歧义格式", () => {
  assert.equal(parseIPv4Strict("0.0.0.0"), 0n);
  assert.equal(parseIPv4Strict("255.255.255.255"), (1n << 32n) - 1n);
  assert.equal(parseIPv4Strict("10.1.2.3"), 0x0a010203n);
  assert.equal(formatIPv4(0x0a010203n), "10.1.2.3");

  for (const bad of [
    "1.2.3",
    "1.2.3.4.5",
    "01.2.3.4",
    "1.02.3.4",
    "256.0.0.1",
 "1.2.3.-1",
    "0x0a.0.0.1",
    "1 .2.3.4",
    "",
    "a.b.c.d",
  ]) {
    assert.throws(() => parseIPv4Strict(bad), /^/, `应拒绝：${bad}`);
  }
});

test("无符号 32 位与掩码不受有符号位运算影响", () => {
  assert.equal(prefixMask(0), 0n);
  assert.equal(prefixMask(32), (1n << 32n) - 1n);
  assert.equal(prefixMask(1), 0x80000000n);
  assert.equal(parseIPv4Strict("224.0.0.1") >> 0n === 0xe0000001n, true);
  // 高位置 1 时仍为正数语义
  assert.ok(parseIPv4Strict("255.0.0.0") > 0x7fffffffn);
});

test("CIDR 规范化主机位并标注", () => {
  const a = parseCidrStrict("10.1.2.9/16");
  assert.equal(a.normalizedCidr, "10.1.0.0/16");
  assert.equal(a.hadHostBits, true);

  const b = parseCidrStrict("10.1.2.0/24");
  assert.equal(b.hadHostBits, false);

  assert.equal(parseCidrStrict("0.0.0.0/0").normalizedCidr, "0.0.0.0/0");
  assert.equal(parseCidrStrict("1.2.3.4/32").normalizedCidr, "1.2.3.4/32");

  for (const bad of ["1.2.3.4/33", "1.2.3.4/-1", "1.2.3.4/", "1.2.3.4/01", "1.2.3/8"]) {
    assert.throws(() => parseCidrStrict(bad), /^/, `应拒绝：${bad}`);
  }
});
