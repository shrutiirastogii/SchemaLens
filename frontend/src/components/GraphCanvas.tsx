import { useRef, useCallback, useMemo, useEffect, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { SchemaNode, SchemaEdge, GraphData, NodeRole } from '../lib/types';

interface Props {
  data: GraphData;
  selectedNode: SchemaNode | null;
  hoveredNode: SchemaNode | null;
  focusNodeId: string | null;
  highlightedNodeIds: Set<string>;
  activePath: string[] | null;
  pathSourceId: string | null;
  onNodeClick: (node: SchemaNode) => void;
  onNodeHover: (node: SchemaNode | null) => void;
}

// ── Visual config by role ──────────────────────────────────────────────────
const ROLE: Record<NodeRole, { color: string; glow: string; baseR: number; rScale: number }> = {
  hub:      { color: '#d946ef', glow: 'rgba(217,70,239,0.55)',  baseR: 11, rScale: 1.7 },
  bridge:   { color: '#f59e0b', glow: 'rgba(245,158,11,0.40)',  baseR: 8,  rScale: 1.3 },
  leaf:     { color: '#3b82f6', glow: 'rgba(59,130,246,0.30)',  baseR: 6,  rScale: 1.0 },
  isolated: { color: '#4b5563', glow: 'rgba(75,85,99,0.20)',    baseR: 6,  rScale: 0.8 },
  normal:   { color: '#6366f1', glow: 'rgba(99,102,241,0.35)', baseR: 7,  rScale: 1.1 },
};

function nodeR(node: { column_count?: number; role?: string }): number {
  const cfg = ROLE[(node.role as NodeRole) ?? 'normal'] ?? ROLE.normal;
  return Math.max(cfg.baseR, Math.min(28, cfg.baseR + Math.sqrt(node.column_count ?? 0) * cfg.rScale));
}

// State that canvas callbacks read — never close over directly (stale closure)
interface CanvasState {
  hoveredNode: SchemaNode | null;
  selectedNode: SchemaNode | null;
  highlightedNodeIds: Set<string>;
  activePath: string[] | null;
  pathSourceId: string | null;
  hlNodes: Set<string>;
  hlEdges: Set<string>;
}

// ── Component ──────────────────────────────────────────────────────────────
export default function GraphCanvas({
  data, selectedNode, hoveredNode, focusNodeId,
  highlightedNodeIds, activePath, pathSourceId,
  onNodeClick, onNodeHover,
}: Props) {
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<CanvasState>({
    hoveredNode: null, selectedNode: null, highlightedNodeIds: new Set(),
    activePath: null, pathSourceId: null, hlNodes: new Set(), hlEdges: new Set(),
  });
  const graphDataRef = useRef<{ nodes: any[]; links: any[] }>({ nodes: [], links: [] });

  const [dims, setDims] = useState({ w: window.innerWidth, h: window.innerHeight });

  // ── Resize ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const obs = new ResizeObserver(e => {
      const r = e[0].contentRect;
      setDims({ w: r.width, h: r.height });
    });
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ── Force layout ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!graphRef.current || data.nodes.length === 0) return;
    const g = graphRef.current;

    // Isolated nodes generate almost no charge; distanceMax caps how far
    // connected-node repulsion can reach so isolated nodes aren't launched away.
    const chargeForce = g.d3Force('charge') as any;
    if (chargeForce) {
      chargeForce.strength((node: any) => node.role === 'isolated' ? -8 : -250);
      if (typeof chargeForce.distanceMax === 'function') chargeForce.distanceMax(260);
    }
    g.d3Force('link')?.distance(110).strength(0.5);

    // Isolated nodes have no edges. This explicit gravity pulls them toward
    // the cluster center — strength 0.08 scales with distance. Dead-zone < 30px
    // prevents micro-jitter once nodes settle near the origin.
    g.d3Force('isolatedGravity', () => {
      for (const node of graphDataRef.current.nodes) {
        if (node.role !== 'isolated' || node.x == null) continue;
        if (Math.hypot(node.x, node.y) < 30) continue;
        node.vx = (node.vx ?? 0) - node.x * 0.08;
        node.vy = (node.vy ?? 0) - node.y * 0.08;
      }
    });

    // Idle motion: gentle nudge every 8 s so the graph never fully freezes.
    // Piggybacked here (same dep) so graphRef.current is guaranteed non-null.
    const idleId = setInterval(() => {
      if (!graphRef.current) return;
      graphRef.current.d3ReheatSimulation();
    }, 8000);

    g.d3ReheatSimulation();

    return () => clearInterval(idleId);
  }, [data.nodes.length]);

  // ── Camera focus ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!focusNodeId || !graphRef.current) return;
    const node = graphDataRef.current.nodes.find((n: any) => n.id === focusNodeId);
    if (node?.x != null) {
      graphRef.current.centerAt(node.x, node.y, 900);
      graphRef.current.zoom(2.8, 900);
    }
  }, [focusNodeId]);

  // ── Hover neighborhood ──────────────────────────────────────────────────────
  const { hlNodes, hlEdges } = useMemo(() => {
    if (!hoveredNode) return { hlNodes: new Set<string>(), hlEdges: new Set<string>() };
    const hn = new Set<string>([hoveredNode.id]);
    const he = new Set<string>();
    data.edges.forEach((e: SchemaEdge) => {
      const src = typeof e.source === 'object' ? (e.source as any).id : e.source;
      const tgt = typeof e.target === 'object' ? (e.target as any).id : e.target;
      if (src === hoveredNode.id || tgt === hoveredNode.id) {
        hn.add(src); hn.add(tgt);
        he.add(`${src}::${tgt}`); he.add(`${tgt}::${src}`);
      }
    });
    return { hlNodes: hn, hlEdges: he };
  }, [hoveredNode, data.edges]);

  // Always current — read by all canvas callbacks
  stateRef.current = {
    hoveredNode, selectedNode, highlightedNodeIds,
    activePath, pathSourceId, hlNodes, hlEdges,
  };

  // Wrap onNodeClick/onNodeHover so callbacks read current value without re-creating
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;
  const onNodeHoverRef = useRef(onNodeHover);
  onNodeHoverRef.current = onNodeHover;

  // ── Double-click to zoom (without deselecting) ──────────────────────────────
  // On a double-click both events fire. We detect the second click via timing
  // and skip forwarding it to App state — so the panel stays open while zooming.
  const lastClick = useRef<{ id: string; t: number } | null>(null);

  const handleClickStable = useCallback((node: any) => {
    const now = Date.now();
    const isDouble = lastClick.current && lastClick.current.id === node.id && now - lastClick.current.t < 340;
    lastClick.current = { id: node.id, t: now };
    if (isDouble) {
      graphRef.current?.centerAt(node.x, node.y, 600);
      graphRef.current?.zoom(4.5, 600);
      return; // don't toggle selection on the second click
    }
    onNodeClickRef.current(node as SchemaNode);
  }, []);

  const handleHoverStable = useCallback((node: any) => {
    onNodeHoverRef.current(node as SchemaNode | null);
  }, []);

  // ── Node canvas ─────────────────────────────────────────────────────────────
  // useCallback([]) = stable reference = ForceGraph2D's loop never resets
  const nodeCanvasObject = useCallback((node: any, ctx: CanvasRenderingContext2D, scale: number) => {
    // d3 positions nodes after first tick — skip until coordinates are valid
    if (node.x == null || !isFinite(node.x) || node.y == null || !isFinite(node.y)) return;

    const { hoveredNode, selectedNode, highlightedNodeIds, activePath, hlNodes } = stateRef.current;
    const role: NodeRole = node.role ?? 'normal';
    const cfg = ROLE[role] ?? ROLE.normal;

    const isSelected  = node.id === selectedNode?.id;
    const isHovered   = node.id === hoveredNode?.id;
    const isHl        = hlNodes.has(node.id);
    const isInsightHl = highlightedNodeIds.size > 0 && highlightedNodeIds.has(node.id);
    const isOnPath    = !!activePath?.includes(node.id);
    const isPathSrc   = node.id === stateRef.current.pathSourceId;

    const shouldDim = !isSelected && (
      (hoveredNode !== null && !isHl) ||
      (highlightedNodeIds.size > 0 && !isInsightHl) ||
      (activePath !== null && activePath.length > 0 && !isOnPath)
    );

    const r = nodeR(node);
    const t = Date.now() / 1000;
    const pulse = role === 'hub'
      ? 0.5 + 0.5 * Math.sin(t * 1.1 + (node.pulse_offset ?? 0))
      : role === 'bridge'
      ? 0.35 + 0.25 * Math.sin(t * 0.75 + (node.pulse_offset ?? 0))
      : 0;

    ctx.save();
    ctx.globalAlpha = shouldDim ? 0.12 : 1;

    // Glow aura — skip at low zoom (nodes too small to see detail, saves fillStyle+radialGradient)
    if (!shouldDim && scale >= 0.4 && (isSelected || isHovered || isHl || isInsightHl || isOnPath || pulse > 0.3)) {
      const glowR = r + (isSelected ? 10 : isHovered ? 7 : 4 + pulse * 5);
      const g = ctx.createRadialGradient(node.x, node.y, r * 0.3, node.x, node.y, glowR + 3);
      const a0 = isSelected ? '0.65' : isOnPath ? '0.5' : (0.3 + pulse * 0.35).toFixed(2);
      const color = isSelected ? `rgba(232,121,249,${a0})` : isOnPath && !isPathSrc ? `rgba(99,255,200,${a0})` : cfg.glow.replace(/,[^,)]+\)$/, `,${a0})`);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowR + 3, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
    }

    // Body
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = shouldDim ? '#1a1a2e' : isOnPath ? (isPathSrc ? '#c026d3' : '#22d3ee') : cfg.color;
    ctx.fill();

    // Border
    ctx.lineWidth = isSelected ? 2.5 : isHovered || isHl ? 1.8 : 1;
    ctx.strokeStyle = isSelected ? '#e879f9'
      : isOnPath ? (isPathSrc ? '#e879f9' : '#67e8f9')
      : isHl || isHovered ? 'rgba(255,255,255,0.7)'
      : shouldDim ? 'rgba(255,255,255,0.04)'
      : 'rgba(255,255,255,0.18)';
    ctx.stroke();
    ctx.restore();

    // Label
    const showLabel = scale > 0.75 || isHovered || isSelected || isOnPath || role === 'hub';
    if (showLabel) {
      const fs = Math.max(9, Math.min(13, 12 / scale));
      ctx.font = `${isSelected || isHovered || role === 'hub' ? '600' : '400'} ${fs}px "SF Mono","Fira Code",monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = shouldDim ? 'rgba(255,255,255,0.04)'
        : isSelected || isHovered ? '#ffffff'
        : isOnPath ? 'rgba(255,255,255,0.95)'
        : role === 'hub' ? 'rgba(255,255,255,0.88)'
        : 'rgba(255,255,255,0.55)';
      ctx.fillText(node.name, node.x, node.y + r + 4);
    }
  }, []); // [] — reads stateRef at call time, never goes stale

  // ── Link canvas (replace = full control, arrows, ripple, path) ─────────────
  const linkCanvasObject = useCallback((link: any, ctx: CanvasRenderingContext2D) => {
    const src = typeof link.source === 'object' ? link.source : null;
    const tgt = typeof link.target === 'object' ? link.target : null;
    if (src?.x == null || tgt?.x == null) return;

    const { hlEdges, activePath, hoveredNode, highlightedNodeIds } = stateRef.current;
    const srcId = src.id as string;
    const tgtId = tgt.id as string;

    const isHl = hlEdges.has(`${srcId}::${tgtId}`) || hlEdges.has(`${tgtId}::${srcId}`);
    const isPathEdge = !!activePath && activePath.length > 1 && activePath.some((id, i) => {
      const next = activePath[i + 1];
      return (id === srcId && next === tgtId) || (id === tgtId && next === srcId);
    });
    const hasDim = hoveredNode !== null || highlightedNodeIds.size > 0 || (!!activePath && activePath.length > 0);

    // ── Choose appearance ───────────────────────────────────────────────────
    let color: string;
    let lineWidth: number;
    let alpha = 1;

    if (isPathEdge) {
      color = 'rgba(99,255,200,0.85)';
      lineWidth = 2.8;
    } else if (isHl) {
      color = 'rgba(139,92,246,0.75)';
      lineWidth = 1.8;
    } else if (hasDim) {
      color = 'rgba(99,102,241,0.07)';
      lineWidth = 1;
      alpha = 0.5;
    } else {
      color = 'rgba(99,102,241,0.22)';
      lineWidth = 1;
    }

    const dx = tgt.x - src.x;
    const dy = tgt.y - src.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;
    const ux = dx / len, uy = dy / len;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Glow for path edges
    if (isPathEdge) {
      ctx.shadowBlur = 10;
      ctx.shadowColor = 'rgba(99,255,200,0.5)';
    }

    // Path: animated dashes
    if (isPathEdge) {
      const t = Date.now() / 280;
      ctx.setLineDash([9, 6]);
      ctx.lineDashOffset = -(t % 15);
    }

    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(tgt.x, tgt.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    // Arrow head
    if (isPathEdge || isHl) {
      const tR = nodeR(tgt);
      const ax = tgt.x - ux * (tR + 2);
      const ay = tgt.y - uy * (tR + 2);
      const al = 7;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - ux * al + uy * 4, ay - uy * al - ux * 4);
      ctx.lineTo(ax - ux * al - uy * 4, ay - uy * al + ux * 4);
      ctx.closePath();
      ctx.fillStyle = isPathEdge ? 'rgba(99,255,200,0.9)' : 'rgba(139,92,246,0.8)';
      ctx.fill();
    }

    // ── Ripple: traveling dots along highlighted edges ──────────────────────
    if (isHl) {
      const t = Date.now() / 650;
      for (let i = 0; i < 3; i++) {
        const progress = ((t + i / 3) % 1);
        const fade = Math.sin(progress * Math.PI);    // 0 at endpoints, 1 at midpoint
        const x = src.x + dx * progress;
        const y = src.y + dy * progress;
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(167,139,250,${(fade * 0.9).toFixed(2)})`;
        ctx.fill();
      }
    }

    ctx.restore();
  }, []); // [] — reads stateRef at call time

  // Stable mode callbacks — [] deps prevents new references on every render
  const nodeModeCallback   = useCallback(() => 'replace' as const, []);
  const linkModeCallback   = useCallback(() => 'replace' as const, []);
  const nodeLabelCallback  = useCallback(() => '', []);

  // Pointer hit area is 1.8× the visual radius so the full node body (and a
  // comfortable margin) triggers hover/click, not just the very center.
  const nodePointerAreaPaint = useCallback((node: any, color: string, ctx: CanvasRenderingContext2D) => {
    if (node.x == null || !isFinite(node.x) || node.y == null || !isFinite(node.y)) return;
    const r = nodeR(node) * 1.8;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }, []);

  // ── Graph data ──────────────────────────────────────────────────────────────
  const graphData = useMemo(() => {
    // Give isolated nodes a starting position near center so they don't start far away
    const isolatedNodes = data.nodes.filter(n => n.role === 'isolated');
    const result = {
      nodes: data.nodes.map(n => {
        const node: any = { ...n };
        if (n.role === 'isolated') {
          const idx = isolatedNodes.indexOf(n);
          const angle = (idx / Math.max(1, isolatedNodes.length)) * Math.PI * 2;
          node.x = Math.cos(angle) * 60;
          node.y = Math.sin(angle) * 60;
        }
        return node;
      }),
      links: data.edges.map(e => ({ ...e })),
    };
    graphDataRef.current = result;
    return result;
  }, [data]);

  return (
    <div ref={containerRef} className="absolute inset-0">
      <ForceGraph2D
        ref={graphRef}
        graphData={graphData}
        width={dims.w}
        height={dims.h}
        backgroundColor="#070711"
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={nodeModeCallback}
        nodePointerAreaPaint={nodePointerAreaPaint}
        linkCanvasObject={linkCanvasObject}
        linkCanvasObjectMode={linkModeCallback}
        onNodeHover={handleHoverStable}
        onNodeClick={handleClickStable}
        nodeLabel={nodeLabelCallback}
        // cooldownTicks=Infinity: canvas renders every frame forever.
        // This is required for hub pulse and ripple animations.
        // Never use 0 — that stops the simulation after 0 ticks, breaking drag.
        cooldownTicks={Infinity}
        d3AlphaDecay={0.022}
        d3VelocityDecay={0.3}
        enableNodeDrag
        enableZoomInteraction
        enablePanInteraction
      />
    </div>
  );
}
