import { Store, routeToRecord, type Snapshot } from "./storage.ts";
import { IpError, parseIPv4Strict } from "./ip.ts";
import { validateRoute, isNonEmptyString, type Route, type RouteInput } from "./model.ts";
import { buildTrie, lookup, viewTree, type LookupOutcome, type TreeNodeView } from "./trie.ts";

export const MAX_ROUTES = 5000;
export const MAX_BATCH = 1000;

export interface ImportReport {
  version: number;
  imported: number;
  normalizations: Array<{ id: string; inputCidr: string; normalizedCidr: string }>;
}

export class ServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

export class RouteService {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  createTable(id: string): { id: string; version: number } {
    assertId(id);
    return { id, version: this.store.createTable(id) };
  }

  listTables() {
    return this.store.listTables();
  }

  snapshot(tableId: string, atVersion?: number): Snapshot {
    return this.store.loadAtVersion(tableId, atVersion);
  }

  tree(tableId: string, atVersion?: number): { version: number; tree: TreeNodeView } {
    const snap = this.store.loadAtVersion(tableId, atVersion);
    return { version: snap.version, tree: viewTree(buildTrie(snap.routes)) };
  }

  upsert(tableId: string, input: RouteInput, expectedVersion: number): {
    version: number;
    normalizedCidr: string;
    hadHostBits: boolean;
  } {
    const { route, normalizedCidr, hadHostBits } = validateRoute(input);
    const snap = this.store.loadAtVersion(tableId);
    if (!snap.routes.some((r) => r.id === route.id) && snap.routes.length >= MAX_ROUTES) {
      throw new ServiceError("LIMIT_EXCEEDED", `路由数量已达上限 ${MAX_ROUTES}`);
    }
    const version = this.store.commit(tableId, expectedVersion, [
      { op: "upsert", routeId: route.id, payload: routeToRecord(route) },
    ]);
    return { version, normalizedCidr, hadHostBits };
  }

  /** 批量导入：整批原子，重复编号或任一条目非法则整体拒绝 */
  bulkImport(tableId: string, inputs: RouteInput[], expectedVersion: number): ImportReport {
    if (!Array.isArray(inputs)) throw new ServiceError("INVALID_BATCH", "批量条目必须为数组");
    if (inputs.length === 0) throw new ServiceError("INVALID_BATCH", "批量条目不能为空");
    if (inputs.length > MAX_BATCH) {
      throw new ServiceError("LIMIT_EXCEEDED", `单批最多 ${MAX_BATCH} 条，收到 ${inputs.length}`);
    }
    const seen = new Set<string>();
    const normalized: Array<{ route: Route; rawCidr: string; normCidr: string }> = [];
    const normalizations: ImportReport["normalizations"] = [];

    for (const item of inputs) {
      const { route, normalizedCidr, hadHostBits } = validateRoute(item);
      if (seen.has(route.id)) {
        throw new ServiceError("DUPLICATE_ID", `批量数据中编号重复：${route.id}`);
      }
      seen.add(route.id);
      normalized.push({ route, rawCidr: String(item.cidr), normCidr: normalizedCidr });
      if (hadHostBits) {
        normalizations.push({ id: route.id, inputCidr: String(item.cidr), normalizedCidr });
      }
    }

    const snap = this.store.loadAtVersion(tableId);
    const existing = new Set(snap.routes.map((r) => r.id));
    for (const { route } of normalized) {
      if (existing.has(route.id)) {
        throw new ServiceError("DUPLICATE_ID", `编号已存在（导入不能覆盖）：${route.id}`);
      }
    }
    if (snap.routes.length + normalized.length > MAX_ROUTES) {
      throw new ServiceError(
        "LIMIT_EXCEEDED",
        `导入后超过路由上限 ${MAX_ROUTES}（现有 ${snap.routes.length}，新增 ${normalized.length}）`,
      );
    }

    const events = normalized.map(({ route }) => ({
      op: "import",
      routeId: route.id,
      payload: routeToRecord(route),
    }));
    const version = this.store.commit(tableId, expectedVersion, events);
    return { version, imported: normalized.length, normalizations };
  }

  remove(tableId: string, routeId: string, expectedVersion: number): number {
    assertId(routeId);
    const snap = this.store.loadAtVersion(tableId);
    if (!snap.routes.some((r) => r.id === routeId)) {
      throw new ServiceError("ROUTE_NOT_FOUND", `路由不存在：${routeId}`);
    }
    return this.store.commit(tableId, expectedVersion, [{ op: "delete", routeId }]);
  }

  setEnabled(tableId: string, routeId: string, enabled: boolean, expectedVersion: number): number {
    assertId(routeId);
    const snap = this.store.loadAtVersion(tableId);
    if (!snap.routes.some((r) => r.id === routeId)) {
      throw new ServiceError("ROUTE_NOT_FOUND", `路由不存在：${routeId}`);
    }
    return this.store.commit(tableId, expectedVersion, [
      { op: "set-enabled", routeId, payload: { enabled } },
    ]);
  }

  setMetric(tableId: string, routeId: string, metric: number, expectedVersion: number): number {
    assertId(routeId);
    if (typeof metric !== "number" || !Number.isInteger(metric) || metric < 0 || metric > 0xffffffff) {
      throw new ServiceError("INVALID_METRIC", `metric 必须为 0..${0xffffffff} 的非负整数`);
    }
    const snap = this.store.loadAtVersion(tableId);
    if (!snap.routes.some((r) => r.id === routeId)) {
      throw new ServiceError("ROUTE_NOT_FOUND", `路由不存在：${routeId}`);
    }
    return this.store.commit(tableId, expectedVersion, [
      { op: "set-metric", routeId, payload: { metric } },
    ]);
  }

  /**
   * 查询。atVersion 必须显式指定；不传则使用当前版本，
   * 结果中明确标注所用版本，避免用最新树解释历史报告。
   */
  query(tableId: string, destinationText: string, atVersion?: number): LookupOutcome & {
    version: number;
  } {
    const destination = parseIPv4Strict(destinationText);
    const snap = this.store.loadAtVersion(tableId, atVersion);
    const outcome = lookup(buildTrie(snap.routes), destination);
    return { ...outcome, version: snap.version };
  }

  queryBatch(
    tableId: string,
    destinations: string[],
    atVersion?: number,
  ): { version: number; results: Array<LookupOutcome> } {
    if (!Array.isArray(destinations) || destinations.length === 0) {
      throw new ServiceError("INVALID_BATCH", "查询地址列表必须为非空数组");
    }
    if (destinations.length > MAX_BATCH) {
      throw new ServiceError("LIMIT_EXCEEDED", `单次查询最多 ${MAX_BATCH} 个地址`);
    }
    const snap = this.store.loadAtVersion(tableId, atVersion);
    const trie = buildTrie(snap.routes);
    const results = destinations.map((d) => lookup(trie, parseIPv4Strict(d)));
    return { version: snap.version, results };
  }
}

function assertId(id: string): void {
  if (!isNonEmptyString(id) || !/^[A-Za-z0-9:_-]{1,64}$/.test(id.trim())) {
    throw new ServiceError("INVALID_ID", "编号必须为 1..64 位字母数字/_-/:");
  }
}

export { IpError };
