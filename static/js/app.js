// vLLM Monitor - Metrics Dashboard
;(function() {
  var ws = null, charts = {}, prevTokens = {prompt:0,gen:0}, prevTime = Date.now()/1000;
  var MAX_POINTS = 60;

  function fmt(n, d) {
    d = d || 1;
    if (n === null || n === undefined || typeof n !== 'number') return '--';
    if (Math.abs(n) >= 1e9) return (n/1e9).toFixed(d)+'B';
    if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(d)+'M';
    if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(d)+'K';
    return n.toFixed(d);
  }
  function fmtTime(s) {
    if (s === null || s === undefined) return '--';
    if (s < 0.001) return (s*1e6).toFixed(0)+'us';
    if (s < 1) return (s*1000).toFixed(1)+'ms';
    return s.toFixed(2)+'s';
  }
  function setText(id, text) { var e = document.getElementById(id); if(e) e.textContent = text; }
  function setBar(id, pct) { var e = document.getElementById(id); if(e) e.style.width = Math.min(100,(pct||0)*100)+'%'; }

  function addCard(gridId, label, id) {
    var g = document.getElementById(gridId);
    var c = document.createElement('div');
    c.className = 'metric-card';
    c.innerHTML = '<div class="metric-label">'+label+'</div><div class="metric-value" id="'+id+'">--</div>';
    g.appendChild(c);
  }
  function addBarCard(gridId, label, valId, barId) {
    var g = document.getElementById(gridId);
    var c = document.createElement('div');
    c.className = 'metric-card';
    c.innerHTML = '<div class="metric-label">'+label+'</div><div class="metric-value" id="'+valId+'">--</div><div class="metric-bar"><div class="metric-bar-fill" id="'+barId+'"></div></div>';
    g.appendChild(c);
  }

  // Build UI cards
  addCard('system-grid', 'Running Requests', 'm-running');
  addCard('system-grid', 'Waiting Requests', 'm-waiting');
  addCard('system-grid', 'Swapped Requests', 'm-swapped');
  addBarCard('system-grid', 'GPU KV Cache', 'm-gpu-cache', 'm-gpu-cache-bar');
  addBarCard('system-grid', 'CPU KV Cache', 'm-cpu-cache', 'm-cpu-cache-bar');
  addBarCard('system-grid', 'GPU Prefix Hit Rate', 'm-gpu-hit', 'm-gpu-hit-bar');
  addBarCard('system-grid', 'CPU Prefix Hit Rate', 'm-cpu-hit', 'm-cpu-hit-bar');
  addCard('system-grid', 'Preemptions', 'm-preempt');
  addCard('token-grid', 'Prompt Tokens', 'm-prompt-tokens');
  addCard('token-grid', 'Generation Tokens', 'm-gen-tokens');
  addCard('token-grid', 'Throughput', 'm-throughput');
  addCard('token-grid', 'Completed', 'm-success');

  // Latency cards
  var latKeys = [
    ['ttft','Time to First Token'], ['tpot','Time per Output Token'],
    ['e2e_request','E2E Request Latency'], ['queue_time','Queue Time'],
    ['prefill_time','Prefill Time'], ['decode_time','Decode Time'],
    ['inference_time','Inference Time'], ['model_forward_ms','Model Forward (ms)'],
    ['model_execute_ms','Model Execute (ms)']
  ];
  var latGrid = document.getElementById('latency-grid');
  latKeys.forEach(function(k) {
    var c = document.createElement('div');
    c.className = 'latency-card';
    c.innerHTML = '<h3>'+k[1]+'</h3><table class="latency-table"><tr><th>P50</th><th>P95</th><th>P99</th><th>Count</th></tr><tr><td id="lat-'+k[0]+'-p50">--</td><td id="lat-'+k[0]+'-p95">--</td><td id="lat-'+k[0]+'-p99">--</td><td id="lat-'+k[0]+'-count">--</td></tr></table>';
    latGrid.appendChild(c);
  });

  // Spec decode cards
  addCard('spec-grid', 'Draft Acceptance Rate', 'm-spec-accept');
  addCard('spec-grid', 'Spec Efficiency', 'm-spec-eff');
  addCard('spec-grid', 'Accepted Tokens', 'm-spec-accepted');
  addCard('spec-grid', 'Draft Tokens', 'm-spec-draft');
  addCard('spec-grid', 'Emitted Tokens', 'm-spec-emitted');

  // Tab navigation
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.remove('active')});
      document.querySelectorAll('.tab-content').forEach(function(c){c.classList.remove('active')});
      btn.classList.add('active');
      var t = document.getElementById('tab-'+btn.dataset.tab);
      if(t) t.classList.add('active');
    });
  });

  // Charts
  function makeChart(id, type, datasets, extra) {
    var ctx = document.getElementById(id);
    if (!ctx) return null;
    var opts = {
      responsive: true, maintainAspectRatio: false, animation: {duration:300},
      plugins: {legend:{labels:{boxWidth:12,font:{size:11},color:'#8b8fa3'}}},
      scales: {x:{display:false},y:{beginAtZero:true,grid:{color:'#2a2e3f'}}}
    };
    if (extra) Object.assign(opts, extra);
    return new Chart(ctx, {type:type, data:{labels:[],datasets:datasets}, options:opts});
  }
  function pushChart(chart, label, values) {
    if(!chart) return;
    chart.data.labels.push(label);
    if(chart.data.labels.length>MAX_POINTS) chart.data.labels.shift();
    values.forEach(function(v,i){
      if(chart.data.datasets[i]){
        chart.data.datasets[i].data.push(v);
        if(chart.data.datasets[i].data.length>MAX_POINTS) chart.data.datasets[i].data.shift();
      }
    });
    try{chart.update('none')}catch(e){}
  }

  try {
    charts.requests = makeChart('chart-requests','line',[
      {label:'Running',data:[],borderColor:'#22c55e',backgroundColor:'rgba(34,197,94,0.1)',fill:true,tension:0.3},
      {label:'Waiting',data:[],borderColor:'#eab308',backgroundColor:'rgba(234,179,8,0.1)',fill:true,tension:0.3},
      {label:'Swapped',data:[],borderColor:'#ef4444',backgroundColor:'rgba(239,68,68,0.1)',fill:true,tension:0.3}
    ]);
    charts.cache = makeChart('chart-cache','line',[
      {label:'GPU Cache',data:[],borderColor:'#7c5cfc',fill:true,tension:0.3},
      {label:'CPU Cache',data:[],borderColor:'#3b82f6',fill:true,tension:0.3}
    ], {scales:{x:{display:false},y:{beginAtZero:true,max:1,grid:{color:'#2a2e3f'},ticks:{callback:function(v){return (v*100).toFixed(0)+'%'}}}}});
    charts.hitrate = makeChart('chart-hitrate','line',[
      {label:'GPU Hit Rate',data:[],borderColor:'#22c55e',fill:true,tension:0.3},
      {label:'CPU Hit Rate',data:[],borderColor:'#3b82f6',fill:true,tension:0.3}
    ], {scales:{x:{display:false},y:{beginAtZero:true,max:1,ticks:{callback:function(v){return (v*100).toFixed(0)+'%'}}}}});
    charts.tokens = makeChart('chart-tokens','line',[
      {label:'Prompt tok/s',data:[],borderColor:'#f97316',tension:0.3},
      {label:'Gen tok/s',data:[],borderColor:'#22c55e',tension:0.3}
    ]);
    charts.finishReasons = makeChart('chart-finish-reasons','doughnut',[
      {data:[],backgroundColor:['#22c55e','#eab308','#ef4444','#3b82f6']}
    ], {plugins:{legend:{position:'right',labels:{color:'#8b8fa3'}}}});
    charts.promptDist = makeChart('chart-prompt-dist','bar',[
      {label:'Count',data:[],backgroundColor:'#7c5cfc'}
    ], {plugins:{legend:{display:false}}});
    charts.genDist = makeChart('chart-gen-dist','bar',[
      {label:'Count',data:[],backgroundColor:'#22c55e'}
    ], {plugins:{legend:{display:false}}});
    charts.maxTokensDist = makeChart('chart-maxtokens-dist','bar',[
      {label:'Count',data:[],backgroundColor:'#f97316'}
    ], {plugins:{legend:{display:false}}});
  } catch(e) { console.error('Chart init:',e); }

  // WebSocket
  function connectWS() {
    var proto = location.protocol==='https:'?'wss:':'ws:';
    ws = new WebSocket(proto+'//'+location.host+'/ws');
    ws.onmessage = function(e) {
      try{
        var msg = JSON.parse(e.data);
        if(msg.type==='metrics') updateDashboard(msg.data, msg.vllm_connected);
      }catch(err){}
    };
    ws.onclose = function(){setTimeout(connectWS,3000)};
    ws.onerror = function(){try{ws.close()}catch(e){}};
  }

  function updateDashboard(data, connected) {
    if(!data||!data.system){try{hideLoading()}catch(e){};return}
    try {
    var s=data.system, t=data.tokens, pc=data.prefix_cache, sd=data.spec_decode, lat=data.latency, req=data.requests;
    var now = new Date().toLocaleTimeString();

    setText('m-running', fmt(s.num_requests_running,0));
    setText('m-waiting', fmt(s.num_requests_waiting,0));
    setText('m-swapped', fmt(s.num_requests_swapped,0));
    if(s.gpu_cache_usage_perc!=null) setText('m-gpu-cache', (s.gpu_cache_usage_perc*100).toFixed(1)+'%');
    if(s.cpu_cache_usage_perc!=null) setText('m-cpu-cache', (s.cpu_cache_usage_perc*100).toFixed(1)+'%');
    setBar('m-gpu-cache-bar', s.gpu_cache_usage_perc);
    setBar('m-cpu-cache-bar', s.cpu_cache_usage_perc);
    if(pc.gpu_hit_rate!=null){setText('m-gpu-hit',(pc.gpu_hit_rate*100).toFixed(1)+'%');setBar('m-gpu-hit-bar',pc.gpu_hit_rate)}
    if(pc.cpu_hit_rate!=null){setText('m-cpu-hit',(pc.cpu_hit_rate*100).toFixed(1)+'%');setBar('m-cpu-hit-bar',pc.cpu_hit_rate)}
    setText('m-preempt', fmt(s.num_preemptions,0));
    setText('m-prompt-tokens', fmt(t.prompt_total,0));
    setText('m-gen-tokens', fmt(t.generation_total,0));

    var cur = Date.now()/1000, dt = cur - prevTime;
    if(dt>0 && prevTokens.prompt>0){
      var rate = ((t.prompt_total-prevTokens.prompt)+(t.generation_total-prevTokens.gen))/dt;
      setText('m-throughput', rate.toFixed(0)+' tok/s');
      pushChart(charts.tokens, now, [Math.max(0,(t.prompt_total-prevTokens.prompt)/dt), Math.max(0,(t.generation_total-prevTokens.gen)/dt)]);
    }
    prevTokens = {prompt:t.prompt_total||0, gen:t.generation_total||0};
    prevTime = cur;

    var total=0; Object.values(req.success_by_reason||{}).forEach(function(v){total+=v||0});
    setText('m-success',fmt(total,0));

    pushChart(charts.requests,now,[s.num_requests_running||0,s.num_requests_waiting||0,s.num_requests_swapped||0]);
    pushChart(charts.cache,now,[s.gpu_cache_usage_perc||0,s.cpu_cache_usage_perc||0]);
    pushChart(charts.hitrate,now,[pc.gpu_hit_rate||0,pc.cpu_hit_rate||0]);

    latKeys.forEach(function(k){
      var h=lat[k[0]];
      if(h&&h.buckets&&h.count>0){
        var total=h.count;
        var entries=Object.entries(h.buckets).map(function(e){return[parseFloat(e[0]),e[1]]}).sort(function(a,b){return a[0]-b[0]});
        function pct(p){var t=total*p;for(var i=0;i<entries.length;i++)if(entries[i][1]>=t)return entries[i][0];return entries[entries.length-1][0]}
        var p50=pct(0.5),p95=pct(0.95),p99=pct(0.99);
        var m=k[0]==='model_forward_ms'||k[0]==='model_execute_ms';
        setText('lat-'+k[0]+'-p50', p50!=null?(m?p50.toFixed(1)+'ms':fmtTime(p50)):'--');
        setText('lat-'+k[0]+'-p95', p95!=null?(m?p95.toFixed(1)+'ms':fmtTime(p95)):'--');
        setText('lat-'+k[0]+'-p99', p99!=null?(m?p99.toFixed(1)+'ms':fmtTime(p99)):'--');
        setText('lat-'+k[0]+'-count', fmt(h.count,0));
      }
    });

    if(sd.draft_acceptance_rate!=null) setText('m-spec-accept',(sd.draft_acceptance_rate*100).toFixed(1)+'%');
    if(sd.efficiency!=null) setText('m-spec-eff',(sd.efficiency*100).toFixed(1)+'%');
    setText('m-spec-accepted',fmt(sd.num_accepted,0));
    setText('m-spec-draft',fmt(sd.num_draft,0));
    setText('m-spec-emitted',fmt(sd.num_emitted,0));

    if(charts.finishReasons&&req.success_by_reason&&Object.keys(req.success_by_reason).length>0){
      charts.finishReasons.data.labels=Object.keys(req.success_by_reason);
      charts.finishReasons.data.datasets[0].data=Object.values(req.success_by_reason);
      try{charts.finishReasons.update('none')}catch(e){}
    }
    function fillHist(chart,hist){
      if(!chart||!hist||!hist.buckets)return;
      var ents=Object.entries(hist.buckets).map(function(e){return[e[0]==='+Inf'?'Inf':e[0],e[1]]}).sort(function(a,b){if(a[0]==='Inf')return 1;if(b[0]==='Inf')return -1;return parseFloat(a[0])-parseFloat(b[0])});
      var prev=0,labels=[],deltas=[];
      ents.forEach(function(e){labels.push(e[0]);deltas.push(Math.max(0,e[1]-prev));prev=e[1]});
      chart.data.labels=labels;chart.data.datasets[0].data=deltas;
      try{chart.update('none')}catch(e){}
    }
    fillHist(charts.promptDist,req.prompt_tokens_hist);
    fillHist(charts.genDist,req.gen_tokens_hist);
    fillHist(charts.maxTokensDist,req.params_max_tokens_hist);
    }catch(e){console.error('updateDashboard:',e)}
    updateStatus(connected);
    hideLoading();
  }

  function hideLoading(){
    var lo = document.getElementById('loading-overlay');
    if(lo)lo.style.display='none';
  }

  function updateStatus(connected) {
    var b=document.getElementById('status-badge');
    if(connected){b.textContent='Connected';b.className='badge badge-connected'}
    else {b.textContent='Demo Mode';b.className='badge badge-demo'}
    document.getElementById('last-update').textContent = 'Updated: '+new Date().toLocaleTimeString();
  }

  connectWS();
  setTimeout(function(){
    var lo=document.getElementById('loading-overlay');
    if(lo){lo.style.display='none'}
  }, 10000);
})();
