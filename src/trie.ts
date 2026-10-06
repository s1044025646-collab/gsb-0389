import { bitAt, formatIpv4 } from "./ipv4";
import { LookupResult, Route, RouteCandidate, RouteLayer } from "./types";

interface TrieNode {
  children: [TrieNode | null, TrieNode | null];
  routes: Route[];
  routeCount: number;
}

export interface TriePathNode {
  depth: number;
  bit: 0 | 1 | null;
  prefix: string;
  network: number;
  routeCount: number;
  enabledRouteCount: number;
  routeIds: number[];
}

function makeNode(): TrieNode {
  return { children: [null, null], routes: [], routeCount: 0 };
}

function rankRoutes(routes: Route[]): RouteCandidate[] {
  return routes
    .filter((route) => route.enabled)
    .sort((left, right) => left.metric - right.metric || left.routeId - right.routeId)
    .map((route, samePrefixRank) => ({
      ...route,
      samePrefixRank,
      tieBreakReason:
        samePrefixRank === 0
          ? "同前缀启用路由中 metric 最小；metric 相同则编号最小"
          : `metric/编号排序第 ${samePrefixRank + 1}，未在本层胜出`
    }));
}

export class RouteTrie {
  private readonly root = makeNode();
  private totalRoutes = 0;

  constructor(routes: Route[] = []) {
    for (const route of routes) this.insert(route);
  }

  get size(): number {
    return this.totalRoutes;
  }

  insert(route: Route): void {
    let node = this.root;
    for (let depth = 0; depth < route.prefixLength; depth += 1) {
      const bit = bitAt(route.network, depth);
      const next = node.children[bit] ?? makeNode();
      node.children[bit] = next;
      node = next;
    }
    node.routes.push(route);
    this.refreshNode(node);
    this.totalRoutes += 1;
  }

  private refreshNode(node: TrieNode): void {
    node.routes.sort((left, right) => left.routeId - right.routeId);
    node.routeCount = node.routes.length;
  }

  private walk(destination: number): TrieNode[] {
    const nodes = [this.root];
    let node = this.root;
    for (let depth = 0; depth < 32; depth += 1) {
      const next = node.children[bitAt(destination, depth)];
      if (!next) break;
      node = next;
      nodes.push(node);
    }
    return nodes;
  }

  treePath(destination: number): TriePathNode[] {
    const nodes = this.walk(destination);
    return nodes.map((node, depth) => {
      const prefixLength = depth;
      const network = prefixLength === 0
        ? 0
        : (destination & ((0xffffffff << (32 - prefixLength)) >>> 0)) >>> 0;
      return {
        depth,
        bit: depth === 0 ? null : bitAt(destination, depth - 1),
        prefix: `${formatIpv4(network)}/${depth}`,
        network,
        routeCount: node.routes.length,
        enabledRouteCount: node.routes.filter((route) => route.enabled).length,
        routeIds: node.routes.map((route) => route.routeId)
      };
    });
  }

  lookup(destination: number, destinationText: string, version: number): LookupResult {
    const nodes = this.walk(destination);
    const layers: RouteLayer[] = [];
    const visitedDepths: number[] = [];
    let selectedLayer = null as RouteLayer | null;

    nodes.forEach((node, depth) => {
      if (node.routes.length === 0) return;
      visitedDepths.push(depth);
      const enabledCandidates = rankRoutes(node.routes);
      const winner = enabledCandidates[0] ?? null;
      const prefixLength = depth;
      const network = prefixLength === 0
        ? 0
        : (destination & ((0xffffffff << (32 - prefixLength)) >>> 0)) >>> 0;
      let decision: RouteLayer["decision"];
      let decisionReason: string;
      if (!winner) {
        decision = "no-enabled-route";
        decisionReason = "该命中前缀上的所有路由均被禁用，继续查看祖先候选";
      } else {
        decision = "not-longest-prefix";
        decisionReason = "已记录为有效候选；若更长前缀无启用候选才回退到该层";
      }
      const layer: RouteLayer = {
        depth,
        prefix: `${formatIpv4(network)}/${depth}`,
        chosenRouteId: winner?.routeId ?? null,
        enabledCandidates,
        skippedDisabledRoutes: node.routes
          .filter((route) => !route.enabled)
          .map((route) => route.routeId),
        decision,
        decisionReason
      };
      layers.push(layer);
      if (winner) selectedLayer = layer;
    });

    if (selectedLayer) {
      selectedLayer.decision = "selected-longest-prefix";
      selectedLayer.decisionReason =
        "这是搜索路径上含启用路由的最深节点；最长前缀优先于较小 metric";
    }
    const selected = selectedLayer?.enabledCandidates[0] ?? null;

    return {
      destination: destinationText,
      version,
      outcome: selected ? selected.action : "no-route",
      selectedRouteId: selected?.routeId ?? null,
      matchedPrefix: selectedLayer?.prefix ?? null,
      nextHop: selected?.nextHop ?? null,
      metric: selected?.metric ?? null,
      explanation: {
        algorithm: "按目的 IPv4 从高位到低位遍历二进制前缀树；只记录实际经过节点上的路由",
        visitedDepths,
        layers,
        selectedLayerDepth: selectedLayer?.depth ?? null,
        notConsideredOutsidePath:
          "不在目的地址位路径上的路由未参与匹配，也不会出现在竞争者列表中"
      }
    };
  }
}
