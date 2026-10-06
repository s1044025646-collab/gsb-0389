import { formatIpv4, prefixMask } from "./ipv4";
import { LookupResult, Route } from "./types";

export function linearScanLookup(
  routes: Route[],
  destination: number,
  destinationText: string,
  version: number
): Pick<LookupResult, "outcome" | "selectedRouteId" | "matchedPrefix" | "nextHop" | "metric"> {
  const matching = routes
    .filter((route) => {
      const mask = prefixMask(route.prefixLength);
      return route.enabled && ((route.network & mask) >>> 0) === ((destination & mask) >>> 0);
    })
    .sort((left, right) =>
      right.prefixLength - left.prefixLength ||
      left.metric - right.metric ||
      left.routeId - right.routeId
    );
  const selected = matching[0];
  return {
    outcome: selected ? selected.action : "no-route",
    selectedRouteId: selected?.routeId ?? null,
    matchedPrefix: selected ? selected.cidr : null,
    nextHop: selected?.nextHop ?? null,
    metric: selected?.metric ?? null
  };
}

export function randomIpv4(random: () => number = Math.random): string {
  return formatIpv4(Math.floor(random() * 0x100000000) >>> 0);
}
