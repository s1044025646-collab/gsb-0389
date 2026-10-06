import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as netCreateServer } from "node:net";
import { RouteService, ServiceError } from "./service.ts";
import { IpError } from "./ip.ts";
import { StoreError } from "./storage.ts";

/** 请求操作系统分配一个空闲 TCP 端口 */
export function pickFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("无法获取空闲端口")));
      }
    });
  });
}

const STATUS_BY_CODE: Record<string, number> = {
  TABLE_EXISTS: 409,
  VERSION_CONFLICT: 409,
  TABLE_NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  DUPLICATE_ID: 409,
  LIMIT_EXCEEDED: 413,
};

export function statusFor(code: string): number {
  if (
    code.startsWith("IP_") ||
    code.startsWith("CIDR") ||
    code.startsWith("PREFIX") ||
    code === "INVALID_ID" ||
    code === "INVALID_METRIC" ||
    code === "INVALID_ENABLED" ||
    code === "INVALID_ACTION" ||
    code === "NEXTHOP_REQUIRED" ||
    code === "NEXTHOP_FORBIDDEN" ||
    code === "CIDR_REQUIRED" ||
    code === "INVALID_BATCH" ||
    code === "INVALID_VERSION"
  ) {
    return 400;
  }
  return STATUS_BY_CODE[code] ?? 500;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, jsonReplacer);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) {
      throw new ServiceError("BODY_TOO_LARGE", "请求体超过 4MB 限制");
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("INVALID_JSON", "请求体不是合法 JSON");
  }
}

export interface RunningServer {
  server: Server;
  port: number;
  host: string;
}

export async function startHttp(
  service: RouteService,
  opts: { port?: number; host?: string } = {},
): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? (await pickFreePort(host));

  const server = createServer(async (req, res) => {
    try {
      await handle(service, req, res);
    } catch (err) {
      if (err instanceof ServiceError || err instanceof IpError || err instanceof StoreError) {
        send(res, statusFor(err.code), { error: { code: err.code, message: err.message } });
      } else {
        send(res, 500, {
          error: { code: "INTERNAL", message: (err as Error)?.message ?? "内部错误" },
        });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return { server, port, host };
}

async function handle(service: RouteService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const seg = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  if (seg[0] !== "api") {
    send(res, 404, { error: { code: "NOT_FOUND", message: "未知路径，请使用 /api/..." } });
    return;
  }

  if (method === "GET" && seg[1] === "health") {
    send(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && seg.length === 2 && seg[1] === "tables") {
    const body = await readJson(req);
    send(res, 201, service.createTable(String(body.id)));
    return;
  }
  if (method === "GET" && seg.length === 2 && seg[1] === "tables") {
    send(res, 200, { tables: service.listTables() });
    return;
  }

  const tableId = seg[2];
  if (seg[1] !== "tables" || !tableId) {
    send(res, 404, { error: { code: "NOT_FOUND", message: "未知 API 路径" } });
    return;
  }
  const parseVersionParam = (s: string | null): number | undefined => {
    if (s === null) return undefined;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0) {
      throw new ServiceError("INVALID_VERSION", "version 查询参数必须为非负整数");
    }
    return n;
  };
  const atQuery = parseVersionParam(url.searchParams.get("version"));

  const routeKey = `${method} ${seg.slice(3).join("/")}`;
  switch (routeKey) {
    case "GET routes": {
      const snap = service.snapshot(tableId, atQuery);
      send(res, 200, { version: snap.version, routes: snap.routes.map(publicRoute) });
      break;
    }
    case "GET tree": {
      send(res, 200, service.tree(tableId, atQuery));
      break;
    }
    case "POST routes": {
      const body = await readJson(req);
      send(res, 200, service.upsert(tableId, body, requireExpected(body)));
      break;
    }
    case "POST routes/import": {
      const body = await readJson(req);
      if (!Array.isArray(body.routes)) {
        throw new ServiceError("INVALID_BATCH", "routes 必须为数组");
      }
      send(res, 200, service.bulkImport(tableId, body.routes, requireExpected(body)));
      break;
    }
    case "POST query": {
      const body = await readJson(req);
      const at =
        body.atVersion === undefined || body.atVersion === null
          ? undefined
          : parseVersionParam(String(body.atVersion));
      if (typeof body.destination === "string") {
        send(res, 200, service.query(tableId, body.destination, at));
      } else if (Array.isArray(body.destinations)) {
        send(res, 200, service.queryBatch(tableId, body.destinations, at));
      } else {
        throw new ServiceError("INVALID_BATCH", "必须提供 destination 或 destinations");
      }
      break;
    }
    case "POST delete": {
      const body = await readJson(req);
      send(res, 200, { version: service.remove(tableId, String(body.id), requireExpected(body)) });
      break;
    }
    case "POST enabled": {
      const body = await readJson(req);
      if (typeof body.enabled !== "boolean") {
        throw new ServiceError("INVALID_ENABLED", "enabled 必须为布尔值");
      }
      send(res, 200, {
        version: service.setEnabled(tableId, String(body.id), body.enabled, requireExpected(body)),
      });
      break;
    }
    case "POST metric": {
      const body = await readJson(req);
      send(res, 200, {
        version: service.setMetric(
          tableId,
          String(body.id),
          Number(body.metric),
          requireExpected(body),
        ),
      });
      break;
    }
    default:
      send(res, 404, { error: { code: "NOT_FOUND", message: "未知 API 路径或方法" } });
  }
}

function requireExpected(body: any): number {
  if (!Number.isInteger(body?.expectedVersion) || body.expectedVersion < 0) {
    throw new ServiceError("INVALID_VERSION", "expectedVersion 必须为非负整数");
  }
  return body.expectedVersion;
}

function publicRoute(r: import("./model.ts").Route) {
  return {
    id: r.id,
    cidr: r.cidr,
    metric: r.metric,
    enabled: r.enabled,
    action: r.action,
    nextHop: r.nextHop,
  };
}
