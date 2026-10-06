import { randomUUID } from "node:crypto";
import { AppError, fail } from "./errors";
import { RouteDatabase, TableRow } from "./db";
import { parseIpv4 } from "./ipv4";
import {
  MAX_BATCH_SIZE,
  MAX_ROUTES,
  normalizeRouteInput
} from "./route";
import { linearScanLookup } from "./scanner";
import { RouteTrie } from "./trie";
import { NormalizedRouteInput, Route, RouteInput } from "./types";

export interface CreateTableInput {
  name?: unknown;
}

export interface MutationInput {
  expectedVersion?: unknown;
}

export interface LookupQuery {
  destination?: unknown;
  address?: unknown;
  version?: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

function expectedVersion(value: unknown): number {
  if (value === undefined) {
    fail("EXPECTED_VERSION_REQUIRED", "写操作必须提供 expectedVersion", 409);
  }
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    fail("INVALID_EXPECTED_VERSION", "expectedVersion 必须是非负整数", 409);
  }
  return Number(text);
}

export class RouteService {
  private readonly caches = new Map<string, Map<number, RouteTrie>>();

  constructor(private readonly database: RouteDatabase) {}

  createTable(input: CreateTableInput = {}) {
    const name = input.name === undefined ? "default" : input.name;
    if (typeof name !== "string" || (name as unknown) === null || name.trim().length === 0 || name.length > 100) {
      fail("INVALID_NAME", "路由表名称必须是 1 到 100 个字符");
    }
    const tableId = randomUUID();
    return this.database.createTable(tableId, (name as string).trim(), nowIso());
  }

  listTables() {
    return this.database.listTables();
  }

  getTable(tableId: string): TableRow {
    const table = this.database.getTable(tableId);
    if (!table) throw new AppError("ROUTE_TABLE_NOT_FOUND", "路由表不存在", 404);
    return table;
  }

  listVersions(tableId: string) {
    this.getTable(tableId);
    return { versions: this.database.listVersions(tableId) };
  }

  snapshot(tableId: string, requestedVersion?: unknown) {
    const table = this.getTable(tableId);
    if (requestedVersion !== undefined) {
      const version = this.resolveReadVersion(tableId, requestedVersion);
      return { version, routes: this.database.getSnapshotRoutes(tableId, version) };
    }
    return { version: Number(table.version), routes: this.database.getCurrentRoutes(tableId) };
  }

  treePath(tableId: string, destinationText: unknown, requestedVersion?: unknown) {
    const table = this.getTable(tableId);
    const version = this.resolveReadVersion(tableId, requestedVersion);
    const destination = parseIpv4(destinationText);
    const trie = this.getTrie(tableId, version);
    return {
      destination: String(destinationText),
      version,
      path: trie.treePath(destination)
    };
  }

  importRoutes(tableId: string, routes: unknown, mutation: MutationInput = {}) {
    const table = this.getTable(tableId);
    const wanted = expectedVersion(mutation.expectedVersion);
    if (!Array.isArray(routes) || routes.length === 0) {
      fail("INVALID_BATCH", "批量导入必须提供非空 routes 数组");
    }
    const routeItems = routes as unknown[];
    if (routeItems.length > MAX_BATCH_SIZE) {
      throw new AppError(
        "BATCH_TOO_LARGE",
        `批量条目最多 ${MAX_BATCH_SIZE} 条，实际 ${routeItems.length} 条`,
        413
      );
    }
    const normalized: Array<NormalizedRouteInput & { index: number }> = [];
    const seen = new Set<number>();
    const errors: Array<{ index: number; code: string; message: string }> = [];
    routeItems.forEach((item, index) => {
      try {
        const route = normalizeRouteInput(item as RouteInput);
        if (seen.has(route.routeId) || this.database.getRoute(tableId, route.routeId)) {
          throw new AppError("DUPLICATE_ROUTE_ID", `路由编号 ${route.routeId} 重复`, 409);
        }
        seen.add(route.routeId);
        normalized.push({ ...route, index });
      } catch (error) {
        if (error instanceof AppError) {
          errors.push({ index, code: error.code, message: error.message });
        } else {
          throw error;
        }
      }
    });
    if (errors.length > 0) {
      throw new AppError(
        "BATCH_VALIDATION_FAILED",
        `批量导入中有 ${errors.length} 条非法条目，整批已拒绝`,
        400,
        { errors }
      );
    }

    this.database.transaction(() => {
      const current = Number(table.version);
      if (wanted !== current) {
        throw new AppError(
          "VERSION_CONFLICT",
          `expectedVersion=${wanted}，当前版本=${current}`,
          409
        );
      }
      const total = this.database.countRoutes(tableId);
      if (total + normalized.length > MAX_ROUTES) {
        throw new AppError("ROUTE_LIMIT_EXCEEDED", `路由数最多 ${MAX_ROUTES}`, 413);
      }
      for (const route of normalized) this.database.insertRoute(tableId, route);
      this.database.commitVersion(tableId, current + 1, nowIso());
    });
    this.caches.delete(tableId);
    return this.afterMutation(tableId, {
      imported: normalized.map((route) => ({
        routeId: route.routeId,
        requestedCidr: route.inputCidr,
        normalizedCidr: route.cidr,
        cidrWasNormalized: route.cidrWasNormalized
      }))
    });
  }

  deleteRoute(tableId: string, routeId: unknown, mutation: MutationInput) {
    const parsedId = this.normalizeRouteId(routeId);
    this.commit(tableId, mutation, (txTable) => {
      if (!this.database.getRoute(tableId, parsedId)) {
        throw new AppError("ROUTE_NOT_FOUND", `路由 ${parsedId} 不存在`, 404);
      }
      return txTable;
    }, () => this.database.deleteRoute(tableId, parsedId));
    return this.afterMutation(tableId, { deletedRouteId: parsedId });
  }

  setEnabled(tableId: string, routeId: unknown, enabled: boolean, mutation: MutationInput) {
    const parsedId = this.normalizeRouteId(routeId);
    this.commit(tableId, mutation, (txTable) => {
      if (!this.database.getRoute(tableId, parsedId)) {
        throw new AppError("ROUTE_NOT_FOUND", `路由 ${parsedId} 不存在`, 404);
      }
      return txTable;
    }, () => this.database.setRouteEnabled(tableId, parsedId, enabled));
    return this.afterMutation(tableId, { routeId: parsedId, enabled });
  }

  updateMetric(tableId: string, routeId: unknown, metric: unknown, mutation: MutationInput) {
    const parsedId = this.normalizeRouteId(routeId);
    const parsedMetric = normalizeMetric(metric);
    this.commit(tableId, mutation, () => undefined, () => {
      if (!this.database.getRoute(tableId, parsedId)) {
        throw new AppError("ROUTE_NOT_FOUND", `路由 ${parsedId} 不存在`, 404);
      }
      this.database.setMetric(tableId, parsedId, parsedMetric);
    });
    return this.afterMutation(tableId, { routeId: parsedId, metric: parsedMetric });
  }

  lookup(tableId: string, query: LookupQuery) {
    const table = this.getTable(tableId);
    const version = this.resolveReadVersion(tableId, query.version);
    const destinationText = query.destination ?? query.address;
    const destination = parseIpv4(destinationText);
    return this.getTrie(tableId, version).lookup(destination, String(destinationText), version);
  }

  batchLookup(tableId: string, destinations: unknown, requestedVersion?: unknown) {
    this.getTable(tableId);
    if (!Array.isArray(destinations) || destinations.length === 0) {
      fail("INVALID_BATCH", "批量查询必须提供非空 destinations 数组");
    }
    const destinationItems = destinations as unknown[];
    if (destinationItems.length > MAX_BATCH_SIZE) {
      throw new AppError("BATCH_TOO_LARGE", `批量查询最多 ${MAX_BATCH_SIZE} 项`, 413);
    }
    const version = this.resolveReadVersion(tableId, requestedVersion);
    const trie = this.getTrie(tableId, version);
    const results = destinationItems.map((destination) => {
      const value = parseIpv4(destination);
      return trie.lookup(value, String(destination), version);
    });
    return { version, results };
  }

  verifyWithLinearScan(tableId: string, destinations: string[], version?: number) {
    const usedVersion = version ?? Number(this.getTable(tableId).version);
    const routes = this.database.getSnapshotRoutes(tableId, usedVersion);
    const trie = new RouteTrie(routes);
    return destinations.map((destinationText) => {
      const destination = parseIpv4(destinationText);
      const trieResult = trie.lookup(destination, destinationText, usedVersion);
      const scanResult = linearScanLookup(routes, destination, destinationText, usedVersion);
      return {
        destination: destinationText,
        trie: trieResult,
        linearScan: scanResult,
        matches:
          trieResult.outcome === scanResult.outcome &&
          trieResult.selectedRouteId === scanResult.selectedRouteId &&
          trieResult.nextHop === scanResult.nextHop &&
          trieResult.metric === scanResult.metric
      };
    });
  }

  private commit(
    tableId: string,
    mutation: MutationInput,
    beforeChange: (table: { version: number }) => unknown,
    change: () => void
  ): void {
    const table = this.getTable(tableId);
    const wanted = expectedVersion(mutation.expectedVersion);
    this.database.transaction(() => {
      const currentTable = this.database.getTableOrThrow(tableId);
      const current = Number(currentTable.version);
      if (wanted !== current) {
        throw new AppError(
          "VERSION_CONFLICT",
          `expectedVersion=${wanted}，当前版本=${current}`,
          409
        );
      }
      beforeChange({ version: current });
      change();
      this.database.commitVersion(tableId, current + 1, nowIso());
    });
    this.caches.delete(tableId);
  }

  private afterMutation(tableId: string, extra: Record<string, unknown>) {
    const table = this.getTable(tableId);
    return {
      version: Number(table.version),
      routeCount: this.database.countRoutes(tableId),
      ...extra
    };
  }

  private normalizeRouteId(value: unknown): number {
    if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) return Number(value);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_ROUTES) {
      fail("INVALID_ROUTE_ID", "路由编号必须是 0 到 10000 的非负整数");
    }
    return value as number;
  }

  private resolveReadVersion(tableId: string, value: unknown): number {
    const table = this.getTable(tableId);
    if (value === undefined || value === null) return Number(table.version);
    const text = String(value);
    if (!/^(0|[1-9]\d*)$/.test(text)) {
      fail("INVALID_VERSION", "version 必须是非负整数");
    }
    const version = Number(text);
    const current = Number(table.version);
    if (version > current || version < 0) {
      fail("VERSION_NOT_FOUND", `版本 ${version} 不存在；当前版本 ${current}`, 404);
    }
    return version;
  }

  private getTrie(tableId: string, version: number): RouteTrie {
    const routes =
      version === 0
        ? []
        : this.database.getSnapshotRoutes(tableId, version);
    const cached = this.caches.get(tableId);
    if (cached?.has(version)) return cached.get(version)!;
    const trie = new RouteTrie(routes);
    const tableCache: Map<number, RouteTrie> = cached ?? new Map<number, RouteTrie>();
    tableCache.set(version, trie);
    this.caches.set(tableId, tableCache);
    return trie;
  }
}

export function normalizeMetric(value: unknown): number {
  if (typeof value === "boolean" || (typeof value !== "number" && typeof value !== "string")) {
    fail("INVALID_METRIC", "metric 必须是非负整数");
  }
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    fail("INVALID_METRIC", "metric 必须是不带前导零的非负整数");
  }
  const metric = Number(text);
  if (!Number.isSafeInteger(metric) || metric < 0 || metric > 0xffffffff) {
    fail("INVALID_METRIC", "metric 允许范围为 0 到 4294967295");
  }
  return metric;
}
