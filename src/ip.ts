/**
 * IPv4 地址与 CIDR 的严格解析。全部按无符号 32 位整数处理，
 * 使用 BigInt 与 Math 比较，避免 JavaScript 有符号 32 位位运算
 * 以及 `<< 32` 移位未定义行为的影响。
 */

export const UINT32_MAX = (1n << 32n) - 1n;

/** 前缀长度 -> 掩码（高位 len 个 1） */
export function prefixMask(len: number): bigint {
  if (len <= 0) return 0n;
  return (UINT32_MAX << BigInt(32 - len)) & UINT32_MAX;
}

/**
 * 严格解析点分十进制 IPv4：必须恰好 4 个十进制八位组，每个 0..255。
 * 拒绝：空段、前导零歧义（如 01、00）、符号、十六进制/八进制写法、
 * 空白、非数字字符。
 */
export function parseIPv4Strict(text: string): bigint {
  if (typeof text !== "string") {
    throw new IpError("IP_INVALID", "IP 地址必须是字符串");
  }
  const s = text.trim();
  if (s.length === 0 || /\s/.test(text)) {
    throw new IpError("IP_INVALID", `非法 IPv4 地址：${text}`);
  }
  const parts = s.split(".");
  if (parts.length !== 4) {
    throw new IpError("IP_INVALID", `IPv4 必须包含 4 个八位组：${text}`);
  }
  let value = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]*)$/.test(part)) {
      throw new IpError("IP_INVALID", `非法八位组（禁止前导零或非数字）：${part}`);
    }
    const octet = Number(part);
    if (octet > 255) {
      throw new IpError("IP_INVALID", `八位组超出 0..255：${part}`);
    }
    value = ((value << 8n) | BigInt(octet)) & UINT32_MAX;
  }
  return value;
}

/** 无符号 32 位整数转回点分十进制 */
export function formatIPv4(value: bigint): string {
  return [24n, 16n, 8n, 0n]
    .map((shift) => Number((value >> shift) & 0xffn))
    .join(".");
}

export interface ParsedCidr {
  /** 规范化后的网络地址（主机位清零） */
  network: bigint;
  prefixLen: number;
  /** 用户输入中主机位是否非零（被规范化） */
  hadHostBits: boolean;
  normalizedCidr: string;
  /** 用户原始地址部分 */
  rawAddress: string;
}

/**
 * 严格解析 CIDR（a.b.c.d/len），len 必须为 0..32 的十进制整数。
 * 主机位非零时规范化为网络地址，并在结果中标注 hadHostBits。
 */
export function parseCidrStrict(text: string): ParsedCidr {
  if (typeof text !== "string" || text.length === 0 || /\s/.test(text)) {
    throw new IpError("CIDR_INVALID", `非法 CIDR：${text}`);
  }
  const slash = text.indexOf("/");
  if (slash < 0) {
    throw new IpError("CIDR_INVALID", `CIDR 必须包含 "/"：${text}`);
  }
  const rawAddress = text.slice(0, slash);
  const lenText = text.slice(slash + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(lenText)) {
    throw new IpError("PREFIX_LEN_INVALID", `前缀长度非法（禁止前导零/非数字）：${lenText}`);
  }
  const prefixLen = Number(lenText);
  if (prefixLen > 32) {
    throw new IpError("PREFIX_LEN_INVALID", `前缀长度超出 0..32：${prefixLen}`);
  }
  const address = parseIPv4Strict(rawAddress);
  const mask = prefixMask(prefixLen);
  const network = address & mask;
  const hadHostBits = address !== network;
  return {
    network,
    prefixLen,
    hadHostBits,
    normalizedCidr: `${formatIPv4(network)}/${prefixLen}`,
    rawAddress,
  };
}

export class IpError extends Error {
 code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "IpError";
    this.code = code;
  }
}
