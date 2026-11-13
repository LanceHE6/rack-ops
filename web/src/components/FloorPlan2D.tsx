import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import {
  Plus,
  X,
  GripVertical,
  ZoomIn,
  ZoomOut,
  Maximize2,
  ChevronRight,
  Server,
  Network,
  Database,
  Cpu,
  Thermometer,
} from 'lucide-react';
import { RoomRow, Rack, Device, Role } from '../types';
import { ConfirmDialog } from './ConfirmDialog';

// 网格：1 格 = 1 个机柜位。编辑模式严格吸附整格
const UNIT = 132;
const RACK_W = 1.0;
const RACK_D = 2.0;
const RACK_SPACING = 1.0;
const ROW_PAD = 0.5;
const RACK_INSET = 5;
const FLOOR_MARGIN = 1.6;

interface Props {
  rows: RoomRow[];
  userRole: Role;
  editMode: boolean;
  highlightRackId: number | null;
  devicesByRack: Record<number, Device[]>;
  allocTempId: () => number;
  onOpenRack: (rack: Rack) => void;
  onOpenRow: (row: RoomRow) => void;
  onDraftChange: (rows: RoomRow[]) => void;
  onAddRow: () => void;
}

interface DragSession {
  kind: 'rack' | 'row' | 'pan';
  id: number;
  startClientX: number;
  startClientY: number;
  origX: number;
  origY: number;
  moved: boolean;
  row?: RoomRow;
  latestX?: number;
  latestY?: number;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function rowLocalBounds(row: RoomRow): Bounds {
  const racks = row.racks || [];
  if (racks.length === 0) {
    return { minX: 0, minY: 0, maxX: RACK_W, maxY: RACK_D };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of racks) {
    minX = Math.min(minX, r.rel_x);
    minY = Math.min(minY, r.rel_y);
    maxX = Math.max(maxX, r.rel_x + RACK_W);
    maxY = Math.max(maxY, r.rel_y + RACK_D);
  }
  return { minX, minY, maxX, maxY };
}

function computeFloorBounds(rows: RoomRow[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const row of rows) {
    const lb = rowLocalBounds(row);
    minX = Math.min(minX, row.pos_x + lb.minX - ROW_PAD);
    minY = Math.min(minY, row.pos_y + lb.minY - ROW_PAD);
    maxX = Math.max(maxX, row.pos_x + lb.maxX + ROW_PAD);
    maxY = Math.max(maxY, row.pos_y + lb.maxY + ROW_PAD);
  }
  if (!isFinite(minX)) {
    minX = 0; minY = 0; maxX = 6; maxY = 5;
  }
  return {
    minX: minX - FLOOR_MARGIN,
    minY: minY - FLOOR_MARGIN,
    maxX: maxX + FLOOR_MARGIN,
    maxY: maxY + FLOOR_MARGIN,
  };
}

// 默认缩放只看机柜实际占位，四周留一点边距，避免机房留白把视图缩得很小
function computeRackBounds(rows: RoomRow[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const row of rows) {
    for (const rk of row.racks || []) {
      minX = Math.min(minX, row.pos_x + rk.rel_x);
      minY = Math.min(minY, row.pos_y + rk.rel_y);
      maxX = Math.max(maxX, row.pos_x + rk.rel_x + RACK_W);
      maxY = Math.max(maxY, row.pos_y + rk.rel_y + RACK_D);
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 4, maxY: 3 };
  const pad = 0.5;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const snapGrid = (v: number) => Math.round(v);

function healthColor(state?: string) {
  switch (state) {
    case 'critical': return '#f87171';
    case 'warning': return '#fbbf24';
    case 'ok': return '#34d399';
    default: return '#64748b';
  }
}

const TYPE_DOT: Record<string, string> = {
  server: '#38bdf8',
  switch: '#34d399',
  storage: '#fbbf24',
  other: '#c084fc',
};

export function FloorPlan2D({
  rows,
  userRole,
  editMode,
  highlightRackId,
  devicesByRack,
  allocTempId,
  onOpenRack,
  onOpenRow,
  onDraftChange,
  onAddRow,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [localRows, setLocalRows] = useState<RoomRow[]>(rows);
  const [scale, setScale] = useState(0.9);
  const [offset, setOffset] = useState({ x: 60, y: 60 });
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ device: Device; x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'rack' | 'row'; id: number; label: string } | null>(null);

  const dragRef = useRef<DragSession | null>(null);
  const scaleRef = useRef(scale);
  const offsetRef = useRef(offset);
  const fittedRef = useRef(false);
  const localRowsRef = useRef(localRows);
  scaleRef.current = scale;
  offsetRef.current = offset;
  localRowsRef.current = localRows;

  useEffect(() => {
    if (!dragRef.current) setLocalRows(rows);
  }, [rows]);

  const bounds = computeFloorBounds(localRows);
  const worldW = (bounds.maxX - bounds.minX) * UNIT;
  const worldH = (bounds.maxY - bounds.minY) * UNIT;

  const fitView = (useRows?: RoomRow[]) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    const b = computeRackBounds(useRows || localRowsRef.current);
    const w = (b.maxX - b.minX) * UNIT;
    const h = (b.maxY - b.minY) * UNIT;
    const s = clamp(Math.min((rect.width - 48) / w, (rect.height - 48) / h), 0.3, 2.2);
    setScale(s);
    // 以机柜包围盒为中心；容器与世界共用 computeFloorBounds 原点
    const floor = computeFloorBounds(useRows || localRowsRef.current);
    setOffset({
      x: rect.width / 2 - ((b.minX + b.maxX) / 2 - floor.minX) * UNIT * s,
      y: rect.height / 2 - ((b.minY + b.maxY) / 2 - floor.minY) * UNIT * s,
    });
  };

  useEffect(() => {
    if (fittedRef.current || rows.length === 0) return;
    let cancelled = false;
    const tryFit = (attempt: number) => {
      if (cancelled) return;
      const el = containerRef.current;
      if (el && el.getBoundingClientRect().height > 80) {
        fittedRef.current = true;
        fitView(rows);
        return;
      }
      if (attempt < 10) setTimeout(() => tryFit(attempt + 1), 60);
    };
    tryFit(0);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!fittedRef.current && localRowsRef.current.length > 0 && el.getBoundingClientRect().height > 80) {
        fittedRef.current = true;
        fitView();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 滚轮缩放（以光标为中心）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const old = scaleRef.current;
      const next = clamp(old * (e.deltaY < 0 ? 1.12 : 0.89), 0.3, 2.6);
      const off = offsetRef.current;
      setScale(next);
      setOffset({ x: cx - ((cx - off.x) / old) * next, y: cy - ((cy - off.y) / old) * next });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 拖拽（机柜 / 机排 / 画布平移），松手吸附整格并提交草稿
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const s = dragRef.current;
      if (!s) return;
      const dxScreen = e.clientX - s.startClientX;
      const dyScreen = e.clientY - s.startClientY;
      if (Math.hypot(dxScreen, dyScreen) > 4) s.moved = true;
      if (s.kind === 'pan') {
        setOffset({ x: s.origX + dxScreen, y: s.origY + dyScreen });
        return;
      }
      const dx = dxScreen / scaleRef.current / UNIT;
      const dy = dyScreen / scaleRef.current / UNIT;
      const nx = s.origX + dx;
      const ny = s.origY + dy;
      s.latestX = nx;
      s.latestY = ny;
      // 吸附预览：显示落点所在的标准网格单元
      if (s.kind === 'rack' && s.row) {
        setPreview({ x: snapGrid(nx), y: snapGrid(ny), w: RACK_W, h: RACK_D });
      } else if (s.kind === 'row' && s.row) {
        const lb = rowLocalBounds(s.row);
        setPreview({
          x: snapGrid(nx) + lb.minX - ROW_PAD,
          y: snapGrid(ny) + lb.minY - ROW_PAD,
          w: lb.maxX - lb.minX + ROW_PAD * 2,
          h: lb.maxY - lb.minY + ROW_PAD * 2,
        });
      }
      setLocalRows((prev) =>
        prev.map((row) => {
          if (s.kind === 'row' && row.id === s.id) return { ...row, pos_x: nx, pos_y: ny };
          if (s.kind === 'rack' && row.id === s.row?.id) {
            return {
              ...row,
              racks: (row.racks || []).map((rk) => (rk.id === s.id ? { ...rk, rel_x: nx, rel_y: ny } : rk)),
            };
          }
          return row;
        })
      );
    };

    const onUp = () => {
      const s = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      setPreview(null);
      if (!s) return;
      if (s.kind === 'pan') return;

      if (!s.moved) {
        if (s.kind === 'row' && s.row && !editMode) onOpenRow(s.row);
        return;
      }

      const snappedX = s.latestX !== undefined ? snapGrid(s.latestX) : s.origX;
      const snappedY = s.latestY !== undefined ? snapGrid(s.latestY) : s.origY;
      // 基于当前本地数据同步计算，避免在 setState 更新函数内产生副作用
      const base = localRowsRef.current;
      const next = base.map((row) => {
        if (s.kind === 'row' && row.id === s.id) return { ...row, pos_x: snappedX, pos_y: snappedY };
        if (s.kind === 'rack' && row.id === s.row?.id) {
          return {
            ...row,
            racks: (row.racks || []).map((rk) => (rk.id === s.id ? { ...rk, rel_x: snappedX, rel_y: snappedY } : rk)),
          };
        }
        return row;
      });
      setLocalRows(next);
      onDraftChange(next);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, editMode]);

  const beginDrag = (e: React.PointerEvent, session: Omit<DragSession, 'startClientX' | 'startClientY' | 'moved'>) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { ...session, startClientX: e.clientX, startClientY: e.clientY, moved: false };
    setDragging(true);
  };

  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = {
      kind: 'pan',
      id: 0,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: offsetRef.current.x,
      origY: offsetRef.current.y,
      moved: false,
    };
    setDragging(true);
  };

  // 编辑模式：在草稿中追加一个机柜（不落库）
  const addRackDraft = (row: RoomRow) => {
    const racks = row.racks || [];
    const maxRelX = racks.length ? Math.max(...racks.map((r) => r.rel_x)) : -RACK_SPACING;
    const nextCol = racks.length ? Math.max(...racks.map((r) => r.col_index)) + 1 : 1;
    const colStr = String(nextCol).padStart(2, '0');
    const tempRack: Rack = {
      id: allocTempId(),
      row_id: row.id,
      col_index: nextCol,
      code: `${row.prefix}${colStr}`,
      name: `${row.name}-${colStr}`,
      total_u: row.default_u_height || 42,
      description: '',
      rel_x: maxRelX + RACK_SPACING,
      rel_y: 0,
      created_at: '',
      updated_at: '',
      devices: [],
    };
    const next = localRowsRef.current.map((r) => (r.id === row.id ? { ...r, racks: [...(r.racks || []), tempRack] } : r));
    setLocalRows(next);
    onDraftChange(next);
  };

  const doDelete = () => {
    if (!confirm) return;
    const target = confirm;
    setConfirm(null);
    const base = localRowsRef.current;
    let next: RoomRow[] = [];
    if (target.kind === 'rack') {
      next = base.map((r) => ({ ...r, racks: (r.racks || []).filter((rk) => rk.id !== target.id) }));
    } else {
      next = base.filter((r) => r.id !== target.id);
    }
    setLocalRows(next);
    onDraftChange(next);
  };

  const px = (x: number) => (x - bounds.minX) * UNIT;
  const py = (y: number) => (y - bounds.minY) * UNIT;

  // 全屏网格：随画布平移缩放，铺满整个视口；偏移与机柜坐标原点对齐，确保吸附整格与可见网格完全重合
  const gridStyle: React.CSSProperties = {
    backgroundColor: '#060911',
    backgroundImage: `
      linear-gradient(rgba(56, 189, 248, 0.09) 1px, transparent 1px),
      linear-gradient(90deg, rgba(56, 189, 248, 0.09) 1px, transparent 1px),
      linear-gradient(rgba(56, 189, 248, 0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(56, 189, 248, 0.04) 1px, transparent 1px)`,
    backgroundSize: `
      ${UNIT * scale}px ${UNIT * scale}px,
      ${UNIT * scale}px ${UNIT * scale}px,
      ${(UNIT * scale) / 2}px ${(UNIT * scale) / 2}px,
      ${(UNIT * scale) / 2}px ${(UNIT * scale) / 2}px`,
    backgroundPosition: [
      `${offset.x - bounds.minX * UNIT * scale}px ${offset.y - bounds.minY * UNIT * scale}px`,
      `${offset.x - bounds.minX * UNIT * scale}px ${offset.y - bounds.minY * UNIT * scale}px`,
      `${offset.x - bounds.minX * UNIT * scale}px ${offset.y - bounds.minY * UNIT * scale}px`,
      `${offset.x - bounds.minX * UNIT * scale}px ${offset.y - bounds.minY * UNIT * scale}px`,
    ].join(', '),
  };

  return (
    <div
      ref={containerRef}
      data-floor-container="1"
      className={`relative w-full h-full overflow-hidden ${dragging ? 'dragging' : ''}`}
      style={{ ...gridStyle, cursor: dragging ? 'grabbing' : editMode ? 'default' : 'grab' }}
      onPointerDown={startPan}
    >
      {/* 机柜/机排层 */}
      <div
        className="absolute top-0 left-0"
        style={{
          width: worldW,
          height: worldH,
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin: '0 0',
        }}
      >
        {/* 机房范围轮廓 */}
        <div className="absolute inset-0 rounded-2xl border border-sky-500/25 shadow-[inset_0_0_120px_rgba(14,116,144,0.14)] pointer-events-none" />

        {localRows.map((row) => {
          const lb = rowLocalBounds(row);
          const zx = px(row.pos_x + lb.minX - ROW_PAD);
          const zy = py(row.pos_y + lb.minY - ROW_PAD);
          const zw = (lb.maxX - lb.minX + ROW_PAD * 2) * UNIT;
          const zh = (lb.maxY - lb.minY + ROW_PAD * 2) * UNIT;
          const racks = row.racks || [];
          const maxRelX = racks.length ? Math.max(...racks.map((r) => r.rel_x)) : -RACK_SPACING;

          return (
            <div key={row.id}>
              <div
                className="absolute rounded-xl border border-dashed border-sky-500/30 bg-sky-500/[0.03]"
                style={{ left: zx, top: zy, width: zw, height: zh, pointerEvents: 'none' }}
              />
              <div
                data-row-label={row.name}
                data-row-id={row.id}
                className={`absolute z-10 flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-lg border text-xs font-semibold select-none ${
                  editMode
                    ? 'bg-amber-500/15 border-amber-400/50 text-amber-200 cursor-grab'
                    : 'bg-slate-900/95 border-sky-500/40 text-sky-300 cursor-pointer hover:bg-sky-950'
                }`}
                style={{ left: zx + 8, top: zy - 14, pointerEvents: 'auto' }}
                onPointerDown={
                  editMode
                    ? (e) => beginDrag(e, { kind: 'row', id: row.id, origX: row.pos_x, origY: row.pos_y, row })
                    : undefined
                }
                onClick={!editMode ? () => onOpenRow(row) : undefined}
              >
                {editMode && <GripVertical className="w-3.5 h-3.5 opacity-70" />}
                <span>{row.name}</span>
                <span className="font-normal opacity-70">{racks.length} 柜</span>
                {!editMode && <ChevronRight className="w-3.5 h-3.5 opacity-70" />}
                {editMode && (
                  <button
                    className="ml-1 p-0.5 rounded hover:bg-red-500/30 text-red-300"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirm({ kind: 'row', id: row.id, label: row.name });
                    }}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>

              {racks.map((rack) => {
                const isHighlight = rack.id === highlightRackId;
                const used = rack.used_u || 0;
                const total = rack.total_u || 42;
                const pct = Math.min(100, Math.round((used / total) * 100));
                const devs = devicesByRack[rack.id] || rack.devices || [];
                return (
                  <div
                    key={rack.id}
                    data-rack={rack.code}
                    data-rack-id={rack.id}
                    className="absolute"
                    style={{
                      left: px(row.pos_x + rack.rel_x),
                      top: py(row.pos_y + rack.rel_y),
                      width: RACK_W * UNIT,
                      height: RACK_D * UNIT,
                      pointerEvents: 'auto',
                      cursor: editMode ? 'grab' : 'pointer',
                    }}
                    onPointerDown={
                      editMode
                        ? (e) => beginDrag(e, { kind: 'rack', id: rack.id, origX: rack.rel_x, origY: rack.rel_y, row })
                        : undefined
                    }
                    onClick={!editMode ? () => onOpenRack(rack) : undefined}
                  >
                    {/* 卡片在格内留出空隙，相邻机柜之间可见网格线，不再紧贴 */}
                    <div
                      className={`absolute rounded-lg border overflow-hidden transition-shadow ${
                        isHighlight ? 'rack-highlight border-sky-400' : 'border-slate-600/70'
                      } ${editMode ? 'hover:border-amber-400/70' : 'hover:border-sky-400/80'} ${
                        rack.id < 0 ? 'ring-1 ring-amber-400/40' : ''
                      }`}
                      style={{
                        position: 'absolute',
                        inset: RACK_INSET,
                        background: 'linear-gradient(160deg, #1a2537 0%, #101827 60%, #0c1322 100%)',
                        boxShadow: isHighlight ? undefined : '0 6px 18px rgba(0,0,0,0.45)',
                      }}
                    >
                      <div className="absolute inset-x-2 top-1.5 h-1 rounded-full bg-slate-600/40" />
                      <div className="relative h-full flex flex-col justify-between p-2 pr-4 pt-3">
                        <div className="flex items-start justify-between gap-1">
                          <span className="font-mono text-sm font-bold text-sky-300">{rack.code}</span>
                          <span
                            className={`w-2 h-2 rounded-full mt-1 shrink-0 ${rack.health_state === 'critical' ? 'led-critical' : ''}`}
                            style={{ background: healthColor(rack.health_state), boxShadow: `0 0 6px ${healthColor(rack.health_state)}` }}
                          />
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">{rack.name}</div>
                        <div className="space-y-1">
                          {rack.max_temp != null && (
                            <div className="flex items-center gap-1 text-[10px] font-mono text-amber-300">
                              <Thermometer className="w-2.5 h-2.5" />
                              {Math.round(rack.max_temp)}°C
                            </div>
                          )}
                          <div className="flex justify-between text-[9px] font-mono text-slate-500">
                            <span>{used}/{total}U</span>
                            <span>{devs.length > 0 ? `${devs.length} 台` : ''}</span>
                          </div>
                          <div className="h-1 rounded-full bg-slate-900 overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{ width: `${pct}%`, background: pct > 80 ? '#f59e0b' : pct > 50 ? '#38bdf8' : '#475569' }}
                            />
                          </div>
                        </div>
                      </div>

                      {/* 竖向设备示意（机柜视图缩小版）：按真实 U 位自下而上排布，悬停显示概略信息 */}
                      <div
                        className="absolute right-1.5 w-3 rounded-sm bg-slate-950/85 border border-slate-700/70 overflow-hidden"
                        style={{ top: '22%', bottom: '28%', pointerEvents: 'auto' }}
                        onMouseLeave={() => setHoverInfo(null)}
                      >
                        {devs.map((d) => (
                          <div
                            key={d.id}
                            className="absolute left-0 w-full hover:brightness-150"
                            style={{
                              bottom: `${(((d.start_u - 1) / total) * 100).toFixed(2)}%`,
                              height: `${Math.max((d.u_height / total) * 100, 3).toFixed(2)}%`,
                              minHeight: 4,
                              background: TYPE_DOT[d.type] || '#94a3b8',
                              opacity: d.telemetry?.online_status === 'offline' ? 0.45 : 0.95,
                            }}
                            onMouseEnter={(e) => {
                              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              const cont = containerRef.current?.getBoundingClientRect();
                              if (!cont) return;
                              setHoverInfo({
                                device: d,
                                x: Math.min(r.right - cont.left + 8, cont.width - 230),
                                y: Math.min(Math.max(r.top - cont.top - 10, 8), cont.height - 130),
                              });
                            }}
                          />
                        ))}
                        {devs.length === 0 && (
                          <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[7px] text-slate-600">
                            空
                          </span>
                        )}
                      </div>
                    </div>
                    {editMode && (
                      <button
                        className="absolute top-1 right-1 p-0.5 rounded bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/50"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirm({ kind: 'rack', id: rack.id, label: rack.code });
                        }}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                );
              })}

              {editMode && (
                <div
                  className="absolute rounded-lg border-2 border-dashed border-emerald-500/40 bg-emerald-500/[0.05] flex flex-col items-center justify-center gap-1 cursor-pointer hover:bg-emerald-500/15 hover:border-emerald-400/70 transition-colors"
                  style={{
                    left: px(row.pos_x + maxRelX + RACK_SPACING) + RACK_INSET,
                    top: py(row.pos_y) + RACK_INSET,
                    width: RACK_W * UNIT - RACK_INSET * 2,
                    height: RACK_D * UNIT - RACK_INSET * 2,
                    pointerEvents: 'auto',
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => addRackDraft(row)}
                >
                  <Plus className="w-5 h-5 text-emerald-400" />
                  <span className="text-[10px] text-emerald-300 font-medium">添加机柜</span>
                </div>
              )}
            </div>
          );
        })}

        {/* 拖拽吸附落点预览 */}
        {preview && (
          <div
            className="absolute rounded-lg border-2 border-dashed border-amber-400/70 bg-amber-400/[0.06] pointer-events-none"
            style={{ left: px(preview.x), top: py(preview.y), width: preview.w * UNIT, height: preview.h * UNIT }}
          />
        )}
      </div>

      {/* 左上角状态 */}
      <div className="absolute top-3 left-4 flex flex-col gap-2 pointer-events-none">
        <div className="flex items-center gap-2">
          <span className="px-2.5 py-1 rounded-lg bg-slate-900/90 border border-slate-700 text-xs font-mono text-sky-300">
            机房俯视平面图
          </span>
          <span className="px-2 py-1 rounded-lg bg-slate-900/70 border border-slate-800 text-[10px] text-slate-400">
            1 格 = 1 机柜位（0.6m）· 滚轮缩放 · 空白处拖动平移
          </span>
        </div>
        {editMode && (
          <div className="px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/40 text-[11px] text-amber-200 max-w-md">
            编辑模式：拖动机柜/机排标签按整格吸附 · 虚线框添加机柜 · × 删除 · 修改需点击「保存修改」生效
          </div>
        )}
      </div>

      {editMode && userRole === 'admin' && (
        <div className="absolute top-3 right-4">
          <Button size="sm" color="primary" variant="flat" startContent={<Plus className="w-4 h-4" />} onPress={onAddRow} className="text-xs">
            新增机排
          </Button>
        </div>
      )}

      <div className="absolute bottom-3 left-4 flex items-center gap-3 px-3 py-1.5 rounded-lg bg-slate-900/85 border border-slate-800 text-[10px] text-slate-400 pointer-events-none">
        <span className="flex items-center gap-1"><Server className="w-3 h-3 text-sky-400" />服务器</span>
        <span className="flex items-center gap-1"><Network className="w-3 h-3 text-emerald-400" />交换机</span>
        <span className="flex items-center gap-1"><Database className="w-3 h-3 text-amber-400" />存储</span>
        <span className="flex items-center gap-1"><Cpu className="w-3 h-3 text-purple-400" />其他</span>
        <span className="w-px h-3 bg-slate-700" />
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400" />正常</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400" />告警</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400" />严重</span>
      </div>

      <div className="absolute bottom-3 right-4 flex items-center gap-1 px-2 py-1.5 rounded-lg bg-slate-900/90 border border-slate-700">
        <Button size="sm" isIconOnly variant="light" className="text-slate-300 min-w-7 w-7 h-7" onPress={() => setScale((s) => clamp(s * 0.89, 0.3, 2.6))}>
          <ZoomOut className="w-3.5 h-3.5" />
        </Button>
        <span className="text-[10px] font-mono text-slate-400 w-10 text-center">{Math.round(scale * 100)}%</span>
        <Button size="sm" isIconOnly variant="light" className="text-slate-300 min-w-7 w-7 h-7" onPress={() => setScale((s) => clamp(s * 1.12, 0.3, 2.6))}>
          <ZoomIn className="w-3.5 h-3.5" />
        </Button>
        <Button size="sm" isIconOnly variant="light" className="text-sky-300 min-w-7 w-7 h-7" onPress={() => fitView()}>
          <Maximize2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* 设备概略信息悬浮卡 */}
      {hoverInfo && (
        <div
          className="absolute z-40 pointer-events-none w-56 p-2.5 rounded-lg bg-slate-900/95 border border-sky-500/40 shadow-2xl"
          style={{ left: hoverInfo.x, top: hoverInfo.y }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-bold text-slate-100 truncate">{hoverInfo.device.name}</span>
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{
                background:
                  hoverInfo.device.telemetry?.online_status === 'online'
                    ? '#34d399'
                    : hoverInfo.device.telemetry?.online_status === 'offline'
                    ? '#f87171'
                    : '#64748b',
              }}
            />
          </div>
          <div className="text-[10px] font-mono text-sky-300 mt-1">{hoverInfo.device.mgmt_ip || '无管理 IP'}</div>
          <div className="text-[10px] text-slate-400 mt-1">
            {hoverInfo.device.vendor} {hoverInfo.device.model} · U{hoverInfo.device.start_u}~U
            {hoverInfo.device.start_u + hoverInfo.device.u_height - 1}
          </div>
          <div className="text-[10px] text-slate-400">
            {hoverInfo.device.telemetry?.online_status === 'online' ? '在线' : hoverInfo.device.telemetry?.online_status === 'offline' ? '离线' : '状态未知'}
            {hoverInfo.device.telemetry?.max_temp_c != null && hoverInfo.device.telemetry.max_temp_c > 0
              ? ` · ${Math.round(hoverInfo.device.telemetry.max_temp_c)}°C`
              : ''}
            {hoverInfo.device.owner ? ` · 使用人 ${hoverInfo.device.owner}` : ''}
          </div>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          isOpen={!!confirm}
          title={confirm.kind === 'rack' ? '删除机柜' : '删除机排'}
          message={
            confirm.kind === 'rack'
              ? `确定从布局中移除机柜 ${confirm.label}？保存修改后其内部设备将一并删除。`
              : `确定从布局中移除机排 ${confirm.label}？保存修改后该排全部机柜与设备将一并删除。`
          }
          onConfirm={doDelete}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
