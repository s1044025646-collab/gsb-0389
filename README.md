# IPv4 最长前缀匹配与下一跳选择后端

这是一个完全离线的 Windows 本地后端，只提供 HTTP API 与 CLI。它维护模拟路由表，根据目的 IPv4 地址自行遍历二进制前缀树，选择最长匹配前缀上的启用路由，并返回选择过程解释。

项目不会修改系统路由表、不发送数据包、不探测网络、不递归解析下一跳可达性、不实现 BGP/OSPF、不做多路径负载均衡。

## 技术栈

- TypeScript + Node.js（要求 Node.js 22.5+，推荐 24/25）
- SQLite：使用 Node 内置 `node:sqlite`，无原生第三方数据库依赖
- 无外部在线 API、Docker、WSL 或付费服务依赖
- 数据默认保存在项目内 `data/routes.sqlite`

## 快速开始

```powershell
npm install
npm run build
npm test
npm run demo
npm start
```

默认服务监听 `127.0.0.1` 的空闲端口，启动时会打印实际端口。指定端口：

```powershell
$env:PORT="8080"; npm start
node dist/cli.js serve --port 8080 --host 127.0.0.1
```

可用环境变量：

- `LPM_DATA_DIR`：数据目录，默认 `./data`
- `LPM_DB_PATH`：SQLite 文件完整路径，优先级高于 `LPM_DATA_DIR`
- `PORT`：HTTP 端口，默认 `0`，即由操作系统选择空闲端口

## 路由模型

每条路由包含：

- `routeId`：表内唯一非负整数编号
- `cidr`：`/0` 到 `/32` 的 IPv4 CIDR；带主机位时会规范化为网络地址
- `metric`：非负整数，仅在同一前缀的启用路由之间比较
- `enabled`：布尔启用状态
- `action`：`forward` 或 `drop`
- `nextHop`：`forward` 必填合法 IPv4；`drop` 必须为空

限制：

- 每个路由表最多 10,000 条路由
- 单次批量导入或查询最多 1,000 项
- 完全相同前缀可对应不同 `routeId`

## 选择规则

1. 将目的地址按无符号 32 位整数解释，从最高位到最低位遍历自建二进制前缀树。
2. 只记录目的地址位路径上实际经过的节点，不扫描未经过的路由。
3. 路径上的 `/0`、`/8`、`/16` 等含启用路由的节点都是候选。
4. 选择前缀长度最大的候选层；更长前缀永远优先于更短前缀上的更小 `metric`。
5. 只有同一前缀长度且规范化后同前缀的多条启用路由，才比较 `metric`；`metric` 相同时按 `routeId` 升序稳定决胜。
6. 最长命中为 `drop` 时返回丢弃，不回退到较短的 `forward`。
7. 路径上没有启用路由时返回 `no-route`。
8. 禁用或删除某条路由只影响该编号；同节点其他路由和子前缀不会一起删除。

首地址和末地址都作为普通地址查询，不会自动排除网络地址或广播地址。`/0` 位于树根，作为兜底；`/32` 只匹配一个地址。

正式查询的时间复杂度为树搜索 O(32)，不是全表扫描。代码另提供独立掩码线性扫描，仅用于测试核对。

## 版本与持久化

所有写操作都必须在 JSON 体中提供 `expectedVersion`。当前版本匹配时才提交，提交后版本递增并保存不可变快照。

批量导入采用事务：重复编号、非法 CIDR、非法动作、缺失下一跳等任一条错误都会整批拒绝，不产生新版本。

历史查询必须显式传 `version`。历史报告使用对应版本的快照重建前缀树，不会用最新树解释旧结果。版本 `0` 是空表。

## HTTP API

### 路由表

```http
POST /api/tables
GET  /api/tables
GET  /api/tables/{tableId}
GET  /health
```

创建表示例：

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:8080/api/tables `
  -ContentType 'application/json' `
  -Body '{"name":"office"}'
```

### 批量导入

```http
POST /api/tables/{tableId}/routes/import
POST /api/tables/{tableId}/routes
```

```json
{
  "expectedVersion": 0,
  "routes": [
    {"routeId":1,"cidr":"0.0.0.0/0","metric":100,"enabled":true,"action":"forward","nextHop":"192.0.2.1"},
    {"routeId":2,"cidr":"10.0.0.0/8","metric":20,"enabled":true,"action":"forward","nextHop":"192.0.2.10"},
    {"routeId":3,"cidr":"10.1.0.0/16","metric":10,"enabled":true,"action":"forward","nextHop":"192.0.2.16"},
    {"routeId":4,"cidr":"10.1.2.99/24","metric":1,"enabled":true,"action":"drop"}
  ]
}
```

响应会显示 `10.1.2.99/24` 被规范化成 `10.1.2.0/24`。

### 增删、启停和 metric

```http
POST /api/tables/{tableId}/routes/{routeId}/delete
POST /api/tables/{tableId}/routes/{routeId}/enable
POST /api/tables/{tableId}/routes/{routeId}/disable
POST /api/tables/{tableId}/routes/{routeId}/metric
```

请求体均包含期望版本；修改 metric 示例：

```json
{"expectedVersion":1,"metric":50}
```

### 查询

```http
POST /api/tables/{tableId}/lookup
POST /api/tables/{tableId}/batch-lookup
GET  /api/tables/{tableId}/lookup?destination=10.1.2.9&version=1
GET  /api/tables/{tableId}/tree-path?destination=10.1.2.9&version=1
```

单查请求：

```json
{"destination":"10.1.2.9","version":1}
```

批量查询：

```json
{"version":1,"destinations":["10.1.2.9","10.1.3.9","0.0.0.0","255.255.255.255"]}
```

查询解释包含：

- `visitedDepths`：实际访问且挂有路由的前缀层
- `layers`：各层前缀、启用竞争者、禁用编号、同前缀决胜说明
- `selectedLayerDepth`：最终最长前缀层
- `notConsideredOutsidePath`：明确说明未经过路径不参与搜索

### 快照与版本

```http
GET /api/tables/{tableId}/snapshot
GET /api/tables/{tableId}/snapshot?version=1
GET /api/tables/{tableId}/versions
```

### 测试用线性扫描对照

```http
POST /api/tables/{tableId}/verify-linear-scan
```

```json
{"version":1,"destinations":["10.1.2.9","10.1.3.9"]}
```

该接口仅用于核对正式前缀树结果和独立全表掩码扫描是否一致，不参与生产选择。

## CLI

```powershell
node dist/cli.js create-table demo
node dist/cli.js list-tables
node dist/cli.js import <tableId> routes.json
node dist/cli.js add <tableId> route.json
node dist/cli.js lookup <tableId> 10.1.2.9 1
node dist/cli.js batch-lookup <tableId> destinations.json
node dist/cli.js tree-path <tableId> 10.1.2.9 1
node dist/cli.js snapshot <tableId> 1 --file snapshot.json
node dist/cli.js enable <tableId> 3 1
node dist/cli.js disable <tableId> 3 1
node dist/cli.js metric <tableId> 3 50 1
node dist/cli.js delete <tableId> 4 1
node dist/cli.js versions <tableId>
```

`routes.json` 示例：

```json
{
  "expectedVersion": 0,
  "routes": [
    {"routeId":1,"cidr":"0.0.0.0/0","metric":100,"action":"forward","nextHop":"192.0.2.1"}
  ]
}
```

`destinations.json` 示例：

```json
{"version":1,"destinations":["10.1.2.9","10.1.3.9"]}
```

## 演示规则

`npm run demo` 会使用独立的 `data/demo.sqlite` 演示：

- `0.0.0.0/0`：低优先级默认路由
- `10.0.0.0/8`
- `10.1.0.0/16`
- `10.1.2.0/24`：`drop`

结果：

- `10.1.2.9` 命中 `/24`，返回 `drop`
- `10.1.3.9` 命中 `/16`，转发给 `/16` 下一跳
- 禁用 `/16` 后，`10.1.3.9` 回退到 `/8`

## 参数校验与错误码

错误响应格式：

```json
{"error":{"code":"INVALID_IPV4","message":"非法点分十进制 IPv4 地址: ...","details":null}}
```

常见错误码：

- `INVALID_IPV4`：非法点分十进制
- `AMBIGUOUS_NUMBER`：前导零等有歧义数字
- `INVALID_PREFIX_LENGTH`：前缀不是 `/0` 到 `/32`
- `INVALID_CIDR`：CIDR 格式错误
- `INVALID_FIELD`：字段类型或格式错误
- `INVALID_ACTION`：动作不是 `forward/drop`
- `MISSING_NEXT_HOP`：forward 缺少下一跳
- `DROP_HAS_NEXT_HOP`：drop 携带了下一跳
- `DUPLICATE_ROUTE_ID`：路由编号重复
- `BATCH_VALIDATION_FAILED`：批量中存在非法项，整批拒绝
- `BATCH_TOO_LARGE`：批量超过 1,000
- `ROUTE_LIMIT_EXCEEDED`：路由总数超过 10,000
- `ROUTE_NOT_FOUND` / `ROUTE_TABLE_NOT_FOUND`
- `EXPECTED_VERSION_REQUIRED` / `INVALID_EXPECTED_VERSION` / `VERSION_CONFLICT` / `VERSION_NOT_FOUND`
- `INVALID_JSON` / `REQUEST_TOO_LARGE` / `NOT_FOUND`

## 测试

```powershell
npm test
```

测试覆盖：

- 默认路由、`/8`、`/16`、`/24 drop`
- 同前缀 metric 并列及编号稳定排序
- 全部禁用、`/0`、`/32`、首末地址
- 删父留子、删子留父
- 非法批量整体回滚和版本冲突回滚
- 禁用后祖先前缀回退
- SQLite 重启后当前与历史版本复现
- 随机小路由表在多次修改后与独立线性掩码扫描核对
- 随机打乱输入行序后查询答案不变

## 项目结构

```text
src/
  ipv4.ts      # 无符号 IPv4/CIDR 解析与规范化
  trie.ts      # 自建二进制前缀树与解释
  scanner.ts   # 仅测试基准用的独立全表掩码扫描
  route.ts     # 路由输入校验与限制
  db.ts        # SQLite 表结构、事务和版本快照
  service.ts   # 领域操作、版本树缓存、历史查询
  http.ts      # 原生 Node HTTP API
  cli.ts       # 命令行入口
  demo.ts      # 本地演示
  __tests__/   # Node 内置测试框架
```

## 重要限制

本项目是路由选择模拟后端：它只计算“如果存在这些规则，应选择哪条”。它不保证下一跳真实可达，不处理网卡、内核转发表、ARP/ND、TTL、ICMP、递归下一跳或真实流量转发。
