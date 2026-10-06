import { fail, AppError } from "./errors";
import { formatIpv4, parseCidr, parseIpv4 } from "./ipv4";
import { NormalizedRouteInput, RouteAction, RouteInput } from "./types";

export const MAX_ROUTES = 10000;
export const MAX_BATCH_SIZE = 1000;
export const MAX_METRIC = 0xffffffff;

function parseNonNegativeInteger(value: unknown, field: string, max: number): number {
  if (typeof value === "boolean" || (typeof value !== "number" && typeof value !== "string")) {
    fail("INVALID_FIELD", `${field} 必须是非负整数`);
  }
  const text = String(value).trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    fail("INVALID_FIELD", `${field} 必须是不带前导零的非负整数`);
  }
  const result = Number(text);
  if (!Number.isSafeInteger(result) || result < 0 || result > max) {
    fail("INVALID_FIELD", `${field} 超出允许范围: 0..${max}`);
  }
  return result;
}

function parseEnabled(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") {
    throw new AppError("INVALID_FIELD", "enabled 必须是布尔值", 400);
  }
  return value;
}

export function normalizeRouteInput(input: RouteInput): NormalizedRouteInput {
  if (!input || typeof input !== "object") {
    fail("INVALID_ROUTE", "路由条目必须是对象");
  }
  const rawId = input.routeId ?? input.id;
  const routeId = parseNonNegativeInteger(rawId, "routeId", MAX_ROUTES);
  const rawCidr = input.cidr ?? input.prefix;
  const cidrInfo = parseCidr(rawCidr);
  const metric = parseNonNegativeInteger(input.metric, "metric", MAX_METRIC);
  const enabled = parseEnabled(input.enabled);
  const actionText = input.action;
  if (actionText !== "forward" && actionText !== "drop") {
    fail("INVALID_ACTION", "action 只允许为 forward 或 drop");
  }
  const action = actionText as RouteAction;

  let nextHop: string | null = null;
  if (action === "forward") {
    if (typeof input.nextHop !== "string" || input.nextHop.length === 0) {
      fail("MISSING_NEXT_HOP", "forward 路由必须提供合法 IPv4 nextHop");
    }
    nextHop = formatIpv4(parseIpv4(input.nextHop));
  } else if (input.nextHop !== undefined && input.nextHop !== null) {
    fail("DROP_HAS_NEXT_HOP", "drop 路由不能携带 nextHop");
  }

  return {
    routeId,
    cidr: cidrInfo.cidr,
    network: cidrInfo.network,
    prefixLength: cidrInfo.prefixLength,
    metric,
    enabled,
    action,
    nextHop,
    inputCidr: String(rawCidr),
    cidrWasNormalized: cidrInfo.normalized
  };
}

export function assertBatchSize<T>(items: T[]): T[] {
  if (!Array.isArray(items)) {
    fail("INVALID_BATCH", "批量条目必须是数组");
  }
  if (items.length === 0) {
    fail("EMPTY_BATCH", "批量条目不能为空");
  }
  if (items.length > MAX_BATCH_SIZE) {
    throw new AppError(
      "BATCH_TOO_LARGE",
      `批量条目最多 ${MAX_BATCH_SIZE} 条，实际 ${items.length} 条`,
      413
    );
  }
  return items;
}
