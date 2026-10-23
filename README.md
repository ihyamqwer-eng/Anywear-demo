# 青叶科技实时虚拟试衣 Demo

本项目是一个本机单路展示 Demo：浏览器采集摄像头，后端代理 Decart 官方 WebSocket 信令，浏览器与 Decart 直接建立 WebRTC 媒体连接。

## 运行前提

- Windows + Node.js `^22.12.0` 或 `>=24.0.0`（Vite 7 的运行要求；默认版本见 `.nvmrc`）
- npm `11.16.0`（由根 `package.json` 的 `packageManager` 声明）
- Chrome
- Decart 官方 API Key 和可用额度
- 允许访问摄像头的本机浏览器
- Docker Desktop（使用容器启动时）

## 启动

```powershell
cd D:\workspace-hy\xinghua-策划\anywear-demo
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# 编辑 .env，填入 DECART_API_KEYS 或兼容的 DECART_API_KEY
npm run dev
```

打开 <http://127.0.0.1:5173>。本机回环地址可使用摄像头，不需要额外配置 HTTPS。通过局域网 IP 使用时，浏览器将 HTTP 页面视为不安全来源并禁用摄像头；按下方步骤配置受浏览器信任的 HTTPS 证书。

## Windows 安装版

内部 Windows x64 安装版提供本机 Node.js 运行时，不要求安装 Docker 或 Node。安装后打开新的 PowerShell 或命令提示符窗口运行：

```powershell
anywear start
anywear status
anywear stop
anywear config
```

`start` 会在后台启动本机服务，并在 Chrome 普通浏览器窗口打开 <http://127.0.0.1:1111>；若 Chrome 未安装则使用 Edge。关闭浏览器窗口不会自动停止服务，需运行 `anywear stop`。服务只监听本机回环地址，不提供局域网访问。`config` 打开当前用户的 `.env` 配置文件。

本安装包按内部要求嵌入构建时的 `.env`，安装时仅在用户配置尚不存在时初始化；升级不会覆盖已有配置。安装包可被解包，包含其中的 API Key，应按凭证文件限制分发，不要上传到 GitHub 或公开发布。生成安装包请在有 Inno Setup 的 Windows x64 构建机运行 `scripts/package-windows.ps1`；最终 EXE 保存在本地发布目录并被 Git 忽略。

页面内支持通过「上传衣服照片」加入单张图片，或在服装分组栏点击「选择图组目录」导入整个本机目录。支持 JPG、PNG、WebP，单张不超过 10 MB；目录导入会按所选根目录创建临时图组。文件只保存在当前页面内存中，不会保存本机绝对路径，刷新后需要重新选择。

## 网页图片小窗试衣

`extension` 目录提供一个无需构建的 Chrome MV3 扩展。安装后，在其他 HTTP/HTTPS 网页点击图片，会打开一个独立小窗，将该图片带入本地青叶科技试衣页面；小窗内仍需手动点击「开始试衣」。

安装步骤：

1. 打开 `chrome://extensions` 并启用「开发者模式」。
2. 选择「加载已解压的扩展程序」，指向本项目的 `extension` 目录。
3. 确认本地页面运行在 `http://127.0.0.1:5173/`。

扩展只读取用户点击的图片，不会自动上传或保存图片。需要登录、临时签名或防盗链的网页图片可能无法读取，可改用页面内上传。

## 架构边界

- `server` 保存 API Key、创建会话、代理 JSON 信令、限制会话时长和记录供应商计费秒数。
- `client` 只拿本地会话 ID，不接触长期 API Key。
- 前端构建工具仅作为开发依赖；Docker 后端镜像只安装 server workspace 的生产依赖。
- 摄像头和结果视频走 WebRTC 直连 Decart，不经过本地后端媒体转码或中继。
- 这是展示用 PoC，不是 Anywear 消费者网页反代，也不使用 Cookie 或未公开接口。

## 常用检查

```powershell
npm run typecheck
npm run build
Invoke-RestMethod http://localhost:8787/api/health
```

没有 API Key 时，健康检查仍可用，但创建实时会话会返回明确配置错误；项目不会自动调用付费接口。

## 诊断日志

页面「诊断日志」区域会记录浏览器安全上下文、摄像头采集参数、信令/WebRTC 状态与错误，最多保留 300 条在当前浏览器本地；点击「导出诊断日志」可下载 JSON。日志不会包含摄像头视频、服装图片、信令正文或 API Key。请在出现问题的那台电脑上导出浏览器日志。

后端与 Nginx 的结构化日志写入 Docker 标准输出，按容器分别查看：

```powershell
docker compose logs -f --tail=200 backend frontend
```

日志包含 Origin 拒绝原因、会话生命周期、供应商 WebSocket 状态和 Nginx 请求状态；Nginx 访问日志省略 URL 查询参数。Docker 每个服务最多保留 3 个、每个 10 MB 的日志文件。

## 局域网 HTTPS 摄像头

局域网 HTTP 页面可以浏览，但浏览器不提供摄像头 API。为本机局域网 IPv4 生成本地 CA 和 HTTPS 证书，并重启前端容器：

```powershell
.\scripts\setup-lan-https.ps1 -LanIp 192.168.1.9
docker compose up -d --build frontend
```

脚本将服务器私钥与证书放在 Git 和 Docker build context 均排除的 `.certs` 目录，并输出 CA 的 SHA-256 指纹。使用另一台电脑打开 `http://192.168.1.9:5173/lan-ca.crt` 下载 CA 证书；导入前在两台电脑上分别运行 `Get-FileHash .\lan-ca.crt -Algorithm SHA256` 并核对指纹。确认一致后，在 Windows 证书安装向导中选择「当前用户」和「受信任的根证书颁发机构」，完成后重启浏览器。之后用 <https://192.168.1.9:5443> 访问并允许摄像头。HTTPS Origin 已加入本机 `.env`；如更换 IP 或端口，需同步更新证书和 `ALLOWED_ORIGINS`。

如果浏览器访问 HTTPS 端口超时，请在管理员 PowerShell 放行 Private 网络中的本地子网：

```powershell
New-NetFirewallRule -DisplayName 'Anywear Demo HTTPS LAN TCP 5443' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5443 -RemoteAddress LocalSubnet -Profile Private
```

CA 证书仅用于本地演示；不要分享 `.certs/lan-server.key`，也不要将本地 CA 私钥备份到公开位置。

## 服装目录分组

服装目录由 `GARMENT_GROUPS_JSON` 定义，`GARMENT_LIBRARY_HOST_PATH` 指向本机服装库根目录。每个配置项的 `directory` 必须是根目录内的相对地址；后端递归发现 JPG、JPEG、PNG、WebP 并生成预览。精选组保留现有内置演示服装，其他目录各自成为一个可切换分页。Docker 将服装库以只读方式挂入后端。页面也可通过「选择图组目录」即时导入本机目录，但这是浏览器内临时图组，刷新后不保留；需要持久化的服务端图组仍应使用下方环境变量配置。

```env
GARMENT_LIBRARY_HOST_PATH=./garment-library
GARMENT_GROUPS_JSON=[{"id":"summer","name":"夏季上衣","directory":"summer"},{"id":"hoodies","name":"卫衣","directory":"秋冬/卫衣","prompt":"Replace the current top with the garment shown in the reference image. Preserve the person, pose, face, hands, and background."}]
```

把图片放进配置的目录后重启后端或容器即可重新扫描。绝对路径和指向服装库外部的符号链接不会被读取。该服装目录默认被 Git 忽略，避免把个人/商品图片意外上传。

## Decart API Key 卡池

后端支持通过 `DECART_API_KEYS` 配置多张 Key，使用逗号或换行分隔；已有的单 Key 配置 `DECART_API_KEY` 也会并入卡池并去重。每个实时会话启动时绑定一张 Key，优先选择当前活跃会话较少的 Key；活跃数相同时按轮询顺序分配。`DECART_KEY_COOLDOWN_SECONDS` 默认为 `0`，表示故障 Key 不冷却、不会因失败被熔断；设置为正数才会暂时跳过故障 Key。会话内不会热切换；供应商错误仍会结束当前实时会话，下一次新建会话继续从卡池分配。

```powershell
DECART_API_KEYS=key_a,key_b,key_c
DECART_KEY_COOLDOWN_SECONDS=0
```

在 `/cards/manage` 可创建和命名分组、启用分组、按组添加 Key、迁移卡片、查看脱敏尾号和活跃会话数，以及启用/停用或移除未被会话占用的卡。`/cards` 只展示当前启用分组中的卡片。自动分配按该组的活跃会话数轮询；不会借用其他分组的 Key。停用、迁移或切换分组只影响新会话，已有会话继续使用创建时绑定的 Key。添加成功后只显示脱敏提示，不会再次返回完整 Key；Key 不写日志，也不进入镜像层。管理接口仅允许从运行服务的本机回环地址访问，不能从局域网 IP 管理。

当前启用分组是整台服务的新会话路由目标。切换分组不会中断既有实时会话；实时会话本身不能在供应商 WebSocket 中途热换 API Key。供应商连接失败时会结束该会话，下次新会话仍只在当前启用组内分配。

管理页首次修改卡池时，会把当前环境变量导入结果和后续分组/卡片修改写入版本 2 的 `provider-keys.json`。原先的顶层 Key 数组会自动映射到“默认分组”，首次保存时升级为分组格式。文件位于 `ANYWEAR_DATA_DIR`；未设置时位于项目根目录下的 `.anywear-data`。此文件含明文凭证，应按密钥文件保护且不会提交到 Git。文件存在后将作为卡池来源，后续 `.env` 中的 Key 变更不会覆盖它；删除文件后才重新从环境变量初始化。Docker 使用 `anywear-data` 命名卷保存管理卡池；普通容器重建会保留，执行 `docker compose down -v` 会删除该卷。同一数据目录仅支持一个后端进程。

每组各自维护 `poolId`；卡片增删、启停或迁移会更新受影响分组的版本，以免浏览器保存的旧卡号指向其他凭证。一次 WebRTC 会话不会中途换 Key；活跃会话占用的卡不能移除或迁移，要先停止会话。

会话创建、停止和 WebSocket 握手仅接受 `ALLOWED_ORIGINS` 中的来源，默认允许本机 `127.0.0.1:5173` 与 `localhost:5173`。修改页面地址或端口时，请同步调整该配置。

## 项目结构

- `client/public/garments`：浏览器使用的 PNG 试衣参考图。
- `assets/garments/source-svg`：未公开服务的 SVG 源素材。
- `server/src`：API、信令代理、会话管理和服装清单。
- `extension`：网页图片点击捕获和 Anywear 独立小窗扩展。
- `docker`：Nginx 配置；Dockerfile 与 Compose 文件保留在项目根目录。
- `docs/HANDOFF.md`：修复记录、验证结果和剩余风险。

## Docker 启动

Docker 版本把前端和后端封装为两个容器：Nginx 在 `5173` 端口提供页面，并反代 API 和 WebSocket；后端容器不直接暴露到宿主机。初始 Decart API Key 通过 `.env` 注入，不会写入镜像层；卡池管理写入独立的 `anywear-data` 命名卷。

```powershell
cd D:\workspace-hy\xinghua-策划\anywear-demo
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# 编辑 .env，填入 DECART_API_KEY
docker compose up --build
```

本机打开 <http://127.0.0.1:5173>；同一局域网的其他电脑可访问 `http://<本机局域网 IP>:5173` 浏览页面，但摄像头需 HTTPS 安全来源。停止容器：

```powershell
docker compose down
```

容器内后端监听 `0.0.0.0` 仅用于容器网络通信；Docker 前端端口发布到宿主机所有网卡。Windows 防火墙需允许 Private 网络的本地子网访问 TCP `5173`。Docker 化不会把模型变成本地模型，视频生成仍由 Decart 云端完成。

## 效果筛选

实时参考衣服只支持 JPEG、PNG、WebP；图片需小于 10 MB，建议使用至少 512×512 的单件服装正面图，背景干净且不含穿着者。当前 5 件 PNG 是从简单示意图栅格化的演示素材，只用来验证消息链路，不代表最终试衣效果。正式展示前应替换为自有或明确授权的商品图，并逐件测试正面、移动、抬手、轻微侧身和手臂遮挡；出现明显变形或原衣残留的素材不要放入清单。
