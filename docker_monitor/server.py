"""
Docker Monitor - Backend Server
Connects to remote Docker daemon via HTTP API or SSH tunnel, visualizes
image layers and monitors container status.

Usage:
    # Direct Docker API (requires remote Docker TCP port open)
    python server.py --docker-host tcp://10.74.99.215:2375 --port 7870

    # Via SSH tunnel (no remote Docker TCP needed, just SSH access)
    python server.py --ssh-host root@10.74.99.215 --port 7870
"""
import argparse, asyncio, atexit, json, logging, math, random, subprocess, time
from collections import deque
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

import httpx, uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Docker Monitor")
STATIC_DIR = Path(__file__).parent / "static"
LOG_DIR = STATIC_DIR.parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

for _logfile in (LOG_DIR / "monitor.log", LOG_DIR / "frontend.log"):
    _logfile.write_text("", encoding="utf-8")

# --- Logger setup ---
logger = logging.getLogger("docker_monitor")
logger.setLevel(logging.DEBUG)

ch = logging.StreamHandler()
ch.setLevel(logging.INFO)
ch.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S"))
logger.addHandler(ch)

fh = RotatingFileHandler(LOG_DIR / "monitor.log", maxBytes=10 * 1024 * 1024, backupCount=3, encoding="utf-8")
fh.setLevel(logging.DEBUG)
fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s %(message)s"))
logger.addHandler(fh)

fe_handler = RotatingFileHandler(LOG_DIR / "frontend.log", maxBytes=10 * 1024 * 1024, backupCount=3, encoding="utf-8")
fe_handler.setLevel(logging.DEBUG)
fe_handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
fe_logger = logging.getLogger("docker_monitor.frontend")
fe_logger.addHandler(fe_handler)
fe_logger.propagate = False

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

DOCKER_HOST = "tcp://localhost:2375"
POLL_INTERVAL = 5.0
MAX_HISTORY = 200

connected_clients: set = set()
latest_container_data: list = []
latest_image_data: list = []
docker_connected: bool = False
last_error: str = ""
stats_history: deque = deque(maxlen=MAX_HISTORY)


# ---------------------------------------------------------------------------
# Docker API client
# ---------------------------------------------------------------------------

def _docker_url(path: str) -> str:
    base = DOCKER_HOST.replace("tcp://", "http://")
    return f"{base.rstrip('/')}{path}"


async def fetch_docker(path: str) -> dict | list | None:
    """Fetch from Docker Engine API."""
    url = _docker_url(path)
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.json()


async def fetch_image_info(image_name: str) -> dict | None:
    """Get full image inspect (includes layer history)."""
    try:
        return await fetch_docker(f"/images/{image_name}/json")
    except Exception as e:
        logger.warning(f"Failed to fetch image {image_name}: {e}")
        return None


async def fetch_container_list() -> list:
    """List all containers (running + stopped)."""
    try:
        return await fetch_docker("/containers/json?all=true&size=true") or []
    except Exception as e:
        logger.warning(f"Failed to fetch containers: {e}")
        return []


async def fetch_container_stats(container_id: str) -> dict | None:
    """Get one-shot stats for a container."""
    try:
        return await fetch_docker(f"/containers/{container_id}/stats?stream=false")
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Image layer tree builder
# ---------------------------------------------------------------------------

def build_layer_tree(image_info: dict) -> dict:
    """Build a layer dependency tree from Docker image inspect data.

    Docker images consist of ordered layers in RootFS.Layers.
    Each layer depends on the previous one, forming a linear chain.
    History entries provide the commands that created each layer.
    """
    rootfs = image_info.get("RootFS", {})
    layers = rootfs.get("Layers", [])
    history = image_info.get("History", [])

    nodes = []
    edges = []

    created_by_history = [h.get("CreatedBy", "") for h in history]

    # Some history entries don't produce layers (empty_layer: true)
    layer_idx = 0
    for i, cmd in enumerate(created_by_history):
        is_empty = i < len(history) and history[i].get("EmptyLayer", False)
        if is_empty:
            continue

        layer_id = layers[layer_idx] if layer_idx < len(layers) else f"unknown_{layer_idx}"
        # Extract a short readable ID
        short_id = layer_id.split(":")[-1][:12] if ":" in layer_id else layer_id[:12]

        # Parse size
        size = 0
        if layer_idx < len(layers):
            size = image_info.get("Size", 0) // max(len(layers), 1)

        # Parse command into human-readable form
        command = _parse_layer_command(cmd)

        nodes.append({
            "id": short_id,
            "full_id": layer_id,
            "index": layer_idx,
            "indexAll": i,
            "command": command,
            "size": size,
            "is_root": layer_idx == 0,
            "is_leaf": False,
        })

        if layer_idx > 0:
            prev_short = layers[layer_idx - 1].split(":")[-1][:12] if ":" in layers[layer_idx - 1] else layers[layer_idx - 1][:12]
            edges.append({"source": prev_short, "target": short_id})

        layer_idx += 1

    # Mark leaf node
    if nodes:
        nodes[-1]["is_leaf"] = True

    return {
        "nodes": nodes,
        "edges": edges,
        "total_layers": len(nodes),
        "total_size": image_info.get("Size", 0),
        "image_id": image_info.get("Id", "")[:12],
        "created": image_info.get("Created", ""),
        "os": image_info.get("Os", "linux"),
        "architecture": image_info.get("Architecture", ""),
    }


def _parse_layer_command(cmd: str) -> str:
    """Extract human-readable command from Docker history CreatedBy."""
    if not cmd:
        return "(empty)"
    # Remove leading /bin/sh -c or /bin/bash -c
    prefixes = [
        '/bin/sh -c ',
        '/bin/bash -c ',
        '/bin/sh -c',
        '/bin/bash -c',
    ]
    for prefix in prefixes:
        if cmd.startswith(prefix):
            cmd = cmd[len(prefix):]
            break
    # Remove surrounding quotes
    cmd = cmd.strip()
    if (cmd.startswith('#') and cmd.endswith('#')) or \
       (cmd.startswith('"') and cmd.endswith('"')):
        cmd = cmd[1:-1].strip()

    # Truncate long RUN commands
    if len(cmd) > 120:
        # Try to find a good break point
        if '&&' in cmd:
            parts = cmd.split('&&')
            cmd = parts[0].strip() + f" && ... ({len(parts)-1} more)"
        else:
            cmd = cmd[:117] + "..."

    return cmd or "(empty)"


# ---------------------------------------------------------------------------
# Container stats computation
# ---------------------------------------------------------------------------

def compute_container_stats(container: dict, raw_stats: dict | None) -> dict:
    """Compute human-readable stats from Docker stats API."""
    cpu_pct = 0.0
    mem_usage = 0
    mem_limit = 0
    mem_pct = 0.0
    net_rx = 0
    net_tx = 0
    blk_read = 0
    blk_write = 0

    if raw_stats:
        # CPU
        cpu_delta = raw_stats.get("cpu_stats", {}).get("cpu_usage", {}).get("total_usage", 0) - \
                    raw_stats.get("precpu_stats", {}).get("cpu_usage", {}).get("total_usage", 0)
        system_delta = raw_stats.get("cpu_stats", {}).get("system_cpu_usage", 0) - \
                       raw_stats.get("precpu_stats", {}).get("system_cpu_usage", 0)
        num_cpus = raw_stats.get("cpu_stats", {}).get("online_cpus", 1)
        if system_delta > 0 and cpu_delta > 0:
            cpu_pct = (cpu_delta / system_delta) * num_cpus * 100.0

        # Memory
        mem_usage = raw_stats.get("memory_stats", {}).get("usage", 0)
        mem_limit = raw_stats.get("memory_stats", {}).get("limit", 0)
        if mem_limit > 0:
            mem_pct = (mem_usage / mem_limit) * 100.0

        # Network
        networks = raw_stats.get("networks", {})
        for iface, net in networks.items():
            net_rx += net.get("rx_bytes", 0)
            net_tx += net.get("tx_bytes", 0)

        # Block I/O
        bio = raw_stats.get("blkio_stats", {}).get("io_service_bytes_recursive", [])
        for entry in bio:
            if entry.get("op") == "read":
                blk_read += entry.get("value", 0)
            elif entry.get("op") == "write":
                blk_write += entry.get("value", 0)

    return {
        "id": container.get("Id", "")[:12],
        "full_id": container.get("Id", ""),
        "name": (container.get("Names", [""])[0] or "/").lstrip("/"),
        "image": container.get("Image", ""),
        "state": container.get("State", "unknown"),
        "status": container.get("Status", ""),
        "created": container.get("Created", 0),
        "ports": _format_ports(container.get("Ports", [])),
        "cpu_pct": round(cpu_pct, 2),
        "mem_usage": mem_usage,
        "mem_limit": mem_limit,
        "mem_pct": round(mem_pct, 2),
        "net_rx": net_rx,
        "net_tx": net_tx,
        "blk_read": blk_read,
        "blk_write": blk_write,
        "pid_count": raw_stats.get("pids_stats", {}).get("current", 0) if raw_stats else 0,
    }


def _format_ports(ports: list) -> str:
    if not ports:
        return ""
    formatted = []
    for p in ports:
        private = p.get("PrivatePort", "")
        public = p.get("PublicPort", "")
        pt = p.get("Type", "tcp")
        ip = p.get("IP", "")
        if public and ip:
            formatted.append(f"{ip}:{public}->{private}/{pt}")
        elif public:
            formatted.append(f"{public}->{private}/{pt}")
        else:
            formatted.append(f"{private}/{pt}")
    return ", ".join(formatted)


# ---------------------------------------------------------------------------
# Mock data generators (demo mode)
# ---------------------------------------------------------------------------

class MockDockerData:
    """Simulates vLLM Docker containers for demo mode."""

    VLLM_IMAGE = "vllm/vllm-openai:v0.21.0rc1"

    MOCK_IMAGE = {
        "Id": "sha256:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
        "Created": "2026-05-14T10:00:00Z",
        "Os": "linux",
        "Architecture": "amd64",
        "Size": 15_000_000_000,
        "RootFS": {
            "Type": "layers",
            "Layers": [
                "sha256:m1_base_ubuntu_2204",
                "sha256:m2_cuda_1302_base",
                "sha256:m3_nvidia_cudnn_cublas",
                "sha256:m4_python_env_setup",
                "sha256:m5_pip_install_uv",
                "sha256:m6_pytorch_2110_cu130",
                "sha256:m7_vllm_dependencies",
                "sha256:m8_flashinfer_library",
                "sha256:m9_deepgemm_kernels",
                "sha256:m10_vllm_source_code",
                "sha256:m11_vllm_wheel_build",
                "sha256:m12_vllm_openai_entry",
            ],
        },
        "History": [
            {"CreatedBy": "/bin/sh -c #(nop) ADD file:ubuntu2204.tar.gz /"},
            {"CreatedBy": "/bin/sh -c #(nop) LABEL nvidia.cuda.version=13.0.2"},
            {"CreatedBy": "/bin/sh -c apt-get update && apt-get install -y cuda-toolkit-13-0"},
            {"CreatedBy": "/bin/sh -c apt-get install -y python3.12 python3-pip"},
            {"CreatedBy": "/bin/sh -c pip install uv && uv venv /opt/venv --python 3.12"},
            {"CreatedBy": "/bin/sh -c uv pip install torch==2.11.0 --extra-index-url https://download.pytorch.org/whl/cu130"},
            {"CreatedBy": "/bin/sh -c uv pip install -r requirements/cuda.txt"},
            {"CreatedBy": "/bin/sh -c bash tools/flashinfer-build.sh"},
            {"CreatedBy": "/bin/sh -c bash tools/install_deepgemm.sh && bash tools/ep_kernels/install_python_libraries.sh"},
            {"CreatedBy": "/bin/sh -c COPY . /workspace/vllm"},
            {"CreatedBy": "/bin/sh -c python setup.py bdist_wheel && pip install dist/*.whl"},
            {"CreatedBy": "/bin/sh -c #(nop) EXPOSE 8000\n#(nop) ENTRYPOINT ['vllm serve']"},
        ],
    }

    MOCK_CONTAINERS = [
        {
            "Id": "c0nta1n3r11111111111111111111111",
            "Names": ["/vllm-serve-qwen3-32b"],
            "Image": VLLM_IMAGE,
            "State": "running",
            "Status": "Up 3 days",
            "Created": int(time.time()) - 259200,
            "Ports": [{"PrivatePort": 8000, "PublicPort": 8000, "Type": "tcp", "IP": "0.0.0.0"}],
        },
        {
            "Id": "c0nta1n3r22222222222222222222222",
            "Names": ["/vllm-serve-deepseek-v3"],
            "Image": VLLM_IMAGE,
            "State": "running",
            "Status": "Up 12 hours",
            "Created": int(time.time()) - 43200,
            "Ports": [{"PrivatePort": 8000, "PublicPort": 8001, "Type": "tcp", "IP": "0.0.0.0"}],
        },
        {
            "Id": "c0nta1n3r33333333333333333333333",
            "Names": ["/vllm-serve-llama3-70b"],
            "Image": VLLM_IMAGE,
            "State": "exited",
            "Status": "Exited (0) 2 hours ago",
            "Created": int(time.time()) - 172800,
            "Ports": [],
        },
    ]

    _tick = 0

    @classmethod
    def generate_stats(cls, container: dict) -> dict:
        cls._tick += 1
        running = container.get("State") == "running"

        base_cpu = 45 + 20 * math.sin(cls._tick * 0.05)
        cpu_pct = base_cpu + random.uniform(-15, 15) if running else 0

        mem_usage_base = 45_000_000_000 + random.uniform(-2e9, 2e9) if running else 0
        mem_limit = 128_000_000_000
        mem_pct = (mem_usage_base / mem_limit) * 100 if running else 0

        return {
            "cpu_stats": {
                "cpu_usage": {"total_usage": int(1_000_000_000_000 + cls._tick * 1e8 * (1 if running else 0))},
                "system_cpu_usage": int(5_000_000_000_000 + cls._tick * 2e8),
                "online_cpus": 8,
            },
            "precpu_stats": {
                "cpu_usage": {"total_usage": int(1_000_000_000_000 + (cls._tick - 1) * 1e8 * (1 if running else 0))},
                "system_cpu_usage": int(5_000_000_000_000 + (cls._tick - 1) * 2e8),
            },
            "memory_stats": {
                "usage": int(mem_usage_base),
                "limit": mem_limit,
            },
            "networks": {
                "eth0": {
                    "rx_bytes": int(500_000_000_000 + cls._tick * 1e6),
                    "tx_bytes": int(200_000_000_000 + cls._tick * 5e5),
                }
            } if running else {},
            "blkio_stats": {
                "io_service_bytes_recursive": [
                    {"op": "read", "value": int(100_000_000 + cls._tick * 1e5)},
                    {"op": "write", "value": int(50_000_000 + cls._tick * 5e4)},
                ]
            },
            "pids_stats": {"current": int(12 + random.uniform(0, 5))},
        }


# ---------------------------------------------------------------------------
# SSH tunnel for remote Docker socket (no TCP API port needed)
# ---------------------------------------------------------------------------

_ssh_tunnel_procs: list = []


def _cleanup_ssh_tunnels():
    """Kill all SSH tunnel subprocesses on exit."""
    for p in _ssh_tunnel_procs:
        try:
            p.terminate()
            p.wait(timeout=3)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass


atexit.register(_cleanup_ssh_tunnels)


def setup_ssh_tunnel(ssh_target: str, local_port: int = 2375) -> bool:
    """Forward remote Docker Unix socket to local TCP port via SSH.

    Two-step process over a single SSH session:
    1. Start socat on remote to bridge Unix socket -> TCP port (127.0.0.1 only)
    2. Local port forward to that remote TCP port

    Requires socat on the remote server. If not installed:
        apt-get install socat   # or: yum install socat
    """
    bridge_port = local_port + 5000  # remote bridge listens on 127.0.0.1:7375

    ssh_base = [
        "ssh", "-o", "StrictHostKeyChecking=no",
        "-o", "ServerAliveInterval=30",
    ]

    # Step 1: Start remote socat bridge (binds to 127.0.0.1 only, not exposed)
    remote_cmd = (
        f"socat TCP-LISTEN:{bridge_port},bind=127.0.0.1,fork,reuseaddr "
        f"UNIX-CONNECT:/var/run/docker.sock"
    )
    logger.info(f"[ssh] Starting remote socat bridge at 127.0.0.1:{bridge_port}...")
    p1 = subprocess.Popen(
        ssh_base + [ssh_target, f"nohup {remote_cmd} >/dev/null 2>&1 & echo $!"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    _ssh_tunnel_procs.append(p1)
    time.sleep(2)

    # Step 2: Set up local port forward
    logger.info(f"[ssh] Setting up local port forward localhost:{local_port} -> remote 127.0.0.1:{bridge_port}...")
    p2 = subprocess.Popen(
        ssh_base + ["-N", "-L", f"{local_port}:127.0.0.1:{bridge_port}", ssh_target],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    _ssh_tunnel_procs.append(p2)
    time.sleep(1.5)

    if p2.poll() is not None:
        stderr_output = p2.stderr.read().decode(errors="replace") if p2.stderr else ""
        logger.error(
            f"[ssh] Tunnel failed. Is socat installed on remote? "
            f"(try: ssh {ssh_target} 'which socat')\n{stderr_output}"
        )
        return False

    logger.info(f"[ssh] Tunnel ready: localhost:{local_port} -> {ssh_target}:/var/run/docker.sock")
    return True


# ---------------------------------------------------------------------------
# Metrics scraping loop
# ---------------------------------------------------------------------------

async def scrape_loop():
    global latest_container_data, latest_image_data, docker_connected, last_error
    was_connected = False

    while True:
        try:
            # Fetch containers
            containers = await fetch_container_list()

            # Get stats for each container
            enriched = []
            for c in containers:
                try:
                    raw_stats = await fetch_container_stats(c["Id"])
                except Exception:
                    raw_stats = None
                enriched.append(compute_container_stats(c, raw_stats))

            latest_container_data = enriched
            docker_connected = True
            last_error = ""
            if not was_connected:
                logger.info(f"Connected to Docker at {DOCKER_HOST}")
                was_connected = True

            # Collect aggregate stats for history
            running = [c for c in enriched if c["state"] == "running"]
            total_cpu = sum(c["cpu_pct"] for c in running)
            total_mem = sum(c["mem_usage"] for c in running)
            stats_history.append({
                "ts": time.time(),
                "cpu": round(total_cpu, 2),
                "mem": total_mem,
                "running_count": len(running),
                "total_count": len(enriched),
            })

        except Exception as e:
            if docker_connected:
                logger.warning(f"Lost connection to Docker: {e}")
            docker_connected = False
            last_error = str(e)
            was_connected = False

            # Mock data
            enriched = []
            for c in MockDockerData.MOCK_CONTAINERS:
                raw = MockDockerData.generate_stats(c)
                enriched.append(compute_container_stats(c, raw))
            latest_container_data = enriched

            running = [c for c in enriched if c["state"] == "running"]
            total_cpu = sum(c["cpu_pct"] for c in running)
            total_mem = sum(c["mem_usage"] for c in running)
            stats_history.append({
                "ts": time.time(),
                "cpu": round(total_cpu, 2),
                "mem": total_mem,
                "running_count": len(running),
                "total_count": len(enriched),
            })

        await broadcast_update()
        await asyncio.sleep(POLL_INTERVAL)


async def broadcast_update():
    if not connected_clients:
        return
    msg = json.dumps({
        "type": "containers",
        "data": latest_container_data,
        "docker_connected": docker_connected,
        "timestamp": time.time(),
    })
    dead = []
    for ws in connected_clients:
        try:
            await ws.send_text(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        connected_clients.discard(ws)


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------

@app.get("/")
async def index():
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"))


@app.post("/api/log")
async def frontend_log(request: Request):
    try:
        body = await request.json()
        level = body.get("level", "INFO")
        message = body.get("message", "")
        extra = body.get("extra", {})
        log_msg = f"[{level}] {message}"
        if extra:
            log_msg += " | " + json.dumps(extra, default=str)
        fe_logger.info(log_msg)
    except Exception:
        pass
    return JSONResponse({"ok": True})


@app.get("/api/status")
async def get_status():
    return {
        "docker_connected": docker_connected,
        "docker_host": DOCKER_HOST,
        "last_error": last_error,
        "poll_interval": POLL_INTERVAL,
        "demo_mode": not docker_connected,
        "container_count": len(latest_container_data),
    }


@app.get("/api/containers")
async def get_containers():
    return JSONResponse({
        "data": latest_container_data,
        "docker_connected": docker_connected,
        "demo_mode": not docker_connected,
        "timestamp": time.time(),
    })


@app.get("/api/stats/history")
async def get_stats_history():
    history = list(stats_history)
    return JSONResponse({"history": history, "count": len(history)})


@app.post("/api/image/layers")
async def get_image_layers(body: dict):
    """Get layer tree for a specific Docker image.

    Accepts either an explicit image info object (from demo mode)
    or fetches from the remote Docker daemon using the image name.
    """
    image_ref = body.get("image", "")
    if not image_ref:
        return JSONResponse({"error": "No image specified"}, status_code=400)

    if docker_connected:
        info = await fetch_image_info(image_ref)
        if not info:
            return JSONResponse(
                {"error": f"Image '{image_ref}' not found on remote Docker host"},
                status_code=404,
            )
    else:
        info = MockDockerData.MOCK_IMAGE

    result = build_layer_tree(info)
    result["image_ref"] = image_ref
    result["is_demo"] = not docker_connected
    return JSONResponse(result)


@app.get("/api/image/layers/demo")
async def get_image_layers_demo():
    """Get demo layer tree for vLLM image."""
    info = MockDockerData.MOCK_IMAGE
    result = build_layer_tree(info)
    result["image_ref"] = MockDockerData.VLLM_IMAGE
    result["is_demo"] = True
    return JSONResponse(result)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    connected_clients.add(ws)
    try:
        if latest_container_data:
            await ws.send_text(json.dumps({
                "type": "containers",
                "data": latest_container_data,
                "docker_connected": docker_connected,
                "timestamp": time.time(),
            }))
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        connected_clients.discard(ws)
    except Exception:
        connected_clients.discard(ws)


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(scrape_loop())


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Docker Monitor")
    parser.add_argument("--docker-host", default="tcp://localhost:2375",
                        help="Remote Docker API endpoint (e.g. tcp://10.74.99.215:2375)")
    parser.add_argument("--ssh-host", default=None,
                        help="SSH target for tunneling Docker socket (e.g. root@10.74.99.215). "
                             "No remote Docker TCP port needed. Requires socat on remote.")
    parser.add_argument("--ssh-tunnel-port", type=int, default=2375,
                        help="Local port for SSH tunnel (default: 2375)")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind")
    parser.add_argument("--port", type=int, default=7870, help="Port to bind")
    parser.add_argument("--poll-interval", type=float, default=5.0,
                        help="Container poll interval in seconds")
    args = parser.parse_args()

    # Handle SSH tunnel mode
    if args.ssh_host:
        ok = setup_ssh_tunnel(args.ssh_host, local_port=args.ssh_tunnel_port)
        if not ok:
            logger.error(
                "SSH tunnel setup failed. Falling back to demo mode.\n"
                "Make sure:\n"
                f"  1. SSH to {args.ssh_host} works (key-based or ssh-agent)\n"
                f"  2. socat is installed on remote: ssh {args.ssh_host} 'which socat'\n"
                f"     Install: apt-get install socat  (or yum install socat)"
            )
            # Continue with demo mode — DOCKER_HOST stays localhost:2375
        DOCKER_HOST = f"tcp://localhost:{args.ssh_tunnel_port}"
    else:
        DOCKER_HOST = args.docker_host.rstrip("/")

    POLL_INTERVAL = args.poll_interval

    logger.info("Docker Monitor starting...")
    logger.info(f"  Docker Host: {DOCKER_HOST}")
    logger.info(f"  Dashboard:   http://localhost:{args.port}")
    logger.info(f"  Poll interval: {POLL_INTERVAL}s")
    if args.ssh_host:
        logger.info(f"  SSH Tunnel:  {args.ssh_host}:/var/run/docker.sock -> localhost:{args.ssh_tunnel_port}")
    elif DOCKER_HOST == "tcp://localhost:2375":
        logger.info("  (Demo mode activates if Docker daemon is not reachable)")

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
