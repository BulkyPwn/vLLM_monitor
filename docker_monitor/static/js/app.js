// Docker Monitor - Container Dashboard
;(function() {
  // --- Frontend log capture -> backend ---
  var _origLog = console.log, _origError = console.error, _origWarn = console.warn;
  var logQueue = [], logTimer = null;
  function sendLogs() {
    if (logQueue.length === 0) return;
    var batch = logQueue.splice(0);
    fetch('/api/log', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({level: 'INFO', message: batch.join('\n')}),
    }).catch(function(){});
  }
  console.log = function() { _origLog.apply(console, arguments); logQueue.push(Array.from(arguments).join(' ')); if (!logTimer) logTimer = setTimeout(function(){ sendLogs(); logTimer = null; }, 5000); };
  console.error = function() { _origError.apply(console, arguments); logQueue.push('[ERROR] ' + Array.from(arguments).join(' ')); if (!logTimer) logTimer = setTimeout(function(){ sendLogs(); logTimer = null; }, 5000); };
  console.warn = function() { _origWarn.apply(console, arguments); logQueue.push('[WARN] ' + Array.from(arguments).join(' ')); };

  // --- State ---
  var dockerConnected = false;
  var ws = null, wsReconnectTimer = null;
  var charts = {};
  var historyPoints = [];

  // --- DOM elements ---
  var el = function(id) { return document.getElementById(id); };
  var $status = el('status-badge'), $indicator = el('demo-indicator'), $lastUpdate = el('last-update');
  var $summary = el('summary-grid'), $tbody = el('container-tbody');
  var $loading = el('loading-overlay'), $loadingStatus = el('loading-status');
  var $error = el('error-banner');

  // --- Tab switching ---
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
      btn.classList.add('active');
      var tab = el('tab-' + btn.dataset.tab);
      if (tab) tab.classList.add('active');
    });
  });

  // --- Formatting helpers ---
  function fmtBytes(bytes) {
    if (bytes === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    i = Math.min(i, units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  function fmtTime(ts) {
    var d = new Date(ts * 1000);
    return d.toLocaleTimeString();
  }

  function fmtPct(v) { return v.toFixed(1) + '%'; }

  // --- Chart initialization ---
  function initCharts() {
    var chartDefaults = {
      type: 'line',
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: { legend: { display: false } },
        scales: {
          x: {
            type: 'time',
            time: { unit: 'minute', displayFormats: { minute: 'HH:mm' } },
            grid: { color: 'rgba(42,46,63,0.3)' },
            ticks: { color: '#8b8fa3', font: { size: 10 } }
          },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(42,46,63,0.3)' },
            ticks: { color: '#8b8fa3', font: { size: 10 } }
          }
        }
      }
    };

    charts.cpu = new Chart(el('chart-cpu'), {
      type: 'line',
      data: { datasets: [{ label: 'CPU %', data: [], borderColor: '#7c5cfc', backgroundColor: 'rgba(124,92,252,0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
      options: Object.assign({}, chartDefaults.options, {
        scales: Object.assign({}, chartDefaults.options.scales, {
          y: Object.assign({}, chartDefaults.options.scales.y, {
            title: { display: true, text: 'CPU %', color: '#8b8fa3' }
          })
        })
      })
    });

    charts.mem = new Chart(el('chart-mem'), {
      type: 'line',
      data: { datasets: [{ label: 'Memory', data: [], borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
      options: Object.assign({}, chartDefaults.options, {
        scales: Object.assign({}, chartDefaults.options.scales, {
          y: Object.assign({}, chartDefaults.options.scales.y, {
            title: { display: true, text: 'Memory', color: '#8b8fa3' },
            ticks: Object.assign({}, chartDefaults.options.scales.y.ticks, {
              callback: function(v) { return fmtBytes(v); }
            })
          })
        })
      })
    });
  }

  function updateCharts(history) {
    var cpuData = [], memData = [];
    for (var i = 0; i < history.length; i++) {
      var p = history[i];
      cpuData.push({ x: p.ts * 1000, y: p.cpu });
      memData.push({ x: p.ts * 1000, y: p.mem });
    }
    charts.cpu.data.datasets[0].data = cpuData;
    charts.cpu.update('none');
    charts.mem.data.datasets[0].data = memData;
    charts.mem.update('none');
  }

  // --- Render container table ---
  function renderContainers(containers) {
    var running = containers.filter(function(c) { return c.state === 'running'; });
    var totalCpu = 0, totalMemUsage = 0;

    // Summary cards
    var totalMemLimit = 0;
    running.forEach(function(c) { totalCpu += c.cpu_pct; totalMemUsage += c.mem_usage; totalMemLimit = c.mem_limit || totalMemLimit; });

    var summaryHtml =
      '<div class="metric-card"><div class="metric-label">Total Containers</div><div class="metric-value">' + containers.length + '</div></div>' +
      '<div class="metric-card"><div class="metric-label">Running</div><div class="metric-value" style="color:var(--green)">' + running.length + '</div></div>' +
      '<div class="metric-card"><div class="metric-label">Stopped</div><div class="metric-value" style="color:var(--text-dim)">' + (containers.length - running.length) + '</div></div>' +
      '<div class="metric-card"><div class="metric-label">Total CPU</div><div class="metric-value">' + totalCpu.toFixed(1) + '%</div><div class="metric-bar"><div class="metric-bar-fill' + (totalCpu > 200 ? ' warn' : '') + '" style="width:' + Math.min(totalCpu / 4, 100) + '%"></div></div></div>' +
      '<div class="metric-card"><div class="metric-label">Total Memory</div><div class="metric-value">' + fmtBytes(totalMemUsage) + '</div><div class="metric-bar"><div class="metric-bar-fill green" style="width:' + (totalMemLimit > 0 ? (totalMemUsage / totalMemLimit * 100).toFixed(0) : 0) + '%"></div></div></div>' +
      '<div class="metric-card"><div class="metric-label">Total Images</div><div class="metric-value" id="summary-images">--</div></div>';
    $summary.innerHTML = summaryHtml;

    // Deduplicate images
    var images = {};
    containers.forEach(function(c) { if (c.image) images[c.image] = true; });
    el('summary-images').textContent = Object.keys(images).length;

    // Table rows
    var rows = '';
    containers.forEach(function(c) {
      var stateClass = 'state-' + c.state;
      var memStr = c.mem_usage > 0 ? fmtBytes(c.mem_usage) + ' (' + fmtPct(c.mem_pct) + ')' : '--';
      var cpuStr = c.state === 'running' ? c.cpu_pct.toFixed(1) + '%' : '--';
      rows += '<tr>' +
        '<td><strong>' + escHtml(c.name) + '</strong><br><span style="font-size:11px;color:var(--text-dim)">' + c.id + '</span></td>' +
        '<td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;">' + escHtml(c.image) + '</td>' +
        '<td><span class="state-badge ' + stateClass + '">' + c.state + '</span></td>' +
        '<td style="font-size:12px;color:var(--text-dim)">' + escHtml(c.status) + '</td>' +
        '<td>' + cpuStr + '</td>' +
        '<td>' + memStr + '</td>' +
        '<td style="font-size:12px;max-width:180px;overflow:hidden;text-overflow:ellipsis;">' + escHtml(c.ports || '--') + '</td>' +
        '<td>' + (c.pid_count || '--') + '</td>' +
        '</tr>';
    });

    if (!containers.length) {
      rows = '<tr><td colspan="8" class="table-empty">No containers found</td></tr>';
    }
    $tbody.innerHTML = rows;

    // Update image list used by layers tab
    window._containerImages = Object.keys(images);
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- Status bar ---
  function updateStatus(connected, demoMode) {
    $status.textContent = connected ? 'Connected' : 'Demo Mode';
    $status.className = 'badge ' + (connected ? 'badge-connected' : 'badge-demo');
    $indicator.textContent = connected ? 'LIVE' : 'DEMO MODE';
    $indicator.style.background = connected ? 'var(--green)' : 'var(--yellow)';
    $indicator.style.color = connected ? '#000' : '#000';
    $lastUpdate.textContent = fmtTime(Date.now() / 1000);
    dockerConnected = connected;
  }

  // --- WebSocket ---
  function connectWS() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = proto + '//' + location.host + '/ws';
    ws = new WebSocket(url);

    ws.onopen = function() {
      $loadingStatus.textContent = 'Connected via WebSocket';
      setTimeout(function() { $loading.classList.add('hidden'); }, 500);
    };

    ws.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'containers') {
          renderContainers(msg.data || []);
          updateStatus(msg.docker_connected, !msg.docker_connected);
        }
      } catch (err) {
        console.error('WS parse error:', err);
      }
    };

    ws.onclose = function() {
      wsReconnectTimer = setTimeout(connectWS, 3000);
    };

    ws.onerror = function() { ws.close(); };
  }

  // --- History polling ---
  async function pollHistory() {
    try {
      var resp = await fetch('/api/stats/history');
      var data = await resp.json();
      if (data.history) {
        updateCharts(data.history);
      }
    } catch (err) {}
  }

  // --- Health check ---
  async function checkHealth() {
    try {
      var resp = await fetch('/api/status');
      var data = await resp.json();
      updateStatus(data.docker_connected, data.demo_mode);
      if (!data.docker_connected) {
        $loadingStatus.textContent = 'Docker unavailable — using demo data';
      }
    } catch (err) {
      $loadingStatus.textContent = 'Backend not reachable: ' + err.message;
    }
  }

  // --- Error banner ---
  function showError(msg) {
    $error.textContent = msg;
    $error.style.display = 'block';
    setTimeout(function() { $error.style.display = 'none'; }, 8000);
  }
  $error.addEventListener('click', function() { $error.style.display = 'none'; });

  // --- Init ---
  initCharts();
  connectWS();
  checkHealth();
  setInterval(pollHistory, 5000);
  setInterval(checkHealth, 15000);
})();
