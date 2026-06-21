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
| 前缀缓存 | GPU/CPU prefix cache hit rate |
| 推测解码 | Draft acceptance rate、efficiency、accepted/draft/emitted tokens |
| 请求分布 | Finish reasons、Prompt/Generation token 直方图、max_tokens 参数分布 |

### 2. Prefix Cache 哈希链可视化

基于 vLLM 源码中 `sha256(parent_hash + block_tokens)` 的哈希链算法，输入任意 prompts 即可：

- 逐块计算哈希值，展示链式依赖关系
- 自动识别共享前缀，标注缓存命中块
- D3.js 渲染可交互树形图（缩放、拖拽、悬停）
- 展示命中率统计

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
python server.py --vllm-url http://a.b.c.d:9999 --port 7860
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--vllm-url` | `http://localhost:8000` | vLLM 服务地址 |
| `--port` | `7860` | 监控面板端口 |
| `--host` | `0.0.0.0` | 绑定地址 |
| `--poll-interval` | `2.0` | 指标拉取间隔（秒） |

## 项目结构

```
vLLM_monitor/
├── server.py              # FastAPI 后端
├── requirements.txt       # Python 依赖
├── README.md
└── static/
    ├── index.html         # 仪表盘页面
    ├── css/
    │   └── style.css      # 暗色主题样式
    └── js/
        ├── app.js         # 指标仪表盘逻辑
        └── hashchain.js   # 哈希链树可视化
```

## Demo 模式

如果 vLLM 不可达，监控器自动回退到 Demo 模式，使用内置的模拟数据生成器，方便离线开发和演示。

## 依赖

- Python 3.10+
- FastAPI + Uvicorn
- httpx（异步 HTTP 客户端）
- prometheus_client（Prometheus 文本解析）
- Chart.js + D3.js（前端可视化，CDN 加载）
