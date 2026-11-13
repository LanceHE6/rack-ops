# RackOps · 机房与机架拓扑管理平台

面向中小型机房（单机房、多机排、标准 42U 机柜）的设备与拓扑管理工具：以机房平面图与 3D 视角呈现设备真实位置，按 U 位管理机柜内部设备，并通过带外（IPMI/Redfish）与带内（SSH）通道采集硬件状态。

前端 React + HeroUI + Three.js，后端 Go + SQLite，前端构建产物内嵌进 Go 二进制，最终交付为单个可执行文件。

## 功能特性

**拓扑与视图**

- 2D 机房平面图：按机房真实方位摆放机排与机柜，1 格 = 1 个机柜位，支持滚轮缩放、拖拽平移、一键适配视图。
- 机排视角：机柜卡片按设备真实 U 位标注占用情况，卡片右侧提供竖向设备示意条，悬停显示设备名称、管理 IP、厂商型号、U 位区间、在线状态与温度。
- 3D 机房全景与机柜透视：机柜内部按 U 位堆叠设备，支持上下俯仰、平移与跟随光标缩放，连续 U 位设备不互相穿插。
- 搜索定位：按设备名、IP、型号、资产号、序列号检索，命中后在图上有高亮与定位。

**布局编辑（管理员）**

- 编辑模式严格按整格吸附，拖动时显示吸附落点虚线框，可拖动/新增/删除机排与机柜。
- 编辑过程只改本地草稿，工具栏提供撤销、重做、保存修改、放弃修改；只有点击「保存修改」才通过批量接口一次性落库。

**设备管理**

- 新增设备分两步：先选择 U 高度并在机柜条上点选位置（冲突实时标红），再填写资产与网络信息。
- 设备类型优先选择，品牌与型号按类型联动过滤，也可手动输入。
- 机柜 U 位视图中，管理员可按住行首 U 标签上下拖动设备，实时显示目标 U 位并在冲突时拒绝保存。

**状态采集**

- 支持 Redfish、IPMI、Linux SSH、交换机 SSH 四类采集通道，默认每 5 分钟轮询一次，也可在机柜详情中手动触发。
- 采集结果（在线状态、CPU/内存/温度、磁盘数量、固件版本等）缓存进数据库，拓扑打开即有数据。

**运维入口**

- 内置 WebSSH 终端（xterm.js + WebSocket 后端 PTY）与 IPMI SOL 串口控制台，BMC 也可跳转厂商原生页面。

**账号与审计**

- JWT 鉴权，角色分 `admin`（可编辑拓扑、操作设备、使用终端）与 `viewer`（只读）。
- IPMI/SSH 密码经 AES-256-GCM 加密存库，密钥由独立密钥文件或环境变量提供。
- 登录、拓扑变更、设备增删改、采集触发、终端连接等操作全部写入审计日志。

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 后端 | Go 1.26+、net/http、modernc.org/sqlite（纯 Go，无 CGO） |
| 鉴权 | golang-jwt/jwt v5、bcrypt |
| 终端 | WebSocket + golang.org/x/crypto/ssh + xterm.js |
| 前端 | React 18、TypeScript、HeroUI 2.7、Tailwind CSS 3.4、Three.js 0.173 |
| 构建 | Vite 6，`//go:embed` 内嵌前端产物 |

## 快速开始

依赖：Go 1.26+、Node.js 18+。

```bash
# 构建（先编译前端，再编译单二进制）
make build

# 运行，默认监听 127.0.0.1:8080
./rackops
```

首次启动会创建数据库、初始化管理员账号，并填充一批演示机排、机柜与演示设备（演示设备带 `[demo]` 标记，采集器会自动跳过），便于开箱查看效果。默认管理员账号为 `admin / admin123`，首次部署后请立即修改。

### 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `RACKOPS_PORT` | HTTP 监听端口 | `8080` |
| `RACKOPS_DATA_DIR` | 数据目录（数据库与密钥文件） | `~/.rackops` |
| `RACKOPS_DB_PATH` | SQLite 文件路径 | `<数据目录>/rackops.db` |
| `RACKOPS_SECRET_KEY` | 凭据加密主密钥（未设置则自动生成并落盘） | 自动生成 |
| `RACKOPS_JWT_SECRET` | JWT 签名密钥 | 自动生成 |
| `RACKOPS_POLL_INTERVAL` | 采集轮询间隔（秒，最小 30） | `300` |

## 目录结构

```
.
├── main.go                 程序入口，内嵌前端产物与 HTTP 服务
├── internal
│   ├── api/                REST 路由、鉴权中间件、处理器
│   ├── audit/              审计日志
│   ├── auth/               JWT 签发与校验
│   ├── collector/          Redfish / IPMI / SSH 采集与调度
│   ├── config/             配置加载与密钥文件
│   ├── console/            WebSSH、IPMI SOL、BMC 反向代理
│   ├── crypto/             bcrypt 与 AES-256-GCM
│   ├── db/                 SQLite 建表、迁移、演示数据
│   ├── model/              领域模型
│   └── repository/         数据访问层（含 U 位冲突校验、批量布局）
└── web                     前端工程（React + HeroUI + Three.js）
```

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/auth/login` | 登录获取 JWT |
| GET | `/api/v1/topology/rows` | 机排、机柜与坐标 |
| GET | `/api/v1/topology/rows/{id}` | 机排详情 |
| POST | `/api/v1/topology/layout/apply` | 批量应用布局草稿（新增/删除/移动，单事务） |
| GET/POST/PUT/DELETE | `/api/v1/devices[/{id}]` | 设备增删改查 |
| GET | `/api/v1/devices/search?q=` | 设备检索 |
| POST | `/api/v1/devices/collect` | 手动触发采集 |
| GET | `/api/v1/audit-logs` | 审计日志 |
| GET/POST/PUT/DELETE | `/api/v1/users[/{id}]` | 用户管理（仅管理员） |
| WS | `/api/v1/console/webssh` | WebSSH 终端（WebSocket 升级） |
| WS | `/api/v1/console/ipmisol` | IPMI SOL 串口控制台（WebSocket 升级） |
| ANY | `/api/v1/console/bmc-proxy/` | 厂商 BMC 页面反向代理 |

## 数据与安全说明

- 数据库为单文件 SQLite，开启 WAL 与外键约束，可直接备份 `rackops.db`。
- 凭据密文与主密钥分离存放：密钥文件权限应限制为仅服务账号可读，丢失主密钥将无法解密已有凭据。
- 终端与 BMC 通道涉及设备登录信息，建议仅在受控网段内开放服务端口。

## 后续计划

- 网络端口与连线关系（拓扑连线视图）。
- 多机房支持与机柜容量统计报表。
- 采集规则模板化，按厂商/型号下发不同解析策略。
