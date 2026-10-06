import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { AppError } from "./errors";
import { RouteService } from "./service";

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
};

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 2_000_000) {
      throw new AppError("REQUEST_TOO_LARGE", "请求体超过 2 MB", 413);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("INVALID_JSON", "请求体不是合法 JSON", 400);
  }
};

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function createHttpServer(service: RouteService): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method ?? "GET";
      let body: Record<string, unknown> = {};
      if (method !== "GET" && method !== "HEAD") body = asObject(await readJson(request));

      if (method === "GET" && path === "/health") {
        json(response, 200, { ok: true });
        return;
      }

      const tableMatch = /^\/api\/tables\/([^/]+)(?:\/(.+))?$/.exec(path);
      if (method === "POST" && path === "/api/tables") {
        json(response, 201, { table: service.createTable(body) });
        return;
      }
      if (method === "GET" && path === "/api/tables") {
        json(response, 200, { tables: service.listTables() });
        return;
      }
      if (!tableMatch) {
        throw new AppError("NOT_FOUND", "接口不存在", 404);
      }

      const [, tableId, subPath = ""] = tableMatch;
      if (subPath === "" && method === "GET") {
        json(response, 200, { table: service.getTable(tableId) });
        return;
      }
      if (subPath === "routes" && method === "GET") {
        json(response, 200, service.snapshot(tableId, url.searchParams.get("version") ?? undefined));
        return;
      }
      if (subPath === "snapshot" && method === "GET") {
        json(response, 200, service.snapshot(tableId, url.searchParams.get("version") ?? undefined));
        return;
      }
      if (subPath === "versions" && method === "GET") {
        json(response, 200, service.listVersions(tableId));
        return;
      }
      if (subPath === "routes/import" && method === "POST") {
        json(response, 200, service.importRoutes(tableId, body.routes, body));
        return;
      }
      if (subPath === "routes" && method === "POST") {
        json(response, 200, service.importRoutes(tableId, [body.route ?? body], body));
        return;
      }
      const routeAction = /^routes\/([^/]+)\/(delete|enable|disable|metric)$/.exec(subPath);
      if (routeAction && method === "POST") {
        const routeId = decodeURIComponent(routeAction[1]);
        const action = routeAction[2];
        if (action === "delete") {
          json(response, 200, service.deleteRoute(tableId, routeId, body));
        } else if (action === "enable") {
          json(response, 200, service.setEnabled(tableId, routeId, true, body));
        } else if (action === "disable") {
          json(response, 200, service.setEnabled(tableId, routeId, false, body));
        } else {
          json(response, 200, service.updateMetric(tableId, routeId, body.metric, body));
        }
        return;
      }
      if (subPath === "lookup" && method === "GET") {
        json(response, 200, service.lookup(tableId, {
          destination: url.searchParams.get("destination"),
          version: url.searchParams.get("version")
        }));
        return;
      }
      if (subPath === "lookup" && method === "POST") {
        json(response, 200, service.lookup(tableId, body));
        return;
      }
      if (subPath === "batch-lookup" && method === "POST") {
        json(response, 200, service.batchLookup(tableId, body.destinations, body.version));
        return;
      }
      if (subPath === "tree-path" && method === "GET") {
        json(response, 200, service.treePath(
          tableId,
          url.searchParams.get("destination"),
          url.searchParams.get("version") ?? undefined
        ));
        return;
      }
      if (subPath === "verify-linear-scan" && method === "POST") {
        json(response, 200, {
          results: service.verifyWithLinearScan(
            tableId,
            body.destinations as string[],
            body.version === undefined ? undefined : Number(body.version)
          )
        });
        return;
      }
      throw new AppError("NOT_FOUND", "接口不存在", 404);
    } catch (error) {
      if (error instanceof AppError) {
        json(response, error.status, {
          error: { code: error.code, message: error.message, details: error.details }
        });
      } else {
        json(response, 500, {
          error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) }
        });
      }
    }
  });
}

export function listen(server: Server, port = 0, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}
