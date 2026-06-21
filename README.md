# vLLM Monitor

实时监控 vLLM 推理服务的所有 Prometheus 指标，并支持 prefix cache 哈希链的可视化。

## 功能

### 1. 全量指标监控

通过 WebSocket 实时拉取 vLLM `/metrics` 端点的所有指标，包括：

| 类别 | 指标 |
|------|------|
| 系统状态 | Running/Waiting/Swapped 请求数、GPU/CPU KV Cache 使用率、抢占次数 |
| Token 统计 | Prompt/Generation token 总量、实时吞吐量 (tok/s) |
| 延迟 (P50/P95/P99) | TTFT、TPOT、E2E 延迟、队列时间、Prefill/Decode 时间、Model Forward/Execute 时间 |
| 前缀缓存 | GPU/CPU prefix cache hit rate、queries |
| 推测解码 | Draft acceptance rate、efficiency、accepted/draft/emitted tokens |
| 请求分布 | Finish reasons、Prompt/Generation token 直方图、max_tokens 参数分布 |

### 2. Prefix Cache 哈希链可视化

支持两种模式：

**Simulate 模式**：基于 vLLM 源码中 `sha256(parent_hash + block_tokens)` 的哈希链算法，手动输入 prompts 即可逐块计算哈希值、自动识别共享前缀。

**Live (KV Events) 模式**：通过订阅 vLLM ZMQ KV events，实时捕获每个 block 的 `BlockStored`/`BlockRemoved` 事件，构建真实的哈希链树，反映 vLLM 运行时的实际缓存状态。

- D3.js 渲染可交互树形图（缩放、拖拽、悬停查看详情）
- 命中率、共享块统计

## 快速开始

```bash
# 安装依赖
pip install -r requirements.txt

# 启动（默认尝试连接 localhost:8000，失败则进入 Demo 模式）
python server.py --port 7860

# 浏览器访问
# http://localhost:7860
```

## 连接远程 vLLM

```bash
python server.py --vllm-url http://10.74.99.215:9999 --port 7860
```

如果监控器所在机器配置了 HTTP 代理（`HTTP_PROXY` 环境变量），`httpx` 默认会走代理导致内网 IP 请求超时。`server.py` 已设置 `trust_env=False` 禁用代理信任，直接连接目标 IP。

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--vllm-url` | `http://localhost:8000` | vLLM 服务地址 |
| `--port` | `7860` | 监控面板端口 |
| `--host` | `0.0.0.0` | 绑定地址 |
| `--poll-interval` | `2.0` | 指标拉取间隔（秒） |
| `--kv-events-endpoint` | (无) | vLLM ZMQ KV events 端点（开启 Live 哈希链） |

## Live 哈希链（KV Events）

### vLLM 端配置

启动 vLLM 时需要开启 KV events 发布：

```bash
vllm serve <model> \
  --enable-prefix-caching \
  --kv-events-config '{"enable_kv_cache_events":"True","publisher":"zmq","topic":"kv-events"}'
```

### 监控器端配置

```bash
# 安装 ZMQ 依赖
pip install pyzmq

# 启动监控器，指定 ZMQ 端点（通常为 vLLM 服务器 IP:5557）
python server.py \
  --vllm-url http://10.74.99.215:9999 \
  --kv-events-endpoint tcp://10.74.99.215:5557 \
  --port 7860
```

### 使用

1. 打开监控面板 → Prefix Cache Hash Chain 标签
2. 点击 **"Live (KV Events)"** 按钮
3. 向 vLLM 发送推理请求，KV cache 块会被实时捕获
4. 点击 **"Refresh"** 查看最新哈希链树

## 项目结构

```
vLLM_monitor/
├── server.py              # FastAPI 后端（指标抓取 + KV events 订阅）
├── requirements.txt       # Python 依赖
├── README.md
└── static/
    ├── index.html         # 仪表盘页面
    ├── css/
    │   └── style.css      # 暗色主题样式
    └── js/
        ├── app.js         # 指标仪表盘逻辑
        └── hashchain.js   # 哈希链树可视化（含 Simulate/Live 双模式）
```

## Demo 模式

如果 vLLM 不可达，监控器自动回退到 Demo 模式，使用内置的模拟数据生成器，方便离线开发和演示。

## 依赖

- Python 3.10+
- FastAPI + Uvicorn
- httpx（异步 HTTP 客户端，`trust_env=False`）
- prometheus_client（Prometheus 文本解析）
- pyzmq（可选，用于 Live KV Events 模式）
- Chart.js + D3.js（前端可视化，CDN 加载）
