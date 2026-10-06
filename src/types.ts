export type RouteAction = "forward" | "drop";

export interface Route {
  routeId: number;
  cidr: string;
  network: number;
  prefixLength: number;
  metric: number;
  enabled: boolean;
  action: RouteAction;
  nextHop: string | null;
}

export interface RouteInput {
  routeId?: unknown;
  id?: unknown;
  cidr?: unknown;
  prefix?: unknown;
  metric?: unknown;
  enabled?: unknown;
  action?: unknown;
  nextHop?: unknown;
}

export interface NormalizedRouteInput {
  routeId: number;
  cidr: string;
  network: number;
  prefixLength: number;
  metric: number;
  enabled: boolean;
  action: RouteAction;
  nextHop: string | null;
  inputCidr: string;
  cidrWasNormalized: boolean;
}

export interface RouteCandidate extends Route {
  samePrefixRank: number;
  tieBreakReason: string;
}

export interface RouteLayer {
  depth: number;
  prefix: string;
  chosenRouteId: number | null;
  enabledCandidates: RouteCandidate[];
  skippedDisabledRoutes: number[];
  decision: "selected-longest-prefix" | "not-longest-prefix" | "no-enabled-route";
  decisionReason: string;
}

export interface LookupResult {
  destination: string;
  version: number;
  outcome: "forward" | "drop" | "no-route";
  selectedRouteId: number | null;
  matchedPrefix: string | null;
  nextHop: string | null;
  metric: number | null;
  explanation: {
    algorithm: string;
    visitedDepths: number[];
    layers: RouteLayer[];
    selectedLayerDepth: number | null;
    notConsideredOutsidePath: string;
  };
}
