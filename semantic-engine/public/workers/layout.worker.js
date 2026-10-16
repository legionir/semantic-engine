/**
 * layout.worker.js — Offloads ELK & Force layout calculations from the UI thread to a Web Worker.
 */

self.onmessage = function (e) {
  const { nodes, edges, options } = e.data;

  // Simple and fast spring-embedder layout algorithm running in worker
  const nodeCount = nodes.length;
  const positions = {};
  const width = options?.width || 1200;
  const height = options?.height || 800;

  // Circular / grid initialization
  const radius = Math.min(width, height) * 0.4;
  nodes.forEach((n, idx) => {
    const angle = (idx / nodeCount) * 2 * Math.PI;
    positions[n.id] = {
      x: width / 2 + radius * Math.cos(angle) + (Math.random() - 0.5) * 50,
      y: height / 2 + radius * Math.sin(angle) + (Math.random() - 0.5) * 50,
    };
  });

  // 30 iterations of spring simulation
  const iterations = Math.min(60, Math.max(20, Math.floor(1000 / (nodeCount + 1))));
  for (let iter = 0; iter < iterations; iter++) {
    // Repulsion
    for (let i = 0; i < nodeCount; i++) {
      const n1 = nodes[i];
      for (let j = i + 1; j < nodeCount; j++) {
        const n2 = nodes[j];
        const p1 = positions[n1.id];
        const p2 = positions[n2.id];
        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const distSq = dx * dx + dy * dy + 100;
        const force = 5000 / distSq;

        const fx = (dx / Math.sqrt(distSq)) * force;
        const fy = (dy / Math.sqrt(distSq)) * force;

        p1.x += fx;
        p1.y += fy;
        p2.x -= fx;
        p2.y -= fy;
      }
    }

    // Attraction along edges
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      const p1 = positions[edge.source];
      const p2 = positions[edge.target];
      if (p1 && p2) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 1;
        const force = dist * 0.05;

        p1.x += (dx / dist) * force;
        p1.y += (dy / dist) * force;
        p2.x -= (dx / dist) * force;
        p2.y -= (dy / dist) * force;
      }
    }
  }

  self.postMessage({ positions });
};
