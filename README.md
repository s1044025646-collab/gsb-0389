# IPv4 路由最长前缀匹配实验后端

完全离线的 **IPv4 路由表查询服务**：维护若干路由，为目的地址选择**最长匹配前缀（LPM）**与下一跳，
并解释其它候选为什么没有被采用。只提供 **HTTP API 与 CLI**，不包含前端。

> 本项目是**纯模拟/计算**：不改系统路由表、不发送数据包、不探测网络、
> 不递归解析下一跳可达性，也不实现 BGP/OSPF/多路径负载均衡。

## 技术栈与运行要求

- TypeScript + Node.js（使用内置 `node:sqlite`，**无任何原生/在线依赖**，无需 Docker、WSL）
- 仅开发依赖：`typescript`、`@types/node`
- 建议 Node.js ≥ 22.5（开发环境为 Node 25）；SQLite 数据库文件位于**项目内 `data/` 目录**

## 快速开始（Windows PowerShell）

```powershell
npm install
npm run build
npm test                 # 运行全部测试（内置 node:test）
npm run demo             # 内置演示：/0、/8、/16、/24 drop 与禁用回退
npm start                # 启动 HTTP 服务（默认选择空闲端口，端口会打印出来）
```

指定端口 / 主机 / 数据库：

```powershell
node dist/src/cli.js serve --port 8080 --host 127.0.0.1 --db ./data/routes.db
```

## 选择规则（核心语义）

1. 按目的地址的位序在**自建二进制前缀树**上从根向下查找，最多 32 步，**不逐条扫描全表**。
2. 记录搜索路径上每一层真实存在的候选，取**前缀长度最大**的有效层：
   - **最长前缀永远优先**，不同前缀长度之间**不比较 metric**；
     因此默认路由（哪怕 metric=0）不可能覆盖更具体的路由。
   - 只有**同一前缀节点上存在多条启用路由**时，才比较 `metric`（小者胜）；
     metric 相同再按**路由编号字典序稳定排序**。
3. 命中更具体的 `drop` 时结果为丢弃，**不回退**到更短的 `forward`。
4. 路径上没有任何启用匹配时返回 `no-route`。
5. 禁用/删除后下次查询自动回退到祖先前缀；删除只影响该编号，同节点其它路由和子前缀保留。

## 地址与前缀规则

- 支持 `/0`（根位置兜底）到 `/32`（只匹配一个地址）的全部前缀。
- IPv4 按**无符号 32 位**处理（内部用 BigInt），不受 JS 有符号位运算或“移位 32 位”影响。
- CIDR 带主机位时**规范化为网络地址**，响应中给出 `normalizedCidr` 与 `hadHostBits`。
- 严格拒绝：非法点分十进制、前缀越界（如 `/33`）、前导零等有歧义数字格式（如 `010.0.0.1`、`0x0a...`）。
- 首地址（网络地址）与末地址（广播地址）都是**普通可查询地址**，不做特殊排除。

## 版本、并发与持久化

- 每次写操作产生一个**新版本**；所有写接口都要求 `expectedVersion`（乐观锁），
  不匹配返回 `409 VERSION_CONFLICT`。
- 规则以**仅追加事件流**存入 SQLite，任意历史版本都可重放重建。
- 历史查询必须**显式传 `version`/`atVersion`**；不传则使用当前版本，
  响应始终标注实际使用的版本——不会用最新树去解释旧报告。
- 批量导入为**整批原子**：编号重复（批量内或与已有数据冲突）或任一条目非法时整体回滚。
- 限制：单表最多 **5000** 条路由，单批/批量查询最多 **1000** 项（见 `src/service.ts`）。

## HTTP API（均为 JSON）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET  | `/api/health` | 健康检查 |
| GET  | `/api/tables` | 列出路由表及版本 |
| POST | `/api/tables` | 创建路由表 `{ "id": "net" }` |
| GET  | `/api/tables/:id/routes?version=N` | 导出快照（可指定历史版本） |
| GET  | `/api/tables/:id/tree?version=N` | 查看二进制前缀树 |
| POST | `/api/tables/:id/routes` | 新增/替换单条（含 `expectedVersion`） |
| POST | `/api/tables/:id/routes/import` | 批量原子导入 `{ expectedVersion, routes: [...] }` |
| POST | `/api/tables/:id/delete` | 删除 `{ expectedVersion, id }` |
| POST | `/api/tables/:id/enabled` | 启停 `{ expectedVersion, id, enabled }` |
| POST | `/api/tables/:id/metric` | 改 metric `{ expectedVersion, id, metric }` |
| POST | `/api/tables/:id/query` | 单条 `{ destination, atVersion? }` 或批量 `{ destinations: [...] }` |

路由对象：

```json
{ "id": "r1", "cidr": "10.1.0.0/16", "metric": 20, "enabled": true,
  "action": "forward", "nextHop": "192.0.2.11" }
```

查询响应包含 `result`（`forward`/`drop`/`no-route`）、命中 `prefix`、`routeId`、
`nextHop`、`metric`、`visited`（搜索路径上各层候选、被跳过的禁用项、同前缀决胜依据）、
`rejectedShorts`（更短前缀为何落选）与实际 `version`。

### curl 示例

```powershell
$p = 8080
Invoke-RestMethod -Method Post "http://127.0.0.1:$p/api/tables" -Body '{"id":"net"}' -ContentType application/json
Invoke-RestMethod -Method Post "http://127.0.0.1:$p/api/tables/net/routes/import" -ContentType application/json -Body '{"expectedVersion":0,"routes":[{"id":"d","cidr":"0.0.0.0/0","nextHop":"192.0.2.1"},{"id":"b","cidr":"10.1.2.0/24","action":"drop"}]}'
Invoke-RestMethod -Method Post "http://127.0.0.1:$p/api/tables/net/query" -ContentType application/json -Body '{"destination":"10.1.2.9"}'
```

## CLI 示例

```powershell
node dist/src/cli.js create-table net
node dist/src/cli.js import net 0 .\examples\routes.json
node dist/src/cli.js query net 10.1.2.9 10.1.3.9 8.8.8.8
node dist/src/cli.js query net 10.1.3.9 --version 1
node dist/src/cli.js disable net <expectedVersion> p16
node dist/src/cli.js tree net
node dist/src/cli.js export net --version 2
```

## 目录结构

- `src/ip.ts`：严格 IPv4/CIDR 解析与无符号 32 位运算
- `src/model.ts`：路由校验（metric、动作、下一跳约束）
- `src/trie.ts`：自建二进制前缀树、LPM 查询与解释、树视图
- `src/scan.ts`：独立线性扫描基准（仅用于测试对照）
- `src/storage.ts`：SQLite 版本/事件存储与按版本重建
- `src/service.ts`：业务规则、乐观锁、批量原子性与上限
- `src/server.ts`：HTTP API、错误码映射、空闲端口选择
- `src/cli.ts` / `src/demo.ts`：命令行与内置演示
- `test/`：核心校验、集成、HTTP、随机差分（trie vs 线性扫描、行序不变性、重启/历史复现）

## 错误码（部分）

`IP_INVALID`、`PREFIX_LEN_INVALID`、`CIDR_INVALID`、`INVALID_ID`、`INVALID_METRIC`、
`NEXTHOP_REQUIRED`、`NEXTHOP_FORBIDDEN`、`DUPLICATE_ID`、`VERSION_CONFLICT`、
`VERSION_NOT_FOUND`、`ROUTE_NOT_FOUND`、`TABLE_NOT_FOUND`、`TABLE_EXISTS`、
`LIMIT_EXCEEDED`、`INVALID_BATCH`。

## 已知限制

- 仅 IPv4；不做下一跳递归/ARP/接口判断；不做多路径；无鉴权，默认仅监听 `127.0.0.1`。
- 查询用树每次按版本从路由集合重建（表规模上限 5000，查询 O(前缀长度)）。

