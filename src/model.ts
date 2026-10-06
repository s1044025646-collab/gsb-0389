import {
  formatIPv4,
  IpError,
  parseCidrStrict,
  parseIPv4Strict,
} from "./ip.ts";

export type RouteAction = "forward" | "drop";

export interface Route {
  id: string;
  cidr: string;
  network: bigint;
  prefixLen: number;
  metric: number;
  enabled: boolean;
  action: RouteAction;
  nextHop: string | null;
}

export interface RouteInput {
  id: string;
  cidr: string;
  metric?: number;
  enabled?: boolean;
  action?: RouteAction;
  nextHop?: string | null;
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** 校验并规范化一条路由输入，CIDR 主机位会被清零并回传规范化信息 */
export function validateRoute(input: RouteInput): {
  route: Omit<Route, never>;
  normalizedCidr: string;
  hadHostBits: boolean;
} {
  if (!isNonEmptyString(input.id) || !/^[A-Za-z0-9:_-]{1,64}$/.test(input.id.trim())) {
    throw new IpError("INVALID_ID", "路由编号必须为 1..64 位字母数字/_-/: 且非空");
  }
  const id = input.id.trim();
  if (!isNonEmptyString(input.cidr)) {
    throw new IpError("CIDR_REQUIRED", "cidr 必填");
  }
  const parsed = parseCidrStrict(input.cidr);

  const metric = input.metric ?? 0;
  if (typeof metric !== "number" || !Number.isInteger(metric) || metric < 0 || metric > 0xffffffff) {
    throw new IpError("INVALID_METRIC", `metric 必须为 0..${0xffffffff} 的非负整数`);
  }

  const enabled = input.enabled ?? true;
  if (typeof enabled !== "boolean") {
    throw new IpError("INVALID_ENABLED", "enabled 必须为布尔值");
  }

  const action: RouteAction = input.action ?? "forward";
  if (action !== "forward" && action !== "drop") {
    throw new IpError("INVALID_ACTION", "action 只能为 forward 或 drop");
  }

  let nextHop: string | null = input.nextHop ?? null;
  if (action === "forward") {
    if (!isNonEmptyString(nextHop)) {
      throw new IpError("NEXTHOP_REQUIRED", "forward 路由必须提供合法 IPv4 下一跳");
    }
    nextHop = formatIPv4(parseIPv4Strict(nextHop));
  } else {
    if (nextHop !== null && nextHop !== undefined && `${nextHop}`.trim() !== "") {
      throw new IpError("NEXTHOP_FORBIDDEN", "drop 路由不能携带下一跳");
    }
    nextHop = null;
  }

  return {
    normalizedCidr: parsed.normalizedCidr,
    hadHostBits: parsed.hadHostBits,
    route: {
      id,
      cidr: parsed.normalizedCidr,
      network: parsed.network,
      prefixLen: parsed.prefixLen,
      metric,
      enabled,
      action,
      nextHop,
    },
  };
}
