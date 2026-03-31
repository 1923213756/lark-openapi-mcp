# 飞书/Lark OpenAPI MCP

[![npm version](https://img.shields.io/npm/v/@larksuiteoapi/lark-mcp.svg)](https://www.npmjs.com/package/@larksuiteoapi/lark-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@larksuiteoapi/lark-mcp.svg)](https://www.npmjs.com/package/@larksuiteoapi/lark-mcp)
[![Node.js Version](https://img.shields.io/node/v/@larksuiteoapi/lark-mcp.svg)](https://nodejs.org/)

中文 | [English](./README.md) 

[开发文档检索 MCP](./docs/recall-mcp/README_ZH.md) 

[官方文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/mcp_introduction)

[常见问题](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/use_cases)

> **⚠️ Beta版本提示**：当前工具处于Beta版本阶段，功能和API可能会有变更，请密切关注版本更新。

飞书/Lark官方 OpenAPI MCP（Model Context Protocol）工具，旨在帮助用户快速连接飞书平台并实现 AI Agent 与飞书的高效协作。该工具将飞书开放平台的 API 接口封装为 MCP 工具，使 AI 助手能够直接调用这些接口，实现文档处理、会话管理、日历安排等多种自动化场景。

## 使用准备

### 创建应用

在使用lark-mcp工具前，您需要先创建一个飞书应用：

1. 访问[飞书开放平台](https://open.feishu.cn/)并登录
2. 点击"开发者后台"，创建一个新应用
3. 获取应用的App ID和App Secret，这将用于API认证
4. 根据您的使用场景，为应用添加所需的权限
5. 如需以用户身份调用 API，请根据部署方式配置 OAuth 2.0 重定向 URL：
   - 本地 `login` 登录：`http://localhost:3000/callback`
   - 内网 HTTP 服务部署：`http://<你的内网域名或IP>:<端口>/oauth/callback`

详细的应用创建和配置指南，请参考[飞书开放平台文档 - 创建应用](https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process#a0a7f6b0)。

### 安装Node.js

在使用lark-mcp工具之前，您需要先安装Node.js环境。

**使用官方安装包（推荐）**：

1. 访问[Node.js官网](https://nodejs.org/)
2. 下载并安装LTS版本
3. 安装完成后，打开终端验证：

```bash
  node -v
  npm -v
```

## 快速开始

### 在Trae/Cursor中使用

如需在Trae、Cursor等AI工具中集成飞书/Lark功能，你可以通过下方按钮安装，将 `app_id` 和 `app_secret` 填入安装弹窗或客户端配置 JSON 的 `args` 中：

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-light.svg)](https://cursor.com/install-mcp?name=lark-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBsYXJrc3VpdGVvYXBpL2xhcmstbWNwIiwibWNwIiwiLWEiLCJ5b3VyX2FwcF9pZCIsIi1zIiwieW91cl9hcHBfc2VjcmV0Il19)
[![Install MCP Server](./assets/trae-cn.svg)](trae-cn://trae.ai-ide/mcp-import?source=lark&type=stdio&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBsYXJrc3VpdGVvYXBpL2xhcmstbWNwIiwibWNwIiwiLWEiLCJ5b3VyX2FwcF9pZCIsIi1zIiwieW91cl9hcHBfc2VjcmV0Il19)  [![Install MCP Server](./assets/trae.svg)](trae://trae.ai-ide/mcp-import?source=lark&type=stdio&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBsYXJrc3VpdGVvYXBpL2xhcmstbWNwIiwibWNwIiwiLWEiLCJ5b3VyX2FwcF9pZCIsIi1zIiwieW91cl9hcHBfc2VjcmV0Il19)


也可以直接在 MCP Client 的配置文件中添加以下内容（JSON），客户端会按配置启动 `lark-mcp`：

```json
{
  "mcpServers": {
    "lark-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@larksuiteoapi/lark-mcp",
        "mcp",
        "-a",
        "<your_app_id>",
        "-s",
        "<your_app_secret>"
      ]
    }
  }
}
```

如需使用**用户身份**访问 API，有两种方式：
1. 本地单用户使用：先在终端运行 `login`，把用户令牌保存在本机。
2. 内网 HTTP 服务：由服务端托管用户令牌，用户在浏览器里完成授权，MCP 客户端只持有 MCP 服务自己的 session token。

下面先介绍本地单用户方式。此方式需要先在开发者后台配置重定向 URL 为 `http://localhost:3000/callback`。

```bash
npx -y @larksuiteoapi/lark-mcp login -a cli_xxxx -s yyyyy
```

然后在 MCP Client 中启用 `--oauth`

```json
{
  "mcpServers": {
    "lark-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@larksuiteoapi/lark-mcp",
        "mcp",
        "-a", "<your_app_id>",
        "-s", "<your_app_secret>",
        "--oauth",
        "--token-mode", "user_access_token"
      ]
    }
  }
}
```

说明：在启用 `--oauth` 时，建议显式设置 `--token-mode` 为 `user_access_token`，表示以用户访问令牌调用 API，适用于访问用户资源或需要用户授权的场景（如读取个人文档、发送 IM 消息）。若保留默认 `auto`，可能在AI推理使用 `tenant_access_token`，导致权限不足或无法访问用户私有数据。

### 内网 HTTP 服务的用户授权教程

如果你的 MCP 服务最终部署在内网服务器上，没有桌面环境，也不希望把 `refresh_token` 暴露给终端用户，可以使用服务端托管授权模式。

这个模式的工作方式是：

1. MCP 服务以 HTTP 方式部署在内网服务器上。
2. 服务端保存飞书 `user_access_token` 和 `refresh_token`。
3. 用户在自己的电脑浏览器里访问飞书授权页。
4. 飞书授权完成后，浏览器回调到你的内网 MCP 服务。
5. MCP 服务再向客户端发放自己的 session token，后续自动刷新飞书凭证。

#### 第1步：在飞书开放平台配置回调地址

假设你的 MCP 服务会被部署到：

```text
http://mcp.infra.company:3000
```

那么在飞书开放平台里需要配置的 OAuth 2.0 重定向 URL 应该是：

```text
http://mcp.infra.company:3000/oauth/callback
```

> 💡 提示：这里必须填写“用户浏览器能访问到的内网 HTTP 地址”，不是 `0.0.0.0`，也不是容器内部地址。

#### 第2步：启动内网 HTTP MCP 服务

```bash
export APP_ID=cli_xxxx
export APP_SECRET=your_secret
export LARK_AUTH_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

npx -y @larksuiteoapi/lark-mcp mcp \
  -a cli_xxxx \
  -s your_secret \
  -m streamable \
  --host 0.0.0.0 \
  -p 3000 \
  --oauth \
  --token-mode user_access_token \
  --public-base-url http://mcp.infra.company:3000 \
  --oauth-base-path /oauth
```

参数说明：

- `--host 0.0.0.0`：让服务在内网服务器上监听。
- `--public-base-url`：告诉 OAuth 流程“浏览器实际访问的地址”是什么。
- `--oauth-base-path /oauth`：授权相关路由统一挂在 `/oauth/*` 下，默认就是 `/oauth`。
- `LARK_AUTH_ENCRYPTION_KEY`：服务端本地加密密钥，用于加密保存凭证。请使用 64 位十六进制字符串，并妥善保管。

额外说明：

- 托管 OAuth 模式要求可持久化的加密存储；若存储初始化失败，服务会直接拒绝启动，避免重启后丢失 `client_id`、MCP session 或飞书凭证。
- 可通过 `GET http://mcp.infra.company:3000/oauth/status` 检查当前 `issuer`、`callback_url`、持久化状态以及已加载的 clients/sessions/credentials 数量。

#### 第3步：在 MCP 客户端连接内网服务

客户端不再直接保存飞书 `refresh_token`，只需要连接你的内网 MCP 服务：

```json
{
  "mcpServers": {
    "lark-mcp": {
      "url": "http://mcp.infra.company:3000/mcp"
    }
  }
}
```

当客户端第一次访问需要用户身份的工具时，会触发标准 MCP OAuth 流程。用户在浏览器完成授权后，后续请求就会自动使用服务端托管的飞书凭证。

> 💡 注意：MCP 服务发给客户端的是自己的 `mcp_at_*` / `mcp_rt_*` session token，它们不能直接调用飞书开放平台 API，只能用于访问该 MCP 服务。

#### 第4步：适用场景

这种方式适合以下场景：

- 内网服务器常驻部署 MCP 服务
- 多个用户分别授权、分别使用自己的飞书身份
- 不希望把 `refresh_token` 下发到开发机或 MCP 客户端
- 服务端统一负责 token 存储、过期刷新和会话隔离

### 域名配置

根据您的使用场景，lark-mcp 支持配置不同的域名环境：

**飞书**：
- 默认使用 `https://open.feishu.cn` 域名
- 适用于飞书用户

**Lark（国际版）**：
- 使用 `https://open.larksuite.com` 域名
- 适用于国际版Lark用户

如需切换至国际版Lark，请在配置中添加 `--domain` 参数：

```json
{
  "mcpServers": {
    "lark-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@larksuiteoapi/lark-mcp",
        "mcp",
        "-a",
        "<your_app_id>",
        "-s",
        "<your_app_secret>",
        "--domain",
        "https://open.larksuite.com"
      ]
    }
  }
}
```

> **💡 提示**：确保您的应用已在对应域名环境的开放平台创建。国际版应用无法在飞书中国版使用，反之亦然。


## 自定义配置开启API

> ⚠️ **文件上传下载**：暂不支持文件的上传和下载操作

> ⚠️ **云文档编辑**：暂不支持直接编辑飞书云文档内容（仅支持导入和读取）

默认情况下，MCP 服务启用常用 API。如需启用其他工具或仅启用特定 API 或 preset，推荐在 MCP Client 配置（JSON）中通过 `-t` 指定（用逗号分隔）：

```json
{
  "mcpServers": {
    "lark-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@larksuiteoapi/lark-mcp",
        "mcp",
        "-a", "<your_app_id>",
        "-s", "<your_app_secret>",
        "-t", "im.v1.message.create,im.v1.message.list,im.v1.chat.create,preset.calendar.default"
      ]
    }
  }
}
```

关于所有预设工具集的详细信息以及每个预设包含哪些工具，请参考[预设工具集参考文档](./docs/reference/tool-presets/presets-zh.md)。

对于所有支持的飞书/Lark工具列表可以在[tools.md](./docs/reference/tool-presets/tools-zh.md)中查看。

> **⚠️ 提示**：非预设 API 没有经过兼容性测试，AI在理解使用的过程中可能效果不理想

### 在开发Agent中使用

开发者可参考在 Agent 中集成的最小示例：[`lark-samples/mcp_quick_demo`](https://github.com/larksuite/lark-samples/tree/main/mcp_quick_demo)。

另外可参考 Lark 机器人集成示例：[`lark-samples/mcp_larkbot_demo/nodejs`](https://github.com/larksuite/lark-samples/tree/main/mcp_larkbot_demo/nodejs)。

该示例展示如何将 MCP 能力集成到飞书/Lark 机器人中，通过机器人会话触发工具调用与消息收发，适用于将已有工具接入 Bot 的场景。

### 高级配置

更详细的配置选项和部署场景，请参考我们的[配置指南](./docs/usage/configuration/configuration-zh.md)。

关于所有可用命令行参数及其使用方法的详细信息，请参考[命令行参考文档](./docs/reference/cli/cli-zh.md)。

## 常见问题

- [常见问题（FAQ）](./docs/troubleshooting/faq-zh.md)
- [常见问题与使用案例](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/use_cases)

## 相关链接

- [飞书开放平台](https://open.feishu.cn/)
- [开发文档：OpenAPI MCP](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/mcp_introduction)
- [Lark国际版开放平台](https://open.larksuite.com/)
- [飞书开放平台API文档](https://open.feishu.cn/document/home/index)
- [Node.js官网](https://nodejs.org/)
- [npm文档](https://docs.npmjs.com/)

## 反馈

欢迎提交Issues来帮助改进这个工具。如有问题或建议，请在GitHub仓库中提出。
