// Docker Monitor - Image Layer Tree Visualization
;(function() {
  var container = null, svg = null, inner = null;
  var currentData = null;
  var savedZoomTransform = d3.zoomIdentity;

  // --- DOM ---
  var el = function(id) { return document.getElementById(id); };

  // --- Init ---
  function init() {
    el('btn-load-image').addEventListener('click', loadImage);
    el('btn-load-demo').addEventListener('click', loadDemo);
    el('btn-close-detail').addEventListener('click', closeDetail);
    el('layer-direction').addEventListener('change', function() {
      if (currentData) render(currentData);
    });
  }

  // --- Load image layers ---
  async function loadImage() {
    var name = el('image-name').value.trim();
    if (!name) return;

    var viz = el('layer-viz');
    viz.innerHTML = '<div class="pc-placeholder">Loading layers for ' + escapeHtml(name) + '...</div>';

    try {
      var resp = await fetch('/api/image/layers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: name }),
      });
      var data = await resp.json();
      if (data.error) {
        viz.innerHTML = '<div class="pc-placeholder" style="color:var(--red)">Error: ' + escapeHtml(data.error) + '</div>';
        return;
      }
      currentData = data;
      updateInfoPanel(data);
      render(data);
    } catch (err) {
      viz.innerHTML = '<div class="pc-placeholder" style="color:var(--red)">Request failed: ' + escapeHtml(err.message) + '</div>';
    }
  }

  async function loadDemo() {
    var viz = el('layer-viz');
    viz.innerHTML = '<div class="pc-placeholder">Loading demo layers...</div>';
    try {
      var resp = await fetch('/api/image/layers/demo');
      var data = await resp.json();
      currentData = data;
      updateInfoPanel(data);
      render(data);
    } catch (err) {
      viz.innerHTML = '<div class="pc-placeholder" style="color:var(--red)">Request failed</div>';
    }
  }

  function updateInfoPanel(data) {
    el('layer-info-panel').style.display = 'block';
    el('li-image-id').textContent = data.image_id || '--';
    el('li-created').textContent = data.created ? new Date(data.created).toLocaleString() : '--';
    el('li-os-arch').textContent = (data.os || '--') + ' / ' + (data.architecture || '--');
    el('li-size').textContent = formatBytes(data.total_size || 0);
    el('li-layers').textContent = data.total_layers || 0;
    el('row-demo-notice').style.display = data.is_demo ? 'flex' : 'none';
  }

  // --- Render the layer tree ---
  function render(data) {
    var nodes = data.nodes || [];
    var edges = data.edges || [];
    var viz = el('layer-viz');
    viz.innerHTML = '';

    if (nodes.length === 0) {
      viz.innerHTML = '<div class="pc-placeholder">No layers found</div>';
      return;
    }

    container = viz;
    var direction = el('layer-direction').value;
    var isHorizontal = direction === 'horizontal';

    var width = container.clientWidth || 800;
    var height = container.clientHeight || 600;

    svg = d3.select(viz).append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .style('display', 'block');

    inner = svg.append('g');

    // Zoom
    var zoom = d3.zoom()
      .scaleExtent([0.2, 3])
      .on('zoom', function(event) {
        inner.attr('transform', event.transform);
        savedZoomTransform = event.transform;
      });
    svg.call(zoom);

    // Build tree — layers form a linear chain
    // We represent it as a tree with a virtual root
    // (first layer has no parent in edges, so it's the root)

    // Find root: nodes with is_root or no incoming edge
    var rootNodes = nodes.filter(function(n) { return n.is_root; });

    // Build children map from edges
    var childrenMap = {};
    nodes.forEach(function(n) { childrenMap[n.id] = []; });
    edges.forEach(function(e) {
      if (childrenMap[e.source]) childrenMap[e.source].push(e.target);
    });

    // Since Docker layers form a linear chain, we should have one root
    var rootId = rootNodes.length > 0 ? rootNodes[0].id : (nodes[0] ? nodes[0].id : null);
    if (!rootId) return;

    // Build tree data recursively
    function buildTree(nodeId) {
      var node = nodes.find(function(n) { return n.id === nodeId; });
      if (!node) return null;
      var childIds = childrenMap[nodeId] || [];
      return {
        id: nodeId,
        data: node,
        children: childIds.map(buildTree).filter(Boolean),
      };
    }

    // If there are multiple roots (unlikely for Docker but handle it)
    var roots = rootNodes.map(function(n) { return buildTree(n.id); }).filter(Boolean);

    // If linear chain, add virtual root for better layout
    var treeData;
    if (roots.length === 1 && roots[0].children.length === 1 && !roots[0].children[0].children.length) {
      // Very short chain, use as-is
      treeData = { id: '__virtual_root__', children: roots, data: { isVirtual: true } };
    } else {
      treeData = { id: '__virtual_root__', children: roots, data: { isVirtual: true } };
    }

    // Tree layout
    var nodeSizeX = isHorizontal ? 55 : 200;
    var nodeSizeY = isHorizontal ? 220 : 55;

    var treeLayout = d3.tree()
      .nodeSize([nodeSizeX, nodeSizeY])
      .separation(function(a, b) { return 1; });

    var root = d3.hierarchy(treeData);
    treeLayout(root);

    var layoutNodes = root.descendants().filter(function(n) { return !n.data.data || !n.data.data.isVirtual; });
    var layoutLinks = root.links().filter(function(l) { return !l.source.data.data || !l.source.data.data.isVirtual; });

    // Compute bounds for initial view
    var xExtent = d3.extent(layoutNodes, function(d) { return d.y; });
    var yExtent = d3.extent(layoutNodes, function(d) { return d.x; });

    // Draw links
    var linkGen = isHorizontal
      ? d3.linkHorizontal().x(function(d) { return d.y; }).y(function(d) { return d.x; })
      : d3.linkVertical().x(function(d) { return d.x; }).y(function(d) { return d.y; });

    inner.selectAll('.layer-link')
      .data(layoutLinks)
      .enter()
      .append('path')
      .attr('class', 'layer-link')
      .attr('d', linkGen);

    // Draw nodes
    var nodeGroups = inner.selectAll('.layer-node')
      .data(layoutNodes)
      .enter()
      .append('g')
      .attr('class', 'layer-node')
      .attr('transform', function(d) {
        return isHorizontal
          ? 'translate(' + d.y + ',' + d.x + ')'
          : 'translate(' + d.x + ',' + d.y + ')';
      })
      .on('click', function(event, d) {
        event.stopPropagation();
        showDetail(d.data.data, event);
      })
      .on('mouseenter', function(event, d) {
        showTooltip(d.data.data, event);
      })
      .on('mouseleave', function() {
        el('layer-tooltip').style.display = 'none';
      });

    // Node rects
    nodeGroups.append('rect')
      .attr('x', isHorizontal ? -70 : -65)
      .attr('y', -18)
      .attr('width', isHorizontal ? 140 : 130)
      .attr('height', 36)
      .attr('rx', 6)
      .attr('fill', function(d) {
        var n = d.data.data;
        if (n.is_root) return 'rgba(249,115,22,0.15)';
        if (n.is_leaf) return 'rgba(34,197,94,0.15)';
        return 'rgba(124,92,252,0.12)';
      })
      .attr('stroke', function(d) {
        var n = d.data.data;
        if (n.is_root) return '#f97316';
        if (n.is_leaf) return '#22c55e';
        return '#7c5cfc';
      });

    // Layer index labels
    nodeGroups.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '-2')
      .style('font-size', '10px')
      .style('fill', 'var(--text-dim)')
      .text(function(d) { return '#' + d.data.data.index; });

    // Layer short description
    nodeGroups.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '11')
      .style('font-size', '10px')
      .style('fill', 'var(--text)')
      .text(function(d) {
        var cmd = d.data.data.command || '';
        if (cmd.length > 25) cmd = cmd.substring(0, 23) + '...';
        return cmd || '(layer)';
      });

    // Size labels below
    nodeGroups.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '26')
      .style('font-size', '9px')
      .style('fill', 'var(--text-dim)')
      .text(function(d) { return formatBytes(d.data.data.size); });

    // Auto-fit view
    var pad = 40;
    var svgW = svg.node().clientWidth;
    var svgH = svg.node().clientHeight;
    var dataW = (xExtent[1] - xExtent[0]) || 200;
    var dataH = (yExtent[1] - yExtent[0]) || 200;
    var scale = Math.min((svgW - pad * 2) / dataW, (svgH - pad * 2) / dataH, 1.5);
    var tx = (svgW - dataW * scale) / 2 - (xExtent[0] || 0) * scale;
    var ty = (svgH - dataH * scale) / 2 - (yExtent[0] || 0) * scale;

    svg.transition().duration(400).call(
      zoom.transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale)
    );
  }

  // --- Detail panel ---
  function showDetail(nodeData, event) {
    var panel = el('layer-detail-panel');
    var content = el('layer-detail-content');
    panel.style.display = 'block';

    var cmd = nodeData.command || '(empty)';
    var sizeStr = formatBytes(nodeData.size || 0);

    content.innerHTML =
      '<div class="bdp-field"><div class="bdp-field-label">Layer Index</div><div class="bdp-field-value">#' + nodeData.index + '</div></div>' +
      '<div class="bdp-field"><div class="bdp-field-label">ID</div><div class="bdp-field-value" style="font-family:monospace;font-size:11px;">' + escapeHtml(nodeData.id) + '</div></div>' +
      '<div class="bdp-field"><div class="bdp-field-label">Full ID</div><div class="bdp-field-value" style="font-family:monospace;font-size:10px;word-break:break-all;">' + escapeHtml(nodeData.full_id) + '</div></div>' +
      '<div class="bdp-field"><div class="bdp-field-label">Estimated Size</div><div class="bdp-field-value">' + sizeStr + '</div></div>' +
      '<div class="bdp-field"><div class="bdp-field-label">Type</div><div class="bdp-field-value">' + (nodeData.is_root ? 'Root Layer' : nodeData.is_leaf ? 'Top Layer (Leaf)' : 'Intermediate Layer') + '</div></div>' +
      '<div class="bdp-field"><div class="bdp-field-label">Dockerfile Instruction</div><div class="bdp-field-value code">' + escapeHtml(cmd) + '</div></div>';
  }

  function closeDetail() {
    el('layer-detail-panel').style.display = 'none';
  }

  // --- Tooltip ---
  function showTooltip(nodeData, event) {
    var tt = el('layer-tooltip');
    var cmd = nodeData.command || '';
    if (cmd.length > 80) cmd = cmd.substring(0, 77) + '...';
    tt.innerHTML =
      '<div style="font-weight:600;">Layer #' + nodeData.index + '</div>' +
      '<div class="tt-cmd">' + escapeHtml(cmd) + '</div>' +
      '<div style="margin-top:4px;color:var(--text-dim)">' + formatBytes(nodeData.size) + '</div>';
    tt.style.display = 'block';
    tt.style.left = (event.offsetX + 15) + 'px';
    tt.style.top = (event.offsetY - 10) + 'px';
  }

  // --- Utility ---
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    i = Math.min(i, units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- Init on DOM ready ---
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
