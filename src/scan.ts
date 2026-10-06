import type { Route } from "./model.ts";
import { prefixMask, formatIPv4 } from "./ip.ts";

export interface ScanResult {
  result: "forward" | "drop" | "no-route";
  prefix: string | null;
  routeId: string | null;
  nextHop: string | null;
  metric: number | null;
}

/**
 * 独立基准：对所有路由做一次完整线性扫描。
 * 刻意不使用 trie，作为测试中校验 trie 查询结果的参照实现。
 */
export function linearScan(routes: Route[], destination: bigint): ScanResult {
  let bestLen = -1;
  let winners: Route[] = [];

  for (const r of routes) {
    if (!r.enabled) continue;
    if (r.prefixLen < bestLen) continue;
    if ((destination & prefixMask(r.prefixLen)) !== r.network) continue;
    if (r.prefixLen > bestLen) {
      bestLen = r.prefixLen;
      winners = [r];
    } else {
      winners.push(r);
    }
  }

  if (winners.length === 0) {
    return { result: "no-route", prefix: null, routeId: null, nextHop: null, metric: null };
  }
  winners.sort((a, b) =>
    a.metric !== b.metric ? a.metric - b.metric : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const w = winners[0]!;
  return {
    result: w.action,
    prefix: `${formatIPv4(w.network)}/${w.prefixLen}`,
    routeId: w.id,
    nextHop: w.nextHop,
    metric: w.metric,
  };
}
