# Anywear 类实时试衣 Demo

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

打开 <http://127.0.0.1:5173>。本机回环地址可使用摄像头，不需要额外配置 HTTPS。

页面内支持通过「上传衣服照片」加入 JPG、PNG 或 WebP 服装图，单张不超过 10 MB。上传图片只保存在当前页面内存中，停止或刷新后不会保留。

## 网页图片小窗试衣

`extension` 目录提供一个无需构建的 Chrome MV3 扩展。安装后，在其他 HTTP/HTTPS 网页点击图片，会打开一个独立小窗，将该图片带入本地 Anywear 页面；小窗内仍需手动点击「开始试衣」。

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

## Decart API Key 卡池

后端支持通过 `DECART_API_KEYS` 配置多张 Key，使用逗号或换行分隔。每个实时会话启动时绑定一张 Key，优先选择当前活跃会话较少的 Key；活跃数相同时按轮询顺序分配。上游连接异常的 Key 会进入 `DECART_KEY_COOLDOWN_SECONDS` 指定的冷却期，避免连续击穿同一张卡。已有的单 Key 配置 `DECART_API_KEY` 仍然兼容。

```powershell
DECART_API_KEYS=key_a,key_b,key_c
DECART_KEY_COOLDOWN_SECONDS=60
```

Key 只在后端通过环境变量读取，不返回浏览器、不写日志、不写入镜像层。一次 WebRTC 会话不会中途换 Key；要换卡需要停止并重新开始会话。

会话创建、停止和 WebSocket 握手仅接受 `ALLOWED_ORIGINS` 中的来源，默认允许本机 `127.0.0.1:5173` 与 `localhost:5173`。修改页面地址或端口时，请同步调整该配置。

## 项目结构

- `client/public/garments`：浏览器使用的 PNG 试衣参考图。
- `assets/garments/source-svg`：未公开服务的 SVG 源素材。
- `server/src`：API、信令代理、会话管理和服装清单。
- `extension`：网页图片点击捕获和 Anywear 独立小窗扩展。
- `docker`：Nginx 配置；Dockerfile 与 Compose 文件保留在项目根目录。
- `docs/HANDOFF.md`：修复记录、验证结果和剩余风险。

## Docker 启动

Docker 版本把前端和后端封装为两个容器：Nginx 只在本机 `127.0.0.1:5173` 提供页面，并反代 API 和 WebSocket；后端容器不直接暴露到宿主机。Decart API Key 通过 `.env` 注入，不会写入镜像层。

```powershell
cd D:\workspace-hy\xinghua-策划\anywear-demo
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# 编辑 .env，填入 DECART_API_KEY
docker compose up --build
```

然后打开 <http://127.0.0.1:5173>。停止容器：

```powershell
docker compose down
```

容器内后端监听 `0.0.0.0` 仅用于容器网络通信；宿主机入口仍绑定 `127.0.0.1`。Docker 化不会把模型变成本地模型，视频生成仍由 Decart 云端完成。

## 效果筛选

实时参考衣服只支持 JPEG、PNG、WebP；图片需小于 10 MB，建议使用至少 512×512 的单件服装正面图，背景干净且不含穿着者。当前 5 件 PNG 是从简单示意图栅格化的演示素材，只用来验证消息链路，不代表最终试衣效果。正式展示前应替换为自有或明确授权的商品图，并逐件测试正面、移动、抬手、轻微侧身和手臂遮挡；出现明显变形或原衣残留的素材不要放入清单。
