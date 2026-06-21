// ============================================================
// vLLM Monitor - Prefix Cache Hash Chain Visualizer
// ============================================================

const PROMPT_COLORS = ['#7c5cfc', '#22c55e', '#3b82f6', '#f97316', '#eab308',
                       '#ec4899', '#06b6d4', '#ef4444'];

const EXAMPLE_PROMPTS = [
    "You are a helpful AI assistant. The user will ask you questions and you should answer them accurately and concisely. Always be polite and professional in your responses. Question: What is the capital of France?",
    "You are a helpful AI assistant. The user will ask you questions and you should answer them accurately and concisely. Always be polite and professional in your responses. Question: What is the capital of Germany?",
    "You are a helpful AI assistant. The user will ask you questions and you should answer them accurately and concisely. Always be polite and professional in your responses. Question: Explain quantum computing in simple terms. Start with the basics and gradually introduce more complex concepts. Make sure to use analogies that are easy to understand."
];

// ============================================================
// Prompt management
// ============================================================
let promptCount = 0;

function addPrompt(text = '') {
    const idx = promptCount++;
    const list = document.getElementById('prompt-list');
    const div = document.createElement('div');
    div.className = 'prompt-item';
    div.dataset.idx = idx;
    div.innerHTML = `
        <div class="prompt-item-header">
            <span style="color: ${PROMPT_COLORS[idx % PROMPT_COLORS.length]}">
                Prompt ${idx + 1}
            </span>
            <button class="btn-remove" onclick="this.parentElement.parentElement.remove()">&times;</button>
        </div>
        <textarea placeholder="Enter prompt text...">${text}</textarea>
    `;
    list.appendChild(div);
}

function getPrompts() {
    const items = document.querySelectorAll('.prompt-item textarea');
    return Array.from(items).map(t => t.value).filter(v => v.trim().length > 0);
}

// Initialize with empty prompt
addPrompt();
addPrompt();

// Button handlers
document.getElementById('btn-add-prompt').addEventListener('click', () => addPrompt());

document.getElementById('btn-load-example').addEventListener('click', () => {
    document.getElementById('prompt-list').innerHTML = '';
    promptCount = 0;
    EXAMPLE_PROMPTS.forEach(p => addPrompt(p));
});

document.getElementById('btn-simulate').addEventListener('click', simulate);

async function simulate() {
    const prompts = getPrompts();
    if (prompts.length === 0) {
        alert('Please enter at least one prompt');
        return;
    }
    const blockSize = parseInt(document.getElementById('block-size').value) || 16;

    try {
        const resp = await fetch('/api/prefix-cache/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompts, block_size: blockSize }),
        });
        const data = await resp.json();
        renderStats(data.stats);
        renderTree(data);
    } catch (e) {
        console.error('Simulation error:', e);
    }
}

function renderStats(stats) {
    document.getElementById('pc-stats').style.display = 'block';
    setText('pc-total-blocks', stats.total_blocks);
    setText('pc-shared-blocks', stats.shared_blocks);
    setText('pc-unique-blocks', stats.unique_blocks);
    setText('pc-prompt-blocks', stats.total_prompt_blocks);
    setText('pc-saved-blocks', stats.saved_blocks);
    setText('pc-hit-rate', (stats.estimated_hit_rate * 100).toFixed(1) + '%');
}

// ============================================================
// D3 Tree Rendering
// ============================================================
function renderTree(data) {
    const container = document.getElementById('hash-chain-viz');
    container.innerHTML = '';

    const { nodes, edges, chains } = data;
    if (nodes.length === 0) {
        container.innerHTML = '<div class="pc-placeholder">No blocks generated</div>';
        return;
    }

    // Build hierarchy
    const nodeMap = {};
    nodes.forEach(n => { nodeMap[n.id] = { ...n, children: [] }; });

    const roots = [];
    edges.forEach(e => {
        if (nodeMap[e.source]) {
            nodeMap[e.source].children.push(nodeMap[e.target]);
        }
    });
    nodes.forEach(n => {
        if (n.is_root || !n.parent) roots.push(nodeMap[n.id]);
    });

    // If no explicit roots, find nodes with no parent in edges
    if (roots.length === 0) {
        const childIds = new Set(edges.map(e => e.target));
        nodes.forEach(n => {
            if (!childIds.has(n.id)) roots.push(nodeMap[n.id]);
        });
    }

    // Create tree data
    const treeData = { id: '__virtual_root__', children: roots, is_virtual: true };

    // SVG setup
    const width = container.clientWidth;
    const height = container.clientHeight;
    const margin = { top: 40, right: 120, bottom: 40, left: 80 };

    const svg = d3.select('#hash-chain-viz').append('svg')
        .attr('width', '100%')
        .attr('height', '100%')
        .style('display', 'block');

    const inner = svg.append('g');

    // Zoom support
    const zoom = d3.zoom()
        .scaleExtent([0.3, 3])
        .on('zoom', (event) => {
            inner.attr('transform', event.transform);
        });
    svg.call(zoom);

    // Tree layout (horizontal)
    const treeLayout = d3.tree()
        .nodeSize([55, 200])
        .separation((a, b) => a.parent === b.parent ? 1 : 1.5);

    const root = d3.hierarchy(treeData);
    treeLayout(root);

    const nodes_layout = root.descendants().filter(n => !n.data.is_virtual);
    const links_layout = root.links().filter(l => !l.source.data.is_virtual);

    // Draw links
    inner.selectAll('.hc-link')
        .data(links_layout)
        .enter()
        .append('path')
        .attr('class', d => 'hc-link' + (d.target.data.is_shared ? ' shared' : ''))
        .attr('d', d3.linkHorizontal()
            .x(d => d.y)
            .y(d => d.x));

    // Node groups
    const nodeG = inner.selectAll('.hc-node')
        .data(nodes_layout)
        .enter()
        .append('g')
        .attr('class', 'hc-node')
        .attr('transform', d => `translate(${d.y},${d.x})`);

    // Node rectangle
    const nodeW = 140;
    const nodeH = 44;

    nodeG.append('rect')
        .attr('x', -nodeW / 2)
        .attr('y', -nodeH / 2)
        .attr('width', nodeW)
        .attr('height', nodeH)
        .attr('rx', 6)
        .attr('fill', d => {
            if (d.data.is_root) return 'rgba(249,115,22,0.15)';
            if (d.data.is_shared) return 'rgba(34,197,94,0.15)';
            return 'rgba(124,92,252,0.15)';
        })
        .attr('stroke', d => {
            if (d.data.is_root) return '#f97316';
            if (d.data.is_shared) return '#22c55e';
            return '#7c5cfc';
        })
        .attr('stroke-width', d => d.data.is_shared ? 2 : 1.5);

    // Block index badge
    nodeG.append('text')
        .attr('x', -nodeW / 2 + 8)
        .attr('y', -nodeH / 2 + 12)
        .attr('font-size', '9px')
        .attr('fill', '#8b8fa3')
        .text(d => `#${d.data.block_index}`);

    // Ref count badge
    nodeG.append('text')
        .attr('x', nodeW / 2 - 8)
        .attr('y', -nodeH / 2 + 12)
        .attr('font-size', '9px')
        .attr('text-anchor', 'end')
        .attr('fill', d => d.data.is_shared ? '#22c55e' : '#8b8fa3')
        .text(d => d.data.ref_count > 1 ? `ref:${d.data.ref_count}` : '');

    // Token text preview
    nodeG.append('text')
        .attr('x', 0)
        .attr('y', 2)
        .attr('text-anchor', 'middle')
        .attr('font-size', '11px')
        .attr('fill', '#e4e6ed')
        .text(d => {
            const text = d.data.token_text.join(' ');
            return text.length > 18 ? text.substring(0, 18) + '...' : text;
        });

    // Hash preview
    nodeG.append('text')
        .attr('x', 0)
        .attr('y', 16)
        .attr('text-anchor', 'middle')
        .attr('font-size', '8px')
        .attr('fill', '#8b8fa3')
        .attr('font-family', 'Consolas, monospace')
        .text(d => d.data.id.substring(0, 12));

    // Prompt color indicator dots
    nodeG.each(function(d) {
        const g = d3.select(this);
        const pids = d.data.prompt_ids || [];
        pids.forEach((pid, i) => {
            g.append('circle')
                .attr('cx', -nodeW / 2 + 6 + i * 8)
                .attr('cy', nodeH / 2 - 6)
                .attr('r', 3)
                .attr('fill', PROMPT_COLORS[pid % PROMPT_COLORS.length]);
        });
    });

    // Tooltip on hover
    nodeG.on('mouseover', function(event, d) {
        const tooltip = document.getElementById('pc-tooltip');
        const tokens = d.data.token_text.join(' ');
        const pids = (d.data.prompt_ids || []).map(p => `Prompt ${p + 1}`);
        tooltip.innerHTML = `
            <div style="color:#a78bfa;margin-bottom:4px;">Block #${d.data.block_index}</div>
            <div style="margin-bottom:4px;"><strong>Hash:</strong> ${d.data.id}</div>
            <div style="margin-bottom:4px;"><strong>Tokens:</strong> ${tokens}</div>
            <div style="margin-bottom:4px;"><strong>Ref Count:</strong> ${d.data.ref_count}</div>
            <div><strong>Used by:</strong> ${pids.join(', ')}</div>
            <div style="margin-top:4px;color:${d.data.is_shared?'#22c55e':'#7c5cfc'}">
                ${d.data.is_shared ? 'SHARED (cache hit)' : d.data.is_root ? 'ROOT block' : 'UNIQUE'}
            </div>
        `;
        tooltip.style.display = 'block';
        tooltip.style.left = (event.pageX + 15) + 'px';
        tooltip.style.top = (event.pageY + 15) + 'px';
    }).on('mousemove', function(event) {
        const tooltip = document.getElementById('pc-tooltip');
        tooltip.style.left = (event.pageX + 15) + 'px';
        tooltip.style.top = (event.pageY + 15) + 'px';
    }).on('mouseout', function() {
        document.getElementById('pc-tooltip').style.display = 'none';
    });

    // Initial transform: center the tree
    const bbox = inner.node().getBBox();
    const scale = Math.min(width / (bbox.width + 100), height / (bbox.height + 100), 1);
    const tx = (width - bbox.width * scale) / 2 - bbox.x * scale;
    const ty = (height - bbox.height * scale) / 2 - bbox.y * scale;
    svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

// Re-render on window resize
window.addEventListener('resize', () => {
    const placeholder = document.querySelector('#hash-chain-viz .pc-placeholder');
    if (!placeholder && document.getElementById('pc-stats').style.display !== 'none') {
        const isLive = document.getElementById('panel-live').style.display !== 'none';
        if (isLive) {
            fetchLiveHashChain();
        } else {
            simulate();
        }
    }
});

// ============================================================
// Live KV Events Mode
// ============================================================

let livePollTimer = null;

document.getElementById('btn-mode-simulate').addEventListener('click', () => {
    document.getElementById('btn-mode-simulate').classList.add('active');
    document.getElementById('btn-mode-live').classList.remove('active');
    document.getElementById('panel-simulate').style.display = 'block';
    document.getElementById('panel-live').style.display = 'none';
    document.getElementById('pc-stats').style.display = 'none';
    document.getElementById('hash-chain-viz').innerHTML = '<div class="pc-placeholder">Enter prompts and click Build Hash Chain</div>';
    const rowPrompt = document.getElementById('row-prompt-blocks');
    const rowSaved = document.getElementById('row-saved-blocks');
    if (rowPrompt) rowPrompt.style.display = '';
    if (rowSaved) rowSaved.style.display = '';
    if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }
});

document.getElementById('btn-mode-live').addEventListener('click', () => {
    document.getElementById('btn-mode-live').classList.add('active');
    document.getElementById('btn-mode-simulate').classList.remove('active');
    document.getElementById('panel-simulate').style.display = 'none';
    document.getElementById('panel-live').style.display = 'block';
    document.getElementById('pc-stats').style.display = 'none';
    document.getElementById('hash-chain-viz').innerHTML = '<div class="pc-placeholder">Connecting to KV events...</div>';
    const rowPrompt = document.getElementById('row-prompt-blocks');
    const rowSaved = document.getElementById('row-saved-blocks');
    if (rowPrompt) rowPrompt.style.display = 'none';
    if (rowSaved) rowSaved.style.display = 'none';
    fetchLiveHashChain();
    livePollTimer = setInterval(fetchLiveHashChain, 3000);
});

document.getElementById('btn-live-refresh').addEventListener('click', fetchLiveHashChain);

async function fetchLiveHashChain() {
    try {
        const resp = await fetch('/api/prefix-cache/live');
        const data = await resp.json();

        const statusEl = document.getElementById('live-status');
        if (data.error) {
            if (statusEl) statusEl.textContent = 'Error: ' + data.error;
            return;
        }

        if (statusEl) {
            const count = data.block_count || 0;
            statusEl.textContent = count + ' blocks captured';
        }

        if (!data.nodes || data.nodes.length === 0) {
            document.getElementById('hash-chain-viz').innerHTML =
                '<div class="pc-placeholder">Waiting for KV events...<br><small>Send inference requests to vLLM to populate the cache.</small></div>';
            document.getElementById('pc-stats').style.display = 'none';
            return;
        }

        // Adapt stats for live mode
        const stats = data.stats || {};
        const liveStats = {
            total_blocks: stats.total_blocks || 0,
            shared_blocks: stats.shared_blocks || 0,
            unique_blocks: stats.unique_blocks || 0,
            total_prompt_blocks: stats.total_prompt_blocks || 0,
            saved_blocks: stats.saved_blocks || 0,
            estimated_hit_rate: stats.shared_blocks > 0 && stats.total_blocks > 0
                ? stats.shared_blocks / stats.total_blocks : 0,
        };
        renderStats(liveStats);
        renderTree(data);
    } catch (e) {
        console.error('Live fetch error:', e);
        const statusEl = document.getElementById('live-status');
        if (statusEl) statusEl.textContent = 'Connection error - check KV events endpoint';
    }
}
