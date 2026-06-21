// ============================================================
// vLLM Monitor - Metrics Dashboard
// ============================================================

// State
let ws = null;
let prevTokens = { prompt: 0, gen: 0 };
let prevTime = Date.now() / 1000;
let charts = {};
let historyData = [];
const MAX_POINTS = 60;

// Chart defaults
Chart.defaults.color = '#8b8fa3';
Chart.defaults.borderColor = '#2a2e3f';
Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";

// ============================================================
// Tab Navigation
// ============================================================
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
});

// ============================================================
// WebSocket connection
// ============================================================
function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'metrics') {
            updateDashboard(msg.data, msg.vllm_connected);
            updateStatus(msg.vllm_connected);
        }
    };
    ws.onclose = () => {
        setTimeout(connectWS, 3000);
    };
    ws.onerror = () => { ws.close(); };
}

async function updateStatus(connected) {
    const badge = document.getElementById('status-badge');
    const demo = document.getElementById('demo-indicator');
    if (connected) {
        badge.textContent = 'Connected';
        badge.className = 'badge badge-connected';
        demo.style.display = 'none';
    } else {
        badge.textContent = 'Demo Mode';
        badge.className = 'badge badge-demo';
        demo.style.display = 'inline-block';
    }
    document.getElementById('last-update').textContent =
        'Updated: ' + new Date().toLocaleTimeString();
}

// ============================================================
// Helper functions
// ============================================================
function fmt(n, decimals = 1) {
    if (n === null || n === undefined) return '--';
    if (typeof n !== 'number') return '--';
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(decimals) + 'B';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(decimals) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(decimals) + 'K';
    return n.toFixed(decimals);
}

function fmtTime(s) {
    if (s === null || s === undefined) return '--';
    if (s < 0.001) return (s * 1e6).toFixed(0) + 'us';
    if (s < 1) return (s * 1000).toFixed(1) + 'ms';
    return s.toFixed(2) + 's';
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function setBar(id, pct, max = 1) {
    const el = document.getElementById(id);
    if (el) {
        const w = Math.min(100, (pct / max) * 100);
        el.style.width = w + '%';
        if (w > 80) { el.classList.remove('green'); el.classList.add('warn'); }
    }
}

// ============================================================
// Initialize charts
// ============================================================
function initCharts() {
    const baseOpts = {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: {
            x: { display: false },
            y: { beginAtZero: true, grid: { color: '#2a2e3f' } }
        }
    };

    // Request state chart
    charts.requests = new Chart(document.getElementById('chart-requests'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'Running', data: [], borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)', fill: true, tension: 0.3 },
                { label: 'Waiting', data: [], borderColor: '#eab308', backgroundColor: 'rgba(234,179,8,0.1)', fill: true, tension: 0.3 },
                { label: 'Swapped', data: [], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', fill: true, tension: 0.3 },
            ]
        },
        options: baseOpts
    });

    // Cache usage chart
    charts.cache = new Chart(document.getElementById('chart-cache'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'GPU Cache %', data: [], borderColor: '#7c5cfc', backgroundColor: 'rgba(124,92,252,0.1)', fill: true, tension: 0.3 },
                { label: 'CPU Cache %', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3 },
            ]
        },
        options: { ...baseOpts, scales: { ...baseOpts.scales, y: { ...baseOpts.scales.y, max: 1, ticks: { callback: v => (v * 100).toFixed(0) + '%' } } } }
    });

    // Hit rate chart
    charts.hitrate = new Chart(document.getElementById('chart-hitrate'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'GPU Hit Rate', data: [], borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)', fill: true, tension: 0.3 },
                { label: 'CPU Hit Rate', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3 },
            ]
        },
        options: { ...baseOpts, scales: { ...baseOpts.scales, y: { ...baseOpts.scales.y, max: 1, ticks: { callback: v => (v * 100).toFixed(0) + '%' } } } }
    });

    // Token throughput chart
    charts.tokens = new Chart(document.getElementById('chart-tokens'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'Prompt tok/s', data: [], borderColor: '#f97316', tension: 0.3 },
                { label: 'Gen tok/s', data: [], borderColor: '#22c55e', tension: 0.3 },
            ]
        },
        options: baseOpts
    });

    // Distribution charts
    charts.finishReasons = new Chart(document.getElementById('chart-finish-reasons'), {
        type: 'doughnut',
        data: { labels: [], datasets: [{ data: [], backgroundColor: ['#22c55e', '#eab308', '#ef4444', '#3b82f6'] }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
    });

    charts.promptDist = new Chart(document.getElementById('chart-prompt-dist'), {
        type: 'bar',
        data: { labels: [], datasets: [{ label: 'Count', data: [], backgroundColor: '#7c5cfc' }] },
        options: { ...baseOpts, plugins: { legend: { display: false } } }
    });

    charts.genDist = new Chart(document.getElementById('chart-gen-dist'), {
        type: 'bar',
        data: { labels: [], datasets: [{ label: 'Count', data: [], backgroundColor: '#22c55e' }] },
        options: { ...baseOpts, plugins: { legend: { display: false } } }
    });

    charts.maxTokensDist = new Chart(document.getElementById('chart-maxtokens-dist'), {
        type: 'bar',
        data: { labels: [], datasets: [{ label: 'Count', data: [], backgroundColor: '#f97316' }] },
        options: { ...baseOpts, plugins: { legend: { display: false } } }
    });
}

// ============================================================
// Dashboard update
// ============================================================
function updateDashboard(data, connected) {
    if (!data || !data.system) return;
    const flat = data.flat || {};
    const now = new Date().toLocaleTimeString();

    // System metrics
    setText('m-running', fmt(data.system.num_requests_running, 0));
    setText('m-waiting', fmt(data.system.num_requests_waiting, 0));
    setText('m-swapped', fmt(data.system.num_requests_swapped, 0));
    setText('m-gpu-cache', data.system.gpu_cache_usage_perc != null ? (data.system.gpu_cache_usage_perc * 100).toFixed(1) + '%' : '--');
    setText('m-cpu-cache', data.system.cpu_cache_usage_perc != null ? (data.system.cpu_cache_usage_perc * 100).toFixed(1) + '%' : '--');
    setBar('m-gpu-cache-bar', data.system.gpu_cache_usage_perc || 0);
    setBar('m-cpu-cache-bar', data.system.cpu_cache_usage_perc || 0);
    setText('m-gpu-hit', data.prefix_cache.gpu_hit_rate != null ? (data.prefix_cache.gpu_hit_rate * 100).toFixed(1) + '%' : '--');
    setText('m-cpu-hit', data.prefix_cache.cpu_hit_rate != null ? (data.prefix_cache.cpu_hit_rate * 100).toFixed(1) + '%' : '--');
    setBar('m-gpu-hit-bar', data.prefix_cache.gpu_hit_rate || 0);
    setBar('m-cpu-hit-bar', data.prefix_cache.cpu_hit_rate || 0);
    setText('m-preempt', fmt(data.system.num_preemptions, 0));

    // Token metrics
    const promptTok = data.tokens.prompt_total || 0;
    const genTok = data.tokens.generation_total || 0;
    setText('m-prompt-tokens', fmt(promptTok, 0));
    setText('m-gen-tokens', fmt(genTok, 0));

    // Calculate throughput
    const curTime = Date.now() / 1000;
    const dt = curTime - prevTime;
    if (dt > 0 && prevTokens.prompt > 0) {
        const promptRate = (promptTok - prevTokens.prompt) / dt;
        const genRate = (genTok - prevTokens.gen) / dt;
        setText('m-throughput', (promptRate + genRate).toFixed(0) + ' tok/s');
        pushChart(charts.tokens, now, [Math.max(0, promptRate), Math.max(0, genRate)]);
    }
    prevTokens = { prompt: promptTok, gen: genTok };
    prevTime = curTime;

    // Success
    const successTotal = Object.values(data.requests.success_by_reason || {}).reduce((a, b) => a + (b || 0), 0);
    setText('m-success', fmt(successTotal, 0));

    // Time series: request state
    pushChart(charts.requests, now, [
        data.system.num_requests_running || 0,
        data.system.num_requests_waiting || 0,
        data.system.num_requests_swapped || 0,
    ]);

    // Time series: cache usage
    pushChart(charts.cache, now, [
        data.system.gpu_cache_usage_perc || 0,
        data.system.cpu_cache_usage_perc || 0,
    ]);

    // Time series: hit rate
    pushChart(charts.hitrate, now, [
        data.prefix_cache.gpu_hit_rate || 0,
        data.prefix_cache.cpu_hit_rate || 0,
    ]);

    // Latency percentiles
    const latencyKeys = ['ttft', 'tpot', 'e2e_request', 'queue_time', 'prefill_time',
                         'decode_time', 'inference_time', 'model_forward_ms', 'model_execute_ms'];
    latencyKeys.forEach(key => {
        const hist = data.latency[key];
        if (hist && hist.buckets) {
            const { p50, p95, p99 } = calcPercentiles(hist);
            const suffix = key === 'model_forward_ms' || key === 'model_execute_ms' ? 'ms' : '';
            setText(`lat-${key}-p50`, p50 !== null ? (suffix ? p50.toFixed(1) + suffix : fmtTime(p50)) : '--');
            setText(`lat-${key}-p95`, p95 !== null ? (suffix ? p95.toFixed(1) + suffix : fmtTime(p95)) : '--');
            setText(`lat-${key}-p99`, p99 !== null ? (suffix ? p99.toFixed(1) + suffix : fmtTime(p99)) : '--');
            setText(`lat-${key}-count`, fmt(hist.count, 0));
        }
    });

    // Speculative decoding
    setText('m-spec-accept', data.spec_decode.draft_acceptance_rate != null ? (data.spec_decode.draft_acceptance_rate * 100).toFixed(1) + '%' : '--');
    setText('m-spec-eff', data.spec_decode.efficiency != null ? (data.spec_decode.efficiency * 100).toFixed(1) + '%' : '--');
    setText('m-spec-accepted', fmt(data.spec_decode.num_accepted, 0));
    setText('m-spec-draft', fmt(data.spec_decode.num_draft, 0));
    setText('m-spec-emitted', fmt(data.spec_decode.num_emitted, 0));

    // Distribution charts
    updateFinishReasons(data.requests.success_by_reason);
    updateHistogramChart(charts.promptDist, data.requests.prompt_tokens_hist);
    updateHistogramChart(charts.genDist, data.requests.gen_tokens_hist);
    updateHistogramChart(charts.maxTokensDist, data.requests.params_max_tokens_hist);
}

function pushChart(chart, label, values) {
    chart.data.labels.push(label);
    if (chart.data.labels.length > MAX_POINTS) chart.data.labels.shift();
    values.forEach((v, i) => {
        if (chart.data.datasets[i]) {
            chart.data.datasets[i].data.push(v);
            if (chart.data.datasets[i].data.length > MAX_POINTS)
                chart.data.datasets[i].data.shift();
        }
    });
    chart.update('none');
}

function calcPercentiles(hist) {
    if (!hist.buckets || !hist.count || hist.count === 0) return { p50: null, p95: null, p99: null };
    const total = hist.count;
    const entries = Object.entries(hist.buckets)
        .map(([le, c]) => [parseFloat(le), c])
        .sort((a, b) => a[0] - b[0]);
    function pct(p) {
        const target = total * p;
        for (const [le, count] of entries) {
            if (count >= target) return le;
        }
        return entries.length > 0 ? entries[entries.length - 1][0] : null;
    }
    return { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) };
}

function updateFinishReasons(byReason) {
    if (!byReason || Object.keys(byReason).length === 0) return;
    const labels = Object.keys(byReason);
    const values = Object.values(byReason);
    charts.finishReasons.data.labels = labels;
    charts.finishReasons.data.datasets[0].data = values;
    charts.finishReasons.update('none');
}

function updateHistogramChart(chart, hist) {
    if (!hist || !hist.buckets) return;
    const entries = Object.entries(hist.buckets)
        .map(([le, c]) => [le === '+Inf' ? 'Inf' : le, c])
        .sort((a, b) => {
            if (a[0] === 'Inf') return 1;
            if (b[0] === 'Inf') return -1;
            return parseFloat(a[0]) - parseFloat(b[0]);
        });
    // Compute bucket deltas (histogram is cumulative)
    let prev = 0;
    const labels = [];
    const deltas = [];
    entries.forEach(([le, count]) => {
        labels.push(le);
        deltas.push(Math.max(0, count - prev));
        prev = count;
    });
    chart.data.labels = labels;
    chart.data.datasets[0].data = deltas;
    chart.update('none');
}

// ============================================================
// Init
// ============================================================
initCharts();
connectWS();
