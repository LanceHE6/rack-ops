import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { Button, Input, Tabs, Tab, Chip } from '@heroui/react';
import {
  Search,
  Plus,
  RefreshCw,
  Box,
  Layers,
  Pencil,
  Undo2,
  Redo2,
  Save,
  XCircle,
  Server,
  Activity,
  AlertTriangle,
  LayoutGrid,
} from 'lucide-react';
import { RoomRow, Rack, Device, User, LayoutApplyPayload } from '../types';
import { api } from '../api/client';
import { FloorPlan2D } from '../components/FloorPlan2D';
import { RowView } from '../components/RowView';
import { Room3DView } from '../components/Room3DView';
import { RackDetailDrawer } from '../components/RackDetailDrawer';
import { RowConfigModal } from '../components/RowConfigModal';
import { UndoToast, ToastState } from '../components/UndoToast';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface Props {
  currentUser: User;
}

const cloneRows = (rows: RoomRow[]): RoomRow[] => JSON.parse(JSON.stringify(rows));

export function TopologyPage({ currentUser }: Props) {
  const [rows, setRows] = useState<RoomRow[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d');
  const [subView, setSubView] = useState<'room' | 'row'>('room');
  const [activeRow, setActiveRow] = useState<RoomRow | null>(null);

  // 编辑模式草稿（保存前不落库）
  const [draftRows, setDraftRows] = useState<RoomRow[] | null>(null);
  const [editMode, setEditMode] = useState(false);
  const historyRef = useRef<RoomRow[][]>([]);
  const historyIdxRef = useRef(-1);
  const [historyVersion, setHistoryVersion] = useState(0);
  const tempIdRef = useRef(-1);
  const allocTempId = useCallback(() => {
    const id = tempIdRef.current;
    tempIdRef.current -= 1;
    return id;
  }, []);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Device[]>([]);

  const [highlightRackId, setHighlightRackId] = useState<number | null>(null);
  const [highlightDeviceId, setHighlightDeviceId] = useState<number | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedRackId, setSelectedRackId] = useState<number>(0);
  const [rowModalOpen, setRowModalOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = useCallback((message: string, undo?: () => Promise<void>) => {
    setToast({ id: Date.now(), message, undo });
  }, []);

  const fetchTopology = useCallback(async () => {
    setLoading(true);
    try {
      const [rowData, devData] = await Promise.all([api.getRows(), api.getAllDevices()]);
      setRows(rowData);
      setDevices(devData);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshActiveRow = useCallback(async () => {
    if (!activeRow) return;
    try {
      const detail = await api.getRowDetail(activeRow.id);
      setActiveRow(detail);
    } catch {
      setActiveRow(null);
      setSubView('room');
    }
  }, [activeRow]);

  const refreshAll = useCallback(async () => {
    await fetchTopology();
    await refreshActiveRow();
  }, [fetchTopology, refreshActiveRow]);

  useEffect(() => {
    fetchTopology();
  }, [fetchTopology]);

  const devicesByRack = useMemo(() => {
    const map: Record<number, Device[]> = {};
    for (const d of devices) {
      (map[d.rack_id] = map[d.rack_id] || []).push(d);
    }
    return map;
  }, [devices]);

  // ---- 编辑会话 ----
  const pushDraft = useCallback((next: RoomRow[]) => {
    const stack = historyRef.current.slice(0, historyIdxRef.current + 1);
    stack.push(cloneRows(next));
    if (stack.length > 40) stack.shift();
    historyRef.current = stack;
    historyIdxRef.current = stack.length - 1;
    setDraftRows(cloneRows(next));
    setHistoryVersion((v) => v + 1);
  }, []);

  const enterEdit = () => {
    setViewMode('2d');
    setSubView('room');
    const draft = cloneRows(rows);
    historyRef.current = [draft];
    historyIdxRef.current = 0;
    setDraftRows(cloneRows(draft));
    setEditMode(true);
    setHistoryVersion((v) => v + 1);
  };

  const exitEdit = () => {
    setEditMode(false);
    setDraftRows(null);
    historyRef.current = [];
    historyIdxRef.current = -1;
    setHistoryVersion(0);
  };

  const undoEdit = useCallback(() => {
    if (historyIdxRef.current <= 0) return;
    historyIdxRef.current -= 1;
    setDraftRows(cloneRows(historyRef.current[historyIdxRef.current]));
    setHistoryVersion((v) => v + 1);
  }, []);

  const redoEdit = useCallback(() => {
    if (historyIdxRef.current >= historyRef.current.length - 1) return;
    historyIdxRef.current += 1;
    setDraftRows(cloneRows(historyRef.current[historyIdxRef.current]));
    setHistoryVersion((v) => v + 1);
  }, []);

  // 编辑模式下 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
  useEffect(() => {
    if (!editMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redoEdit();
        else undoEdit();
      } else if (key === 'y') {
        e.preventDefault();
        redoEdit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editMode, undoEdit, redoEdit]);

  const buildPayload = (original: RoomRow[], draft: RoomRow[]): LayoutApplyPayload => {
    const origRowById = new Map(original.map((r) => [r.id, r]));
    const origRacks = original.flatMap((r) => r.racks || []);
    const origRackById = new Map(origRacks.map((k) => [k.id, k]));
    const draftRackIds = new Set(draft.flatMap((r) => r.racks || []).filter((k) => k.id > 0).map((k) => k.id));
    const draftRowIds = new Set(draft.filter((r) => r.id > 0).map((r) => r.id));

    const rowDeletes = original.filter((r) => !draftRowIds.has(r.id)).map((r) => r.id);
    const rackDeletes = origRacks.filter((k) => !draftRackIds.has(k.id)).map((k) => k.id);

    const rowPositions: LayoutApplyPayload['row_positions'] = [];
    const rackPositions: LayoutApplyPayload['rack_positions'] = [];
    const rackCreates: LayoutApplyPayload['rack_creates'] = [];
    const rowCreates: LayoutApplyPayload['row_creates'] = [];

    for (const r of draft) {
      if (r.id > 0) {
        const o = origRowById.get(r.id);
        if (o && (o.pos_x !== r.pos_x || o.pos_y !== r.pos_y)) {
          rowPositions.push({ id: r.id, pos_x: r.pos_x, pos_y: r.pos_y });
        }
        for (const k of r.racks || []) {
          if (k.id > 0) {
            const ok = origRackById.get(k.id);
            if (ok && (ok.rel_x !== k.rel_x || ok.rel_y !== k.rel_y)) {
              rackPositions.push({ id: k.id, rel_x: k.rel_x, rel_y: k.rel_y });
            }
          } else {
            rackCreates.push({ row_id: r.id, total_u: k.total_u, rel_x: k.rel_x, rel_y: k.rel_y });
          }
        }
      } else {
        rowCreates.push({
          name: r.name,
          prefix: r.prefix,
          aisle_direction: r.aisle_direction,
          default_u_height: r.default_u_height,
          sort_order: r.sort_order,
          pos_x: r.pos_x,
          pos_y: r.pos_y,
          racks: (r.racks || []).map((k) => ({ rel_x: k.rel_x, rel_y: k.rel_y })),
        });
      }
    }

    return {
      row_positions: rowPositions,
      rack_positions: rackPositions,
      rack_creates: rackCreates,
      row_creates: rowCreates,
      rack_deletes: rackDeletes,
      row_deletes: rowDeletes,
    };
  };

  const saveEdit = async () => {
    if (!draftRows) return;
    const payload = buildPayload(rows, draftRows);
    const isEmpty =
      payload.row_positions.length === 0 &&
      payload.rack_positions.length === 0 &&
      payload.rack_creates.length === 0 &&
      payload.row_creates.length === 0 &&
      payload.rack_deletes.length === 0 &&
      payload.row_deletes.length === 0;
    if (!isEmpty) {
      setLoading(true);
      try {
        await api.applyLayout(payload);
      } catch (err: any) {
        setLoading(false);
        showToast(`保存失败: ${err.message}`);
        return;
      }
    }
    exitEdit();
    await refreshAll();
    setLoading(false);
    showToast(isEmpty ? '无改动' : '布局修改已保存');
  };

  const openRow = async (row: RoomRow) => {
    setEditMode(false);
    setDraftRows(null);
    setDrawerOpen(false);
    try {
      const detail = await api.getRowDetail(row.id);
      setActiveRow(detail);
      setSubView('row');
    } catch (err: any) {
      showToast(`进入机排失败: ${err.message}`);
    }
  };

  const openRack = (rack: Rack, deviceId?: number) => {
    setSelectedRackId(rack.id);
    setHighlightRackId(rack.id);
    setHighlightDeviceId(deviceId ?? null);
    setDrawerOpen(true);
  };

  const handleSearch = async (val: string) => {
    setSearchQuery(val);
    if (!val.trim()) {
      setSearchResults([]);
      setHighlightRackId(null);
      setHighlightDeviceId(null);
      return;
    }
    try {
      const results = await api.searchDevices(val.trim());
      setSearchResults(results);
      if (results.length > 0) {
        setHighlightRackId(results[0].rack_id);
        setHighlightDeviceId(results[0].id);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleGlobalCollect = async () => {
    try {
      await api.triggerCollect();
      showToast('已触发全机房状态采集任务');
      setTimeout(refreshAll, 3000);
    } catch (err: any) {
      showToast(`触发采集失败: ${err.message}`);
    }
  };

  const addDraftRow = (data: {
    name: string;
    prefix: string;
    rack_count: number;
    default_u_height: number;
    aisle_direction: string;
    sort_order: number;
  }) => {
    const base = draftRows || [];
    const baseY = base.length ? Math.max(...base.map((r) => r.pos_y)) + 3 : 0;
    const rowId = allocTempId();
    const racks: Rack[] = Array.from({ length: data.rack_count }, (_, i) => {
      const colStr = String(i + 1).padStart(2, '0');
      return {
        id: allocTempId(),
        row_id: rowId,
        col_index: i + 1,
        code: `${data.prefix}${colStr}`,
        name: `${data.name}-${colStr}`,
        total_u: data.default_u_height,
        description: '',
        rel_x: i,
        rel_y: 0,
        created_at: '',
        updated_at: '',
        devices: [],
      };
    });
    const row: RoomRow = {
      id: rowId,
      name: data.name,
      sort_order: data.sort_order,
      rack_count: racks.length,
      default_u_height: data.default_u_height,
      aisle_direction: data.aisle_direction,
      prefix: data.prefix,
      pos_x: 0,
      pos_y: baseY,
      created_at: '',
      updated_at: '',
      racks,
    };
    pushDraft([...base, row]);
  };

  const totalRacks = rows.reduce((s, r) => s + (r.racks?.length || 0), 0);
  const onlineCount = devices.filter((d) => d.telemetry?.online_status === 'online').length;
  const alertCount = devices.filter(
    (d) => d.telemetry?.health_status === 'critical' || d.telemetry?.health_status === 'warning'
  ).length;
  const onlinePct = devices.length ? Math.round((onlineCount / devices.length) * 100) : 0;

  const isAdmin = currentUser.role === 'admin';
  const inRoom2D = viewMode === '2d' && subView === 'room';
  const canUndo = historyIdxRef.current > 0;
  const canRedo = historyIdxRef.current < historyRef.current.length - 1;
  void historyVersion; // 触发工具条重渲染

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] overflow-hidden">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-slate-800 bg-slate-900/50 gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 flex-wrap">
          <Tabs
            selectedKey={viewMode}
            onSelectionChange={(k) => {
              setViewMode(k as '2d' | '3d');
              if (editMode) exitEdit();
              setDrawerOpen(false);
            }}
            color="primary"
            size="sm"
            variant="solid"
            classNames={{ tabList: 'bg-slate-800 border border-slate-700', cursor: 'bg-sky-600' }}
          >
            <Tab
              key="2d"
              title={
                <div className="flex items-center gap-1.5 px-1">
                  <LayoutGrid className="w-3.5 h-3.5" />
                  <span>2D 平面图</span>
                </div>
              }
            />
            <Tab
              key="3d"
              title={
                <div className="flex items-center gap-1.5 px-1">
                  <Box className="w-3.5 h-3.5" />
                  <span>3D 全景</span>
                </div>
              }
            />
          </Tabs>

          {inRoom2D && isAdmin && !editMode && (
            <>
              <Button
                size="sm"
                variant="bordered"
                className="text-xs border-amber-500/50 text-amber-300"
                startContent={<Pencil className="w-3.5 h-3.5" />}
                onPress={enterEdit}
              >
                编辑布局
              </Button>
              <Button
                size="sm"
                color="primary"
                variant="flat"
                className="text-xs"
                startContent={<Plus className="w-3.5 h-3.5" />}
                onPress={() => setRowModalOpen(true)}
              >
                新建机排
              </Button>
            </>
          )}

          {editMode && (
            <>
              <Button
                size="sm"
                variant="flat"
                className="text-xs text-slate-300 bg-slate-800"
                startContent={<Undo2 className="w-3.5 h-3.5" />}
                isDisabled={!canUndo}
                onPress={undoEdit}
              >
                撤销
              </Button>
              <Button
                size="sm"
                variant="flat"
                className="text-xs text-slate-300 bg-slate-800"
                startContent={<Redo2 className="w-3.5 h-3.5" />}
                isDisabled={!canRedo}
                onPress={redoEdit}
              >
                重做
              </Button>
              <Button
                size="sm"
                color="primary"
                className="text-xs"
                startContent={<Save className="w-3.5 h-3.5" />}
                onPress={saveEdit}
                isLoading={loading}
              >
                保存修改
              </Button>
              <Button
                size="sm"
                variant="bordered"
                className="text-xs border-red-500/50 text-red-300"
                startContent={<XCircle className="w-3.5 h-3.5" />}
                onPress={() => setDiscardOpen(true)}
              >
                放弃修改
              </Button>
              <Chip size="sm" variant="flat" color="warning" className="text-[11px]">
                编辑中 · 未保存
              </Chip>
            </>
          )}

          {!editMode && (
            <Button
              size="sm"
              variant="flat"
              className="text-xs text-slate-300 border border-slate-700"
              startContent={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />}
              onPress={refreshAll}
            >
              刷新
            </Button>
          )}

          {isAdmin && !editMode && (
            <Button
              size="sm"
              variant="bordered"
              className="text-xs border-slate-700 text-sky-400"
              startContent={<Activity className="w-3.5 h-3.5" />}
              onPress={handleGlobalCollect}
            >
              一键采集
            </Button>
          )}
        </div>

        {/* 全局搜索 */}
        <div className="relative w-80">
          <Input
            placeholder="搜索设备名 / IP / 型号 / 资产号 / SN..."
            size="sm"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            startContent={<Search className="w-4 h-4 text-slate-400" />}
            isClearable
            onClear={() => handleSearch('')}
            classNames={{ inputWrapper: 'bg-slate-800 border-slate-700 text-xs' }}
          />
          {searchQuery && searchResults.length > 0 && (
            <div className="absolute right-0 top-11 w-96 max-h-80 overflow-y-auto z-50 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl p-2 space-y-1">
              <div className="text-[11px] font-semibold text-slate-400 px-2 py-1">
                匹配到 {searchResults.length} 台设备（点击定位并打开机柜）：
              </div>
              {searchResults.map((d) => (
                <div
                  key={d.id}
                  onClick={() => {
                    setHighlightRackId(d.rack_id);
                    setHighlightDeviceId(d.id);
                    const matchedRow = rows.find((r) => r.racks?.some((rk) => rk.id === d.rack_id));
                    const matchedRack = matchedRow?.racks?.find((rk) => rk.id === d.rack_id);
                    if (matchedRack) openRack(matchedRack, d.id);
                    setSearchResults([]);
                    setSearchQuery('');
                  }}
                  className="p-2 rounded bg-slate-800 hover:bg-sky-950/70 border border-slate-700 hover:border-sky-500 cursor-pointer transition-colors"
                >
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-bold text-slate-100">{d.name}</span>
                    <span className="text-[10px] font-mono text-sky-400">
                      {d.row_name} - {d.rack_code} / U{d.start_u}~U{d.start_u + d.u_height - 1}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono flex items-center gap-3">
                    {d.mgmt_ip && <span>IP: {d.mgmt_ip}</span>}
                    {d.vendor && <span>{d.vendor} {d.model}</span>}
                    {d.owner && <span>使用人: {d.owner}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 统计条 */}
      <div className="flex items-center gap-2 px-5 py-1.5 border-b border-slate-800/60 bg-slate-950/60 text-[11px]">
        <Chip size="sm" variant="flat" className="bg-slate-800/80 text-slate-300 h-5 text-[11px]" startContent={<Layers className="w-3 h-3 ml-1 text-sky-400" />}>
          {rows.length} 排 · {totalRacks} 机柜
        </Chip>
        <Chip size="sm" variant="flat" className="bg-slate-800/80 text-slate-300 h-5 text-[11px]" startContent={<Server className="w-3 h-3 ml-1 text-emerald-400" />}>
          {devices.length} 台设备 · 在线率 {onlinePct}%
        </Chip>
        {alertCount > 0 && (
          <Chip size="sm" variant="flat" color="warning" className="h-5 text-[11px]" startContent={<AlertTriangle className="w-3 h-3 ml-1" />}>
            {alertCount} 条告警
          </Chip>
        )}
        <span className="ml-auto text-slate-600 hidden md:inline">
          {viewMode === '2d'
            ? subView === 'room'
              ? editMode
                ? '拖动按整格吸附 · Ctrl+Z 撤销 · Ctrl+Y 重做 · 保存后生效'
                : '点击机排标签进入机排视角 · 点击机柜查看设备'
              : '点击机柜卡片或设备格子查看详情'
            : '点击 3D 机柜进入机柜视角'}
        </span>
      </div>

      {/* 主视图 */}
      <div className="flex-1 min-h-0">
        {viewMode === '3d' ? (
          <div className="h-full p-5 overflow-y-auto">
            <Room3DView
              rows={rows}
              devicesByRack={devicesByRack}
              highlightRackId={highlightRackId}
              onSelectRack={(rk) => openRack(rk)}
            />
          </div>
        ) : subView === 'row' && activeRow ? (
          <RowView
            row={activeRow}
            userRole={currentUser.role}
            highlightRackId={highlightRackId}
            onBack={() => {
              setSubView('room');
              setActiveRow(null);
            }}
            onOpenRack={openRack}
            onRefresh={refreshAll}
            onToast={showToast}
          />
        ) : (
          <FloorPlan2D
            rows={editMode && draftRows ? draftRows : rows}
            userRole={currentUser.role}
            editMode={editMode}
            highlightRackId={highlightRackId}
            devicesByRack={devicesByRack}
            allocTempId={allocTempId}
            onOpenRack={(rk) => {
              if (!editMode) openRack(rk);
            }}
            onOpenRow={openRow}
            onDraftChange={pushDraft}
            onAddRow={() => setRowModalOpen(true)}
          />
        )}
      </div>

      {/* 机柜详情抽屉（仅打开时挂载，避免浮层残留阻塞点击） */}
      {drawerOpen && (
        <RackDetailDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          rackId={selectedRackId}
          userRole={currentUser.role}
          highlightDeviceId={highlightDeviceId}
          onDeviceChange={refreshAll}
        />
      )}

      {/* 新建机排（编辑模式进草稿，否则直接创建） */}
      {rowModalOpen && (
        <RowConfigModal
          isOpen={rowModalOpen}
          onClose={() => setRowModalOpen(false)}
          onSuccess={editMode ? () => {} : refreshAll}
          nextSortOrder={rows.length + 1}
          onCreate={editMode ? async (data) => addDraftRow(data) : undefined}
        />
      )}

      {discardOpen && (
        <ConfirmDialog
          isOpen={discardOpen}
          title="放弃修改"
          message="本次布局编辑尚未保存，确定放弃全部改动并返回吗？"
          confirmLabel="放弃修改"
          onClose={() => setDiscardOpen(false)}
          onConfirm={async () => {
            setDiscardOpen(false);
            exitEdit();
            await refreshAll();
            showToast('已放弃本次布局修改');
          }}
        />
      )}

      <UndoToast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
