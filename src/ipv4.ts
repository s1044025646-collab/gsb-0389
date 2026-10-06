import { AppError, fail } from "./errors";

export const IPV4_MAX = 0xffffffff;

export interface ParsedCidr {
  cidr: string;
  network: number;
  prefixLength: number;
  inputAddress: string;
  normalized: boolean;
}

export function parseIpv4(address: unknown): number {
  if (typeof address !== "string") {
    throw new AppError("INVALID_IPV4", "IPv4 地址必须是字符串", 400);
  }
  const text = address;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) {
    fail("INVALID_IPV4", `非法点分十进制 IPv4 地址: ${String(address)}`);
  }
  const matched = match!;
  const parts = matched.slice(1).map((part) => {
    if (part.length > 1 && part.startsWith("0")) {
      throw new AppError(
        "AMBIGUOUS_NUMBER",
        `禁止使用带前导零的数字格式: ${part}`,
        400
      );
    }
    const value = Number(part);
    if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
      throw new AppError("AMBIGUOUS_NUMBER", `IPv4 段越界: ${part}`, 400);
    }
    return value;
  });
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

export function formatIpv4(value: number): string {
  const unsigned = value >>> 0;
  return [
    (unsigned >>> 24) & 255,
    (unsigned >>> 16) & 255,
    (unsigned >>> 8) & 255,
    unsigned & 255
  ].join(".");
}

export function prefixMask(prefixLength: number): number {
  if (prefixLength === 0) return 0;
  if (prefixLength === 32) return IPV4_MAX;
  return (IPV4_MAX << (32 - prefixLength)) >>> 0;
}

export function parsePrefixLength(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") {
    fail("INVALID_PREFIX_LENGTH", "前缀长度必须是 0 到 32 的整数");
  }
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text) || text.length > 2) {
    fail("INVALID_PREFIX_LENGTH", `前缀长度格式非法: ${text}`);
  }
  const length = Number(text);
  if (length < 0 || length > 32) {
    fail("INVALID_PREFIX_LENGTH", `前缀长度越界: ${text}，允许范围为 0 到 32`);
  }
  return length;
}

export function parseCidr(cidr: unknown): ParsedCidr {
  if (typeof cidr !== "string" || !cidr.includes("/")) {
    fail("INVALID_CIDR", "CIDR 必须形如 0.0.0.0/0");
  }
  const text = cidr;
  const cidrText = text as string;
  const index = cidrText.lastIndexOf("/");
  const addressText = cidrText.slice(0, index);
  const lengthText = cidrText.slice(index + 1);
  const address = parseIpv4(addressText);
  const prefixLength = parsePrefixLength(lengthText);
  const network = (address & prefixMask(prefixLength)) >>> 0;
  const normalizedCidr = `${formatIpv4(network)}/${prefixLength}`;
  return {
    cidr: normalizedCidr,
    network,
    prefixLength,
    inputAddress: addressText,
    normalized: normalizedCidr !== cidrText
  };
}

export function bitAt(value: number, position: number): 0 | 1 {
  return ((value >>> (31 - position)) & 1) as 0 | 1;
}
