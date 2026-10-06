import test from "node:test";
import assert from "node:assert/strict";
import { parseIpv4 } from "../ipv4";
import { RouteTrie } from "../trie";
import { Route } from "../types";

const route = (partial: Partial<Route> & Pick<Route, "routeId" | "cidr" | "network" | "prefixLength">): Route => ({
  metric: 0,
  enabled: true,
  action: "forward",
  nextHop: "192.0.2.1",
  ...partial
});

test("最长前缀优先于低 metric 默认路由，drop 不退回 forward", () => {
  const trie = new RouteTrie([
    route({ routeId: 1, cidr: "0.0.0.0/0", network: 0, prefixLength: 0, metric: 1 }),
    route({ routeId: 2, cidr: "10.0.0.0/8", network: 0x0a000000, prefixLength: 8, metric: 9 }),
    route({ routeId: 3, cidr: "10.1.0.0/16", network: 0x0a010000, prefixLength: 16, metric: 8 }),
    route({ routeId: 4, cidr: "10.1.2.0/24", network: 0x0a010200, prefixLength: 24, metric: 100, action: "drop", nextHop: null })
  ]);
  const dropped = trie.lookup(parseIpv4("10.1.2.9"), "10.1.2.9", 1);
  const forwarded = trie.lookup(parseIpv4("10.1.3.9"), "10.1.3.9", 1);
  assert.equal(dropped.outcome, "drop");
  assert.equal(dropped.matchedPrefix, "10.1.2.0/24");
  assert.equal(forwarded.selectedRouteId, 3);
  assert.equal(forwarded.nextHop, "192.0.2.1");
});

test("同前缀按 metric 后按编号稳定决胜", () => {
  const trie = new RouteTrie([
    route({ routeId: 8, cidr: "10.0.0.0/8", network: 0x0a000000, prefixLength: 8, metric: 5 }),
    route({ routeId: 2, cidr: "10.0.0.0/8", network: 0x0a000000, prefixLength: 8, metric: 5 }),
    route({ routeId: 5, cidr: "10.0.0.0/8", network: 0x0a000000, prefixLength: 8, metric: 2 })
  ]);
  const result = trie.lookup(parseIpv4("10.9.9.9"), "10.9.9.9", 1);
  assert.equal(result.selectedRouteId, 5);
  assert.deepEqual(result.explanation.layers[0].enabledCandidates.map((item) => item.routeId), [5, 2, 8]);
});

test("/32 仅匹配一个地址，/0 作为根兜底，全禁用返回无路由", () => {
  const trie = new RouteTrie([
    route({ routeId: 1, cidr: "0.0.0.0/0", network: 0, prefixLength: 0 }),
    route({ routeId: 2, cidr: "192.0.2.1/32", network: parseIpv4("192.0.2.1"), prefixLength: 32, enabled: false })
  ]);
  assert.equal(trie.lookup(parseIpv4("192.0.2.1"), "192.0.2.1", 1).selectedRouteId, 1);
  const onlyRoot = new RouteTrie([
    route({ routeId: 1, cidr: "0.0.0.0/0", network: 0, prefixLength: 0, enabled: false })
  ]);
  assert.equal(onlyRoot.lookup(parseIpv4("255.255.255.255"), "255.255.255.255", 1).outcome, "no-route");
});

test("首末地址为普通地址且删除父子互不影响", () => {
  const child = route({ routeId: 2, cidr: "0.0.0.0/32", network: 0, prefixLength: 32 });
  const parent = route({ routeId: 1, cidr: "0.0.0.0/0", network: 0, prefixLength: 0 });
  const both = new RouteTrie([parent, child]);
  assert.equal(both.lookup(0, "0.0.0.0", 1).selectedRouteId, 2);
  assert.equal(new RouteTrie([parent]).lookup(0, "0.0.0.0", 1).selectedRouteId, 1);
  assert.equal(new RouteTrie([child]).lookup(parseIpv4("255.255.255.255"), "255.255.255.255", 1).outcome, "no-route");
});
