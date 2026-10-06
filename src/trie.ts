import type { Route } from "./model.ts";
import { formatIPv4 } from "./ip.ts";

/**
 * 自建二进制前缀树（radix-2 trie）。
 * 根节点深度 0 = /0；深度 k 的节点代表 k 位前缀。
 * 查询严格沿目的地址的位序下行，最多 32 步，不扫描全表。
 */

export interface TrieNode {
  depth: number;
  /** 该节点代表的前缀网络地址（用于展示） */
  network: bigint;
  routes: Route[];
  children: [TrieNode | null, TrieNode | null];
}

export function createTrie(): TrieNode {
  return { depth: 0, network: 0n, routes: [], children: [null, null] };
}

export function insertRoute(root: TrieNode, route: Route): void {
  let node = root;
  for (let depth = 1; depth <= route.prefixLen; depth++) {
    const bit = Number((route.network >> BigInt(32 - depth)) & 1n);
    let child = node.children[bit];
    if (child === null) {
      const network =
        depth === 0 ? 0n : route.network & ((((1n << BigInt(depth)) - 1n) << BigInt(32 - depth)));
      child = { depth, network, routes: [], children: [null, null] };
      node.children[bit] = child;
    }
    node = child!;
  }
  node.routes.push(route);
}

/** 同节点决胜：metric 升序，再按编号字典序升序，稳定 */
export function pickWinner(routes: Route[]): Route | null {
  const enabled = routes.filter((r) => r.enabled);
  if (enabled.length === 0) return null;
  return enabled.reduce((best, cur) => {
    if (cur.metric < best.metric) return cur;
    if (cur.metric === best.metric && cur.id < best.id) return cur;
    return best;
  });
}

export interface LayerVisit {
  depth: number;
  cidr: string;
  enabled: Array<{ id: string; metric: number; action: string; nextHop: string | null }>;
  disabled: Array<{ id: string; metric: number }>;
  /** 同前缀启用路由的决胜依据说明 */
  decision: string | null;
  winnerId: string | null;
}

export interface LookupOutcome {
  destination: string;
  result: "forward" | "drop" | "no-route";
  prefix: string | null;
  routeId: string | null;
  nextHop: string | null;
  metric: number | null;
  /** 从根到最终命中层经过的、实际存在的节点（含 /0 根） */
  visited: LayerVisit[];
  /** 为什么选它 */
  reason: string;
  /** 为什么更短的候选没有采用 */
  rejectedShorts: Array<{ cidr: string; routeId: string; why: string }>;
}

/**
 * 沿目的地址位序查找。记录路径上每个存在节点的启用候选，
 * 取前缀长度最大的有效层（最长前缀优先；不比较跨层 metric）。
 */
export function lookup(root: TrieNode, destination: bigint): LookupOutcome {
  const destStr = formatIPv4(destination);
  const visited: LayerVisit[] = [];
  const enabledLayers: Array<{ node: TrieNode; winner: Route }> = [];

  let node = root;
  for (let depth = 0; depth <= 32; depth++) {
    if (node.routes.length > 0) {
      const enabled = node.routes
        .filter((r) => r.enabled)
        .sort(routeTieOrder);
      const disabled = node.routes
        .filter((r) => !r.enabled)
        .sort(routeTieOrder);
      const winner = enabled.length > 0 ? enabled[0]! : null;
      let decision: string | null = null;
      if (enabled.length > 1) {
        const minMetric = enabled[0]!.metric;
        const tied = enabled.filter((r) => r.metric === minMetric);
        decision =
          tied.length > 1
            ? `同前缀 ${enabled.length} 条启用路由 metric 并列最小值 ${minMetric}，按编号稳定排序选中 ${winner!.id}`
            : `同前缀 ${enabled.length} 条启用路由，最小 metric ${minMetric} 胜出（${winner!.id}）`;
      }
      const visit: LayerVisit = {
        depth,
        cidr: `${formatIPv4(node.network)}/${depth}`,
        enabled: enabled.map(summarize),
        disabled: disabled.map((r) => ({ id: r.id, metric: r.metric })),
        decision,
        winnerId: winner?.id ?? null,
      };
      visited.push(visit);
      if (winner) enabledLayers.push({ node, winner });
    }
    if (depth === 32) break;
    const bit = Number((destination >> BigInt(31 - depth)) & 1n);
    const child = node.children[bit];
    if (child === null) break;
    node = child!;
  }

  if (enabledLayers.length === 0) {
    return {
      destination: destStr,
      result: "no-route",
      prefix: null,
      routeId: null,
      nextHop: null,
      metric: null,
      visited,
      reason: "搜索路径上没有任何启用的匹配前缀",
      rejectedShorts: [],
    };
  }

  const best = enabledLayers[enabledLayers.length - 1]!;
  const rejectedShorts = enabledLayers.slice(0, -1).map(({ node, winner }) => ({
    cidr: `${formatIPv4(node.network)}/${node.depth}`,
    routeId: winner.id,
    why: `前缀长度 /${node.depth} 短于命中的 /${best.node.depth}，最长前缀匹配优先，metric 不参与跨层比较`,
  }));

  return {
    destination: destStr,
    result: best.winner.action,
    prefix: `${formatIPv4(best.node.network)}/${best.node.depth}`,
    routeId: best.winner.id,
    nextHop: best.winner.nextHop,
    metric: best.winner.metric,
    visited,
    reason:
      best.winner.action === "drop"
        ? `命中最长前缀 ${formatIPv4(best.node.network)}/${best.node.depth} 的 drop 规则，直接丢弃，不回退到更短的 forward`
        : `命中最长前缀 ${formatIPv4(best.node.network)}/${best.node.depth}，转发至下一跳 ${best.winner.nextHop}`,
    rejectedShorts,
  };
}

function routeTieOrder(a: Route, b: Route): number {
  if (a.metric !== b.metric) return a.metric - b.metric;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function summarize(r: Route) {
  return { id: r.id, metric: r.metric, action: r.action, nextHop: r.nextHop };
}

/** 导出树中真实存在的节点路径（供“查看树路径”） */
export interface TreeNodeView {
  cidr: string;
  depth: number;
  routeIds: string[];
  children: [TreeNodeView | null, TreeNodeView | null];
}

export function viewTree(root: TrieNode): TreeNodeView {
  const map = (n: TrieNode): TreeNodeView => ({
    cidr: `${formatIPv4(n.network)}/${n.depth}`,
    depth: n.depth,
    routeIds: n.routes.map((r) => r.id),
    children: [n.children[0] ? map(n.children[0]) : null, n.children[1] ? map(n.children[1]) : null],
  });
  return map(root);
}

/** 从路由集合重建整棵树（启动/按版本复现用） */
export function buildTrie(routes: Route[]): TrieNode {
  const root = createTrie();
  for (const r of [...routes].sort((a, b) =>
    a.prefixLen !== b.prefixLen
      ? a.prefixLen - b.prefixLen
      : a.network !== b.network
        ? a.network < b.network
          ? -1
          : 1
        : routeTieOrder(a, b),
  )) {
    insertRoute(root, r);
  }
  return root;
}
