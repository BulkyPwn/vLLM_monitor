"""
vLLM Monitor - Backend Server
Scrapes vLLM Prometheus metrics, serves a real-time dashboard,
and simulates prefix cache hash chains for visualization.

Usage:
    pip install -r requirements.txt
    python server.py --vllm-url http://localhost:8000 --port 7860
"""
import argparse, asyncio, hashlib, json, math, random, re, struct, time
from collections import deque
from pathlib import Path
from typing import Any

import httpx, uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from prometheus_client.parser import text_string_to_metric_families

try:
    import zmq
    HAS_ZMQ = True
except ImportError:
    HAS_ZMQ = False

try:
    import msgspec
    HAS_MSGSPEC = True
except ImportError:
    HAS_MSGSPEC = False

app = FastAPI(title="vLLM Monitor")
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

VLLM_URL = "http://localhost:8000"
POLL_INTERVAL = 2.0
MAX_HISTORY = 300
BLOCK_SIZE = 16
KV_EVENTS_ENDPOINT = None   # "tcp://host:5557" to enable live KV events

metrics_history: deque = deque(maxlen=MAX_HISTORY)
latest_raw_metrics: dict = {}
connected_clients: set = set()
vllm_connected: bool = False
last_error: str = ""

# KV Events live hash chain state
kv_events_enabled: bool = False
kv_events_block_map: dict = {}   # block_hash (16-byte bytes) -> node info
kv_events_root_hashes: set = set()  # blocks with no parent

# ---------------------------------------------------------------------------
# Prometheus metrics parsing
# ---------------------------------------------------------------------------

def parse_prometheus_text(text: str) -> dict:
    result: dict = {"gauges": {}, "counters": {}, "histograms": {}}
    try:
        for family in text_string_to_metric_families(text):
            ftype = family.type
            for sample in family.samples:
                sname, labels, value = sample.name, sample.labels, sample.value
                if ftype == "histogram":
                    if sname.endswith("_bucket"):
                        base = sname[:-7]
                    elif sname.endswith("_sum"):
                        base = sname[:-4]
                    elif sname.endswith("_count"):
                        base = sname[:-6]
                    else:
                        base = sname
                    label_key = _labels_to_key(labels, ["le"])
                    hkey = f"{base}||{label_key}"
                    if hkey not in result["histograms"]:
                        result["histograms"][hkey] = {
                            "name": base,
                            "labels": {k: v for k, v in labels.items() if k != "le"},
                            "count": 0.0, "sum": 0.0, "buckets": {},
                        }
                    hist = result["histograms"][hkey]
                    if sname.endswith("_bucket"):
                        hist["buckets"][labels.get("le", "+Inf")] = value
                    elif sname.endswith("_count"):
                        hist["count"] = value
                    elif sname.endswith("_sum"):
                        hist["sum"] = value
                elif ftype in ("gauge", "untyped"):
                    result["gauges"][f"{sname}||{_labels_to_key(labels)}"] = {
                        "name": sname, "labels": labels, "value": value}
                elif ftype == "counter":
                    result["counters"][f"{sname}||{_labels_to_key(labels)}"] = {
                        "name": sname, "labels": labels, "value": value}
    except Exception:
        pass
    return result


def _labels_to_key(labels: dict, exclude: list = None) -> str:
    excl = set(exclude or [])
    items = sorted((k, v) for k, v in labels.items() if k not in excl)
    return ",".join(f"{k}={v}" for k, v in items)


def extract_vllm_metrics(parsed: dict) -> dict:
    out: dict = {
        "timestamp": time.time(),
        "system": {}, "tokens": {}, "latency": {},
        "requests": {}, "prefix_cache": {}, "spec_decode": {}, "lora": {},
    }

    def g(nf):
        for k, i in parsed["gauges"].items():
            if nf in i["name"]:
                return i["value"]
        return None

    def c(nf):
        for k, i in parsed["counters"].items():
            if nf in i["name"]:
                return i["value"]
        return None

    def h(nf):
        for k, i in parsed["histograms"].items():
            if nf in i["name"]:
                return i
        return None

    out["system"]["num_requests_running"] = g("num_requests_running")
    out["system"]["num_requests_waiting"] = g("num_requests_waiting")
    out["system"]["num_requests_swapped"] = g("num_requests_swapped")
    out["system"]["gpu_cache_usage_perc"] = g("gpu_cache_usage_perc")
    out["system"]["cpu_cache_usage_perc"] = g("cpu_cache_usage_perc")
    out["system"]["num_preemptions"] = c("num_preemptions")
    out["system"]["cache_config_info"] = g("cache_config_info")

    out["tokens"]["prompt_total"] = c("prompt_tokens_total")
    out["tokens"]["generation_total"] = c("generation_tokens_total")

    out["latency"]["ttft"] = h("time_to_first_token")
    out["latency"]["tpot"] = h("time_per_output_token")
    out["latency"]["e2e_request"] = h("e2e_request_latency")
    out["latency"]["queue_time"] = h("request_queue_time")
    out["latency"]["inference_time"] = h("request_inference_time")
    out["latency"]["prefill_time"] = h("request_prefill_time")
    out["latency"]["decode_time"] = h("request_decode_time")
    out["latency"]["time_in_queue"] = h("time_in_queue_requests")
    out["latency"]["model_forward_ms"] = h("model_forward_time")
    out["latency"]["model_execute_ms"] = h("model_execute_time")

    out["requests"]["success_total"] = c("request_success")
    by_reason = {}
    for k, i in parsed["counters"].items():
        if "request_success" in i["name"]:
            by_reason[i["labels"].get("finished_reason", "unknown")] = i["value"]
    out["requests"]["success_by_reason"] = by_reason
    out["requests"]["prompt_tokens_hist"] = h("request_prompt_tokens")
    out["requests"]["gen_tokens_hist"] = h("request_generation_tokens")
    out["requests"]["max_gen_tokens_hist"] = h("request_max_num_generation_tokens")
    out["requests"]["params_n_hist"] = h("request_params_n")
    out["requests"]["params_max_tokens_hist"] = h("request_params_max_tokens")
    out["requests"]["iteration_tokens"] = h("iteration_tokens")

    out["prefix_cache"]["gpu_hit_rate"] = g("gpu_prefix_cache_hit_rate")
    out["prefix_cache"]["cpu_hit_rate"] = g("cpu_prefix_cache_hit_rate")

    out["spec_decode"]["draft_acceptance_rate"] = g("spec_decode_draft_acceptance_rate")
    out["spec_decode"]["efficiency"] = g("spec_decode_efficiency")
    out["spec_decode"]["num_accepted"] = c("spec_decode_num_accepted_tokens")
    out["spec_decode"]["num_draft"] = c("spec_decode_num_draft_tokens")
    out["spec_decode"]["num_emitted"] = c("spec_decode_num_emitted_tokens")

    out["lora"]["requests_info"] = g("lora_requests_info")
    out["flat"] = _flatten_metrics(out)
    return out


def _flatten_metrics(metrics: dict) -> dict:
    flat = {}
    def ss(key, val):
        if val is not None:
            if isinstance(val, dict):
                if "count" in val: flat[key + "_count"] = val["count"]
                if "sum" in val: flat[key + "_sum"] = val["sum"]
            else:
                flat[key] = val
    ss("num_requests_running", metrics["system"].get("num_requests_running"))
    ss("num_requests_waiting", metrics["system"].get("num_requests_waiting"))
    ss("num_requests_swapped", metrics["system"].get("num_requests_swapped"))
    ss("gpu_cache_usage", metrics["system"].get("gpu_cache_usage_perc"))
    ss("cpu_cache_usage", metrics["system"].get("cpu_cache_usage_perc"))
    ss("prompt_tokens", metrics["tokens"].get("prompt_total"))
    ss("generation_tokens", metrics["tokens"].get("generation_total"))
    ss("gpu_prefix_hit_rate", metrics["prefix_cache"].get("gpu_hit_rate"))
    ss("cpu_prefix_hit_rate", metrics["prefix_cache"].get("cpu_hit_rate"))
    for name, hist in metrics["latency"].items():
        if hist and isinstance(hist, dict):
            p50, p95, p99 = histogram_percentiles(hist)
            if p50 is not None: flat[f"latency_{name}_p50"] = p50
            if p95 is not None: flat[f"latency_{name}_p95"] = p95
            if p99 is not None: flat[f"latency_{name}_p99"] = p99
    return flat


def histogram_percentiles(hist: dict):
    if not hist.get("buckets") or hist.get("count", 0) == 0:
        return None, None, None
    total = hist["count"]
    buckets = sorted(hist["buckets"].items(),
                     key=lambda x: float(x[0]) if x[0] != "+Inf" else float("inf"))
    def pct(p):
        target = total * p
        for le, count in buckets:
            if count >= target:
                if le == "+Inf" and len(buckets) > 1:
                    return float(buckets[-2][0])
                return float(le)
        return None
    return pct(0.5), pct(0.95), pct(0.99)

# ---------------------------------------------------------------------------
# Mock metrics generator (demo mode when vLLM not available)
# ---------------------------------------------------------------------------

class MockMetricsGenerator:
    def __init__(self):
        self.prompt_tokens = 0
        self.gen_tokens = 0
        self.success_count = 0
        self.preemptions = 0
        self.spec_accepted = 0
        self.spec_draft = 0
        self.spec_emitted = 0
        self.tick = 0

    def generate(self) -> str:
        self.tick += 1
        base_load = 3 + 2 * math.sin(self.tick * 0.05) + random.uniform(-1, 1)
        running = max(0, int(base_load))
        waiting = max(0, int(random.uniform(0, 3) + max(0, base_load - 5)))
        swapped = max(0, int(random.uniform(0, 1)))
        gpu_usage = min(0.98, 0.1 + running * 0.05 + random.uniform(-0.02, 0.05))
        cpu_usage = min(0.8, gpu_usage * 0.3 + random.uniform(0, 0.1))
        gpu_hit = max(0, min(1, 0.6 + 0.2 * math.sin(self.tick * 0.03) + random.uniform(-0.05, 0.05)))
        cpu_hit = max(0, min(1, gpu_hit * 0.5 + random.uniform(-0.1, 0.1)))
        self.prompt_tokens += int(random.uniform(100, 500) * running)
        self.gen_tokens += int(random.uniform(100, 400) * running)
        self.success_count += max(0, running - random.randint(0, 2))
        self.spec_accepted += int(random.uniform(50, 200))
        self.spec_draft += int(random.uniform(70, 280))
        self.spec_emitted += int(random.uniform(55, 210))
        if random.random() < 0.05:
            self.preemptions += 1

        m = "mock-model"
        L = []
        def gauge(n, v, ht):
            L.append(f"# HELP {n} {ht}\n# TYPE {n} gauge\n{n}{{model_name=\"{m}\"}} {v}")
        def counter(n, v, ht):
            L.append(f"# HELP {n} {ht}\n# TYPE {n} counter\n{n}{{model_name=\"{m}\"}} {v}")
        def histogram(n, cnt, s, bks, ht):
            lines = [f"# HELP {n} {ht}", f"# TYPE {n} histogram"]
            for le, c in bks:
                lines.append(f'{n}_bucket{{le="{le}",model_name="{m}"}} {c}')
            lines.append(f'{n}_bucket{{le="+Inf",model_name="{m}"}} {cnt}')
            lines.append(f'{n}_sum{{model_name="{m}"}} {s}')
            lines.append(f'{n}_count{{model_name="{m}"}} {cnt}')
            L.append("\n".join(lines))
        def mb(cnt, med, sp):
            les = [0.001,0.005,0.01,0.025,0.05,0.1,0.25,0.5,1.0,2.5,5.0,10.0]
            out = []
            for le in les:
                if le < med:
                    frac = (le/med)**0.5*0.3
                else:
                    frac = 0.3+0.7*(1-math.exp(-(le-med)/sp))
                out.append((le, min(cnt, int(cnt*frac))))
            return out

        gauge("vllm:num_requests_running", running, "Running")
        gauge("vllm:num_requests_waiting", waiting, "Waiting")
        gauge("vllm:num_requests_swapped", swapped, "Swapped")
        gauge("vllm:gpu_cache_usage_perc", gpu_usage, "GPU cache")
        gauge("vllm:cpu_cache_usage_perc", cpu_usage, "CPU cache")
        gauge("vllm:gpu_prefix_cache_hit_rate", gpu_hit, "GPU prefix hit")
        gauge("vllm:cpu_prefix_cache_hit_rate", cpu_hit, "CPU prefix hit")
        gauge("vllm:cache_config_info", 1.0, "Cache config")
        gauge("vllm:spec_decode_draft_acceptance_rate", 0.72, "Spec acceptance")
        gauge("vllm:spec_decode_efficiency", 0.68, "Spec efficiency")
        counter("vllm:prompt_tokens_total", self.prompt_tokens, "Prompt tokens")
        counter("vllm:generation_tokens_total", self.gen_tokens, "Gen tokens")
        counter("vllm:num_preemptions_total", self.preemptions, "Preemptions")
        counter("vllm:spec_decode_num_accepted_tokens_total", self.spec_accepted, "Spec accepted")
        counter("vllm:spec_decode_num_draft_tokens_total", self.spec_draft, "Spec draft")
        counter("vllm:spec_decode_num_emitted_tokens_total", self.spec_emitted, "Spec emitted")
        for reason in ("stop", "length", "abort"):
            val = self.success_count // 3 if reason == "stop" else self.success_count // 6
            L.append(f'# TYPE vllm:request_success_total counter\nvllm:request_success_total{{finished_reason="{reason}",model_name="{m}"}} {val}')

        sc = self.success_count + 1
        histogram("vllm:time_to_first_token_seconds", sc, sc*0.1, mb(sc,0.08,0.15), "TTFT")
        histogram("vllm:time_per_output_token_seconds", self.gen_tokens+1, (self.gen_tokens+1)*0.025, mb(self.gen_tokens+1,0.02,0.03), "TPOT")
        histogram("vllm:e2e_request_latency_seconds", sc, sc*0.6, mb(sc,0.5,1.0), "E2E")
        histogram("vllm:request_queue_time_seconds", sc, sc*0.02, mb(sc,0.01,0.05), "Queue")
        histogram("vllm:request_inference_time_seconds", sc, sc*0.5, mb(sc,0.4,0.8), "Inference")
        histogram("vllm:request_prefill_time_seconds", sc, sc*0.15, mb(sc,0.1,0.2), "Prefill")
        histogram("vllm:request_decode_time_seconds", sc, sc*0.4, mb(sc,0.3,0.6), "Decode")
        histogram("vllm:request_prompt_tokens", sc, sc*400, mb(sc,500,1000), "Prompt tokens hist")
        histogram("vllm:request_generation_tokens", sc, sc*80, mb(sc,100,200), "Gen tokens hist")
        histogram("vllm:iteration_tokens_total", sc*10, sc*60, mb(sc*10,5,10), "Iter tokens")
        histogram("vllm:model_forward_time_milliseconds", sc*10, sc*250, mb(sc*10,20,40), "Forward ms")
        histogram("vllm:model_execute_time_milliseconds", sc*10, sc*300, mb(sc*10,25,50), "Execute ms")
        histogram("vllm:request_params_n", sc, sc*1.2, [(1,sc),(2,sc),(4,sc)], "Params n")
        histogram("vllm:request_params_max_tokens", sc, sc*200, mb(sc,256,500), "Max tokens")
        lv = running if random.random() < 0.3 else 0
        L.append(f'# TYPE vllm:lora_requests_info gauge\nvllm:lora_requests_info{{running_lora_adapters="{lv}",waiting_lora_adapters="0",max_lora="1"}} {lv}')
        return "\n".join(L) + "\n"

mock_gen = MockMetricsGenerator()

# ---------------------------------------------------------------------------
# Metrics scraping loop
# ---------------------------------------------------------------------------

async def scrape_loop():
    global latest_raw_metrics, vllm_connected, last_error
    async with httpx.AsyncClient(timeout=10.0, trust_env=False) as client:
        while True:
            try:
                resp = await client.get(f"{VLLM_URL}/metrics")
                resp.raise_for_status()
                raw_text = resp.text
                vllm_connected = True
                last_error = ""
            except Exception as e:
                vllm_connected = False
                last_error = str(e)
                raw_text = mock_gen.generate()
            try:
                parsed = parse_prometheus_text(raw_text)
                extracted = extract_vllm_metrics(parsed)
                latest_raw_metrics = extracted
                metrics_history.append(extracted["flat"])
            except Exception:
                extracted = {}
            await broadcast_metrics(extracted)
            await asyncio.sleep(POLL_INTERVAL)

async def broadcast_metrics(data: dict):
    if not connected_clients:
        return
    msg = json.dumps({"type": "metrics", "data": data,
                      "vllm_connected": vllm_connected, "timestamp": time.time()})
    dead = []
    for ws in connected_clients:
        try:
            await ws.send_text(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        connected_clients.discard(ws)

# ---------------------------------------------------------------------------
# Prefix cache hash chain simulation
# ---------------------------------------------------------------------------

def simple_tokenize(text: str) -> list:
    """Pseudo-tokenizer for visualization (real vLLM uses model tokenizer)."""
    raw_tokens = re.findall(r"\w+|[^\s\w]", text)
    return [hash(tok) & 0x7FFFFFFF for tok in raw_tokens]


def compute_block_hash(parent_hash, block_tokens, extra_hash="") -> str:
    """vLLM-style block hash: sha256(parent_hash + tuple(block_tokens) + extra)."""
    h = hashlib.sha256()
    h.update((parent_hash or "root").encode())
    h.update(str(tuple(block_tokens)).encode())
    if extra_hash:
        h.update(extra_hash.encode())
    return h.hexdigest()[:16]


def build_hash_chain(prompts: list, block_size: int = BLOCK_SIZE,
                     lora_ids: list = None) -> dict:
    """Build prefix cache hash chain tree from multiple prompts.

    Each prompt is split into blocks of block_size tokens.
    Each block hash = hash(parent_hash + block_tokens + extra_hash).
    Blocks with same parent + tokens get same hash = cache hit.
    This forms a tree rooted at the null parent.
    """
    all_blocks: dict = {}
    chains: list = []

    for idx, prompt in enumerate(prompts):
        tokens = simple_tokenize(prompt)
        lora_id = lora_ids[idx] if lora_ids and idx < len(lora_ids) else ""
        extra = f"lora:{lora_id}" if lora_id else ""
        chain_hashes = []
        parent_hash = None

        for i in range(0, max(len(tokens), 1), block_size):
            block_tokens = tokens[i:i + block_size]
            if not block_tokens:
                break
            block_hash = compute_block_hash(parent_hash, block_tokens, extra)

            if block_hash not in all_blocks:
                raw_text = re.findall(r"\w+|[^\s\w]", prompt)
                token_text = raw_text[i:i + block_size]
                all_blocks[block_hash] = {
                    "id": block_hash,
                    "parent": parent_hash,
                    "tokens": block_tokens,
                    "token_text": token_text,
                    "block_index": i // block_size,
                    "ref_count": 0,
                    "prompt_ids": set(),
                    "is_root": parent_hash is None,
                }
            all_blocks[block_hash]["ref_count"] += 1
            all_blocks[block_hash]["prompt_ids"].add(idx)
            chain_hashes.append(block_hash)
            parent_hash = block_hash

        chains.append({
            "prompt_index": idx,
            "prompt": prompt[:200] + ("..." if len(prompt) > 200 else ""),
            "full_prompt": prompt,
            "num_tokens": len(tokens),
            "num_blocks": len(chain_hashes),
            "block_hashes": chain_hashes,
        })

    edges = []
    nodes = []
    for bid, block in all_blocks.items():
        nodes.append({
            "id": bid,
            "parent": block["parent"],
            "token_text": block["token_text"],
            "block_index": block["block_index"],
            "ref_count": block["ref_count"],
            "prompt_ids": sorted(block["prompt_ids"]),
            "is_root": block["is_root"],
            "is_shared": block["ref_count"] > 1,
        })
        if block["parent"]:
            edges.append({"source": block["parent"], "target": bid})

    total_blocks = len(nodes)
    shared_blocks = sum(1 for n in nodes if n["is_shared"])
    total_prompt_blocks = sum(len(c["block_hashes"]) for c in chains)
    saved_blocks = total_prompt_blocks - total_blocks
    hit_rate = saved_blocks / total_prompt_blocks if total_prompt_blocks > 0 else 0

    return {
        "nodes": nodes,
        "edges": edges,
        "chains": chains,
        "stats": {
            "total_blocks": total_blocks,
            "shared_blocks": shared_blocks,
            "unique_blocks": total_blocks - shared_blocks,
            "total_prompt_blocks": total_prompt_blocks,
            "saved_blocks": saved_blocks,
            "estimated_hit_rate": hit_rate,
            "block_size": block_size,
        },
    }


# ---------------------------------------------------------------------------
# KV Events msgpack types (mirrors vllm.distributed.kv_events)
# ---------------------------------------------------------------------------

if HAS_MSGSPEC:

    class EventBatch(msgspec.Struct, array_like=True, omit_defaults=True, gc=False):
        ts: float
        events: list

    class KVCacheEvent(msgspec.Struct, array_like=True, omit_defaults=True, gc=False, tag=True):
        """Base class for all KV cache events."""

    class BlockStored(KVCacheEvent):
        block_hashes: list[int]
        parent_block_hash: int | None = None
        token_ids: list[int] = []
        block_size: int = 16
        lora_id: int | None = None

    class BlockRemoved(KVCacheEvent):
        block_hashes: list[int]

    class AllBlocksCleared(KVCacheEvent):
        pass

    class KVEventBatch(EventBatch):
        events: list[BlockStored | BlockRemoved | AllBlocksCleared]

    _kv_decoder = msgspec.msgpack.Decoder(type=KVEventBatch)

else:
    _kv_decoder = None

# ---------------------------------------------------------------------------
# KV Events live hash chain (ZMQ subscriber)
# ---------------------------------------------------------------------------

def _zmq_listener():
    """ZMQ SUB listener for vLLM kv-events topic (runs in a daemon thread).
    Parses BlockStored / BlockRemoved / AllBlocksCleared events and
    maintains a real-time hash chain tree.
    """
    global kv_events_enabled
    if not HAS_ZMQ or not KV_EVENTS_ENDPOINT:
        return
    if not _kv_decoder:
        print("[kv-events] msgspec not installed. Run: pip install msgspec")
        return

    print(f"[kv-events] Connecting to {KV_EVENTS_ENDPOINT} ...")
    ctx = zmq.Context()
    sub = ctx.socket(zmq.SUB)
    try:
        sub.connect(KV_EVENTS_ENDPOINT)
    except Exception as e:
        print(f"[kv-events] Failed to connect: {e}")
        return

    sub.setsockopt_string(zmq.SUBSCRIBE, "kv-events")
    kv_events_enabled = True
    print(f"[kv-events] Listening on topic 'kv-events'")

    while kv_events_enabled:
        try:
            if sub.poll(500):
                parts = sub.recv_multipart()
                # parts: [topic_bytes, seq_bytes, payload_bytes]
                if len(parts) < 3:
                    continue
                payload = parts[2]
                _process_kv_event(payload)
        except Exception as e:
            print(f"[kv-events] Error: {e}")
            break

    sub.close()
    ctx.term()


def _process_kv_event(payload: bytes):
    """Decode msgpack KVEventBatch and update hash chain state."""
    global kv_events_block_map, kv_events_root_hashes

    try:
        batch: KVEventBatch = _kv_decoder.decode(payload)
    except Exception as e:
        print(f"[kv-events] Decode error: {e}")
        return

    for event in batch.events:
        if isinstance(event, AllBlocksCleared):
            kv_events_block_map.clear()
            kv_events_root_hashes.clear()
            print("[kv-events] All blocks cleared")

        elif isinstance(event, BlockStored):
            parent = event.parent_block_hash
            for bh in event.block_hashes:
                hkey = str(bh)
                if hkey not in kv_events_block_map:
                    kv_events_block_map[hkey] = {
                        "id": hkey,
                        "parent": str(parent) if parent is not None else None,
                        "token_ids": event.token_ids if event.token_ids else [],
                        "ref_count": 0,
                        "is_root": parent is None,
                    }
                    if parent is None:
                        kv_events_root_hashes.add(hkey)
                kv_events_block_map[hkey]["ref_count"] += 1

        elif isinstance(event, BlockRemoved):
            for bh in event.block_hashes:
                hkey = str(bh)
                if hkey in kv_events_block_map:
                    kv_events_block_map[hkey]["ref_count"] = max(
                        0, kv_events_block_map[hkey]["ref_count"] - 1)


def _build_live_hash_chain() -> dict:
    """Build tree representation from live KV events data."""
    nodes = []
    for hkey, block in kv_events_block_map.items():
        nodes.append({
            "id": hkey,
            "parent": block["parent"],
            "ref_count": block["ref_count"],
            "is_root": block["is_root"],
            "is_shared": block["ref_count"] > 1,
            "token_text": block.get("token_ids", []),
        })
        if block["parent"] and block["parent"] in kv_events_block_map:
            nodes.append({
                "id": block["parent"],
                "ref_count": 0,
                "is_root": kv_events_block_map[block["parent"]]["is_root"],
            })

    # Deduplicate
    seen = {}
    deduped = []
    for n in nodes:
        if n["id"] not in seen:
            seen[n["id"]] = n
        else:
            seen[n["id"]]["ref_count"] = max(seen[n["id"]].get("ref_count", 0), n.get("ref_count", 0))
            seen[n["id"]]["is_shared"] = seen[n["id"]].get("is_shared", False) or n.get("is_shared", False)
    deduped = list(seen.values())

    edges = []
    for hkey, block in kv_events_block_map.items():
        if block["parent"] and block["parent"] in kv_events_block_map:
            edges.append({"source": block["parent"], "target": hkey})

    total = len(deduped)
    shared = sum(1 for n in deduped if n.get("is_shared"))

    return {
        "nodes": deduped,
        "edges": edges,
        "chains": [],
        "live": True,
        "block_count": len(kv_events_block_map),
        "stats": {
            "total_blocks": total,
            "shared_blocks": shared,
            "unique_blocks": total - shared,
            "total_prompt_blocks": total,
            "saved_blocks": 0,
            "estimated_hit_rate": 0,
            "block_size": BLOCK_SIZE,
        },
    }


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------

@app.get("/")
async def index():
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"))

@app.get("/api/status")
async def get_status():
    return {
        "vllm_connected": vllm_connected,
        "vllm_url": VLLM_URL,
        "last_error": last_error,
        "poll_interval": POLL_INTERVAL,
        "demo_mode": not vllm_connected,
        "history_points": len(metrics_history),
    }

@app.get("/api/metrics")
async def get_metrics():
    return JSONResponse({
        "data": latest_raw_metrics,
        "vllm_connected": vllm_connected,
        "demo_mode": not vllm_connected,
        "timestamp": time.time(),
    })

@app.get("/api/metrics/history")
async def get_history():
    history = list(metrics_history)
    return JSONResponse({"history": history, "count": len(history)})

@app.post("/api/prefix-cache/simulate")
async def simulate_prefix_cache(body: dict):
    prompts = body.get("prompts", [])
    block_size = body.get("block_size", BLOCK_SIZE)
    lora_ids = body.get("lora_ids", [])
    if not prompts:
        return JSONResponse({"error": "No prompts provided"}, status_code=400)
    result = build_hash_chain(prompts, block_size, lora_ids)
    return JSONResponse(result)

@app.get("/api/prefix-cache/live")
async def live_hash_chain():
    """Get the real-time hash chain tree built from KV cache events."""
    if not kv_events_enabled:
        return JSONResponse({
            "error": "KV events not enabled. Start vLLM with "
                     "--kv-events-config and run monitor with --kv-events-endpoint."
        }, status_code=503)
    return JSONResponse(_build_live_hash_chain())


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    connected_clients.add(ws)
    try:
        if latest_raw_metrics:
            await ws.send_text(json.dumps({
                "type": "metrics", "data": latest_raw_metrics,
                "vllm_connected": vllm_connected, "timestamp": time.time(),
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
    if KV_EVENTS_ENDPOINT:
        import threading
        t = threading.Thread(target=_zmq_listener, daemon=True)
        t.start()

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="vLLM Monitor")
    parser.add_argument("--vllm-url", default="http://localhost:8000", help="vLLM server URL")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind")
    parser.add_argument("--port", type=int, default=7860, help="Port to bind")
    parser.add_argument("--poll-interval", type=float, default=2.0, help="Poll interval seconds")
    parser.add_argument("--kv-events-endpoint", default=None,
                        help="vLLM ZMQ KV events endpoint (e.g. tcp://10.74.99.215:5557)")
    args = parser.parse_args()

    VLLM_URL = args.vllm_url.rstrip("/")
    POLL_INTERVAL = args.poll_interval
    KV_EVENTS_ENDPOINT = args.kv_events_endpoint

    print(f"vLLM Monitor starting...")
    print(f"  vLLM URL: {VLLM_URL}")
    print(f"  Dashboard: http://localhost:{args.port}")
    print(f"  Poll interval: {POLL_INTERVAL}s")
    if KV_EVENTS_ENDPOINT:
        print(f"  KV Events: {KV_EVENTS_ENDPOINT}")
    elif HAS_ZMQ:
        print(f"  KV Events: disabled (use --kv-events-endpoint to enable)")
    if VLLM_URL == "http://localhost:8000":
        print(f"  (Demo mode activates if vLLM is not reachable)")

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
