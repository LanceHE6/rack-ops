import { useState, useEffect, useRef, type PointerEvent as RPointerEvent } from 'react';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerBody,
  Button,
  Chip,
  Tooltip,
  Tabs,
  Tab,
} from '@heroui/react';
import {
  Server,
  Network,
  Database,
  Plus,
  Terminal,
  Cpu,
  Trash2,
  Edit,
  ExternalLink,
  RefreshCw,
  Box,
  Layers,
  GripVertical,
  X,
} from 'lucide-react';
import { Rack, Device, Role } from '../types';
import { api } from '../api/client';
import { DeviceModal } from './DeviceModal';
import { WebTerminalModal } from './WebTerminalModal';
import { Rack3DView } from './Rack3DView';
import { PlacementModal } from './PlacementModal';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  rackId: number;
  userRole: Role;
  highlightDeviceId?: number | null;
  onDeviceChange: () => void;
}

export function RackDetailDrawer({
  isOpen,
  onClose,
  rackId,
  userRole,
  highlightDeviceId,
  onDeviceChange,
}: Props) {
  const [rack, setRack] = useState<Rack | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [rackView, setRackView] = useState<'2d' | '3d'>('2d');

  // 弹窗状态
  const [deviceModalOpen, setDeviceModalOpen] = useState(false);
  const [deviceModalStartU, setDeviceModalStartU] = useState<number>(1);
  const [deviceModalUHeight, setDeviceModalUHeight] = useState<number>(1);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [placementOpen, setPlacementOpen] = useState(false);
  const [placementStartU, setPlacementStartU] = useState<number>(1);

  const [termOpen, setTermOpen] = useState(false);
  const [termType, setTermType] = useState<'webssh' | 'ipmisol'>('webssh');
  const [termDevice, setTermDevice] = useState<{ id: number; name: string; ip: string } | null>(null);

  // U 位拖动改位：拖动交互点固定在行首（U 标签）
  const [dragU, setDragU] = useState<{ id: number; delta: number; valid: boolean } | null>(null);
  const dragRef = useRef<{ id: number; startU: number; uHeight: number; y0: number } | null>(null);
  const dragMovedRef = useRef(false);
  const [moveErr, setMoveErr] = useState<string | null>(null);

  const fetchRack = async () => {
    if (!rackId) return;
    setLoading(true);
    try {
      const data = await api.getRack(rackId);
      setRack(data);
      if (highlightDeviceId && data.devices) {
        const found = data.devices.find((d) => d.id === highlightDeviceId);
        if (found) setSelectedDevice(found);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && rackId) {
      fetchRack();
    }
  }, [isOpen, rackId]);

  // 抽屉关闭时同步关闭内部浮层，避免遗留遮罩层阻塞页面点击
  useEffect(() => {
    if (!isOpen) {
      setPlacementOpen(false);
      setDeviceModalOpen(false);
      setTermOpen(false);
      setSelectedDevice(null);
    }
  }, [isOpen]);

  const handleDeleteDevice = async (dev: Device) => {
    if (!window.confirm(`确定要删除设备 ${dev.name} 吗？`)) return;
    try {
      await api.deleteDevice(dev.id);
      fetchRack();
      onDeviceChange();
      if (selectedDevice?.id === dev.id) setSelectedDevice(null);
    } catch (err: any) {
      alert(err.message || '删除失败');
    }
  };

  const handleCollectRefresh = async (dev: Device) => {
    try {
      await api.triggerCollect(dev.id);
      alert('已触发设备状态刷新探针，请稍候片刻');
      setTimeout(fetchRack, 2000);
    } catch (err: any) {
      alert(err.message || '刷新触发失败');
    }
  };

  // U 位拖动：行首 U 标签即拖动交互点，松手后调用设备更新接口改位
  const U_STEP = 30;

  const uRangeFree = (devId: number, startU: number, uHeight: number) => {
    const total = rack?.total_u || 42;
    if (startU < 1 || startU + uHeight - 1 > total) return false;
    for (const d of rack?.devices || []) {
      if (d.id === devId) continue;
      if (startU <= d.start_u + d.u_height - 1 && d.start_u <= startU + uHeight - 1) return false;
    }
    return true;
  };

  const targetStartU = (startU: number, uHeight: number, dy: number) => {
    const total = rack?.total_u || 42;
    const raw = Math.round(dy / U_STEP); // 向上拖动 => U 位升高
    return Math.min(Math.max(startU - raw, 1), total - uHeight + 1);
  };

  const onDevDragStart = (e: RPointerEvent, dev: Device) => {
    if (userRole !== 'admin') return;
    e.stopPropagation();
    dragMovedRef.current = false;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 部分环境不支持指针捕获，忽略即可 */
    }
    dragRef.current = { id: dev.id, startU: dev.start_u, uHeight: dev.u_height, y0: e.clientY };
    setMoveErr(null);
    setDragU({ id: dev.id, delta: 0, valid: true });
  };

  const onDevDragMove = (e: RPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const t = targetStartU(d.startU, d.uHeight, e.clientY - d.y0);
    const delta = t - d.startU;
    if (delta !== 0) dragMovedRef.current = true;
    setDragU({ id: d.id, delta, valid: uRangeFree(d.id, t, d.uHeight) });
  };

  const onDevDragEnd = async (e: RPointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const t = targetStartU(d.startU, d.uHeight, e.clientY - d.y0);
    setDragU(null);
    if (t === d.startU) return;
    if (!uRangeFree(d.id, t, d.uHeight)) {
      setMoveErr('目标 U 位与其他设备重叠，未做修改');
      return;
    }
    const dev = (rack?.devices || []).find((x) => x.id === d.id);
    if (!dev || !rack) return;
    try {
      await api.updateDevice(dev.id, {
        rack_id: rack.id,
        start_u: t,
        u_height: dev.u_height,
        type: dev.type,
        sub_brand: dev.sub_brand || '',
        name: dev.name,
        hostname: dev.hostname || '',
        asset_tag: dev.asset_tag || '',
        vendor: dev.vendor || '',
        model: dev.model || '',
        serial_number: dev.serial_number || '',
        mgmt_ip: dev.mgmt_ip || '',
        bmc_ip: dev.bmc_ip || '',
        notes: dev.notes || '',
        owner: dev.owner || '',
      });
      setMoveErr(null);
      await fetchRack();
      onDeviceChange();
    } catch (err) {
      setMoveErr(err instanceof Error ? err.message : '移动失败');
    }
  };

  const renderSlotList = () => {
    if (!rack) return null;
    const totalU = rack.total_u || 42;
    const devices = rack.devices || [];

    // 建立 U 位查找表
    const uMap: { [u: number]: { device: Device; isStart: boolean } } = {};
    for (const d of devices) {
      for (let u = d.start_u; u < d.start_u + d.u_height; u++) {
        uMap[u] = { device: d, isStart: u === d.start_u };
      }
    }

    const rows = [];
    let u = totalU;
    while (u >= 1) {
      const entry = uMap[u];
      if (entry) {
        const dev = entry.device;
        const isHighlight = dev.id === highlightDeviceId || dev.id === selectedDevice?.id;
        // 渲染连续 U 位块
        const uHeight = dev.u_height;
        const blockTopU = u;
        const blockBottomU = dev.start_u;

        const dragging = dragU?.id === dev.id;

        rows.push(
          <div
            key={`u-${blockTopU}-${blockBottomU}`}
            onClick={() => {
              if (dragMovedRef.current) {
                dragMovedRef.current = false;
                return;
              }
              setSelectedDevice(dev);
            }}
            className={`relative flex items-center justify-between px-3 py-1.5 my-0.5 rounded cursor-pointer border transition-all ${
              isHighlight
                ? 'border-sky-400 bg-sky-950/70 shadow-lg ring-1 ring-sky-400'
                : 'border-slate-700 bg-slate-800/90 hover:bg-slate-700/80'
            } ${dragging ? (dragU!.valid ? 'ring-2 ring-emerald-400' : 'ring-2 ring-red-400') : ''}`}
            style={{
              minHeight: `${Math.max(uHeight * 28, 36)}px`,
              transform: dragging ? `translateY(${-dragU!.delta * U_STEP}px)` : undefined,
              zIndex: dragging ? 30 : undefined,
              position: 'relative',
              transition: 'none',
            }}
          >
            <div className="flex items-center gap-2">
              <div
                className={`font-mono text-xs font-bold w-16 shrink-0 flex items-center justify-center gap-0.5 bg-slate-900/80 px-1 py-0.5 rounded border border-slate-700 select-none ${
                  userRole === 'admin'
                    ? 'cursor-grab active:cursor-grabbing text-slate-200 hover:border-sky-500/70'
                    : 'text-slate-400'
                }`}
                title={userRole === 'admin' ? '按住左侧 U 标签上下拖动，可修改设备在机柜中的 U 位' : undefined}
                onPointerDown={(e) => onDevDragStart(e, dev)}
                onPointerMove={onDevDragMove}
                onPointerUp={onDevDragEnd}
                onPointerCancel={() => {
                  dragRef.current = null;
                  setDragU(null);
                }}
              >
                {userRole === 'admin' && <GripVertical className="w-3 h-3 text-slate-500" />}
                <span className={dragging ? 'text-emerald-300' : ''}>
                  {uHeight > 1 ? `U${blockBottomU}~${blockTopU}` : `U${blockTopU}`}
                </span>
              </div>
              {dragging && (
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${
                    dragU!.valid
                      ? 'text-emerald-300 border-emerald-500/50 bg-emerald-500/10'
                      : 'text-red-300 border-red-500/50 bg-red-500/10'
                  }`}
                >
                  {dragU!.valid
                    ? `→ U${dev.start_u + dragU!.delta}${uHeight > 1 ? `~U${dev.start_u + dragU!.delta + uHeight - 1}` : ''}`
                    : '位置冲突'}
                </span>
              )}
              <div className="flex items-center gap-1.5">
                {dev.type === 'server' && <Server className="w-4 h-4 text-sky-400" />}
                {dev.type === 'switch' && <Network className="w-4 h-4 text-emerald-400" />}
                {dev.type === 'storage' && <Database className="w-4 h-4 text-amber-400" />}
                {dev.type === 'other' && <Cpu className="w-4 h-4 text-purple-400" />}
                <div className="flex flex-col">
                  <span className="text-xs font-semibold text-slate-100 flex items-center gap-1.5">
                    {dev.name}
                    {dev.vendor && (
                      <span className="text-[10px] text-slate-400 font-normal">
                        ({dev.vendor} {dev.model})
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono">
                    {dev.mgmt_ip && <span>IP: {dev.mgmt_ip}</span>}
                    {dev.bmc_ip && <span>BMC: {dev.bmc_ip}</span>}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {dev.telemetry && (
                <>
                  <Chip
                    size="sm"
                    variant="flat"
                    color={
                      dev.telemetry.online_status === 'online'
                        ? 'success'
                        : dev.telemetry.online_status === 'offline'
                        ? 'danger'
                        : 'default'
                    }
                    className="text-[10px] h-5"
                  >
                    {dev.telemetry.online_status === 'online' ? '在线' : '离线/未知'}
                  </Chip>
                  {dev.telemetry.max_temp_c != null && (
                    <Chip
                      size="sm"
                      variant="flat"
                      color={dev.telemetry.max_temp_c >= 70 ? 'danger' : 'warning'}
                      className="text-[10px] h-5 font-mono"
                    >
                      {Math.round(dev.telemetry.max_temp_c)}°C
                    </Chip>
                  )}
                </>
              )}
            </div>
          </div>
        );

        u = blockBottomU - 1;
      } else {
        // 空位槽
        const slotU = u;
        rows.push(
          <div
            key={`empty-${slotU}`}
            className="flex items-center justify-between px-3 py-1 my-0.5 rounded border border-dashed border-slate-800/80 bg-slate-900/40 hover:bg-slate-850 group transition-colors"
          >
            <span className="font-mono text-xs text-slate-600 w-12 text-center">
              U{slotU}
            </span>
            <span className="text-xs text-slate-600 italic">空闲槽位</span>
            {userRole === 'admin' ? (
              <Button
                size="sm"
                variant="light"
                isIconOnly
                className="opacity-0 group-hover:opacity-100 text-sky-400 hover:bg-sky-500/20 h-6 w-6 min-w-6"
                onPress={() => {
                  setEditingDevice(null);
                  setPlacementStartU(slotU);
                  setPlacementOpen(true);
                }}
              >
                <Plus className="w-3.5 h-3.5" />
              </Button>
            ) : (
              <span className="w-6" />
            )}
          </div>
        );
        u--;
      }
    }
    if (moveErr) {
      rows.unshift(
        <div
          key="move-err"
          className="mb-2 px-3 py-1.5 rounded border border-red-500/50 bg-red-500/10 text-[11px] text-red-300"
        >
          {moveErr}
        </div>
      );
    }
    return rows;
  };

  return (
    <>
      <Drawer
        isOpen={isOpen}
        onClose={onClose}
        size="4xl"
        hideCloseButton
        classNames={{
          base: 'bg-slate-950 border-l border-slate-800 text-slate-100 max-w-full',
          header: 'border-b border-slate-800 bg-slate-900/60',
          body: 'p-0',
        }}
      >
        <DrawerContent>
          <DrawerHeader className="flex justify-between items-center py-3 pl-5 pr-4">
            <div className="flex items-center gap-3">
              <span className="text-lg font-bold text-sky-400 font-mono">
                {rack?.code}
              </span>
              <span className="text-sm font-semibold text-slate-200">
                {rack?.name}
              </span>
              <Chip size="sm" variant="bordered" className="text-xs border-slate-700">
                总容量 {rack?.total_u || 42}U
              </Chip>
            </div>
            <div className="flex items-center gap-2">
              {userRole === 'admin' && (
                <Button
                  size="sm"
                  color="primary"
                  startContent={<Plus className="w-4 h-4" />}
                  onPress={() => {
                    setEditingDevice(null);
                    setPlacementStartU(1);
                    setPlacementOpen(true);
                  }}
                >
                  添加设备
                </Button>
              )}
              <Button
                isIconOnly
                size="sm"
                variant="light"
                aria-label="关闭"
                className="text-slate-400 hover:text-slate-100 min-w-8 w-8 h-8"
                onPress={onClose}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </DrawerHeader>

          <DrawerBody className="flex flex-row h-full overflow-hidden">
            {/* 左侧：U 位标尺视图 / 机柜 3D 透视 */}
            <div className="w-7/12 border-r border-slate-800 p-4 overflow-y-auto">
              <div className="flex justify-between items-center mb-3">
                <Tabs
                  size="sm"
                  selectedKey={rackView}
                  onSelectionChange={(k) => setRackView(k as '2d' | '3d')}
                  variant="solid"
                  classNames={{
                    tabList: 'bg-slate-800 border border-slate-700',
                    cursor: 'bg-sky-600',
                  }}
                >
                  <Tab
                    key="2d"
                    title={
                      <div className="flex items-center gap-1 px-1">
                        <Layers className="w-3 h-3" />
                        <span className="text-xs">U位视图</span>
                      </div>
                    }
                  />
                  <Tab
                    key="3d"
                    title={
                      <div className="flex items-center gap-1 px-1">
                        <Box className="w-3 h-3" />
                        <span className="text-xs">3D透视</span>
                      </div>
                    }
                  />
                </Tabs>
                <span className="text-xs text-slate-500 font-mono">
                  已占用: {rack?.used_u || 0} / {rack?.total_u || 42} U
                </span>
              </div>
              {rackView === '3d' && rack ? (
                <Rack3DView
                  rack={rack}
                  selectedDeviceId={selectedDevice?.id ?? highlightDeviceId ?? null}
                  onSelectDevice={(d) => setSelectedDevice(d)}
                />
              ) : (
                <div className="space-y-0.5">{renderSlotList()}</div>
              )}
            </div>

            {/* 右侧：选中设备详情与控制台面板 */}
            <div className="w-5/12 p-4 overflow-y-auto bg-slate-900/30">
              {selectedDevice ? (
                <div className="space-y-4">
                  <div className="flex justify-between items-start border-b border-slate-800 pb-3">
                    <div>
                      <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                        {selectedDevice.name}
                      </h3>
                      <p className="text-xs text-slate-400 font-mono mt-0.5">
                        {selectedDevice.vendor} {selectedDevice.model}
                      </p>
                    </div>
                    {userRole === 'admin' && (
                      <div className="flex items-center gap-1">
                        <Tooltip content="编辑设备">
                          <Button
                            size="sm"
                            isIconOnly
                            variant="light"
                            className="text-slate-300"
                            onPress={() => {
                              setEditingDevice(selectedDevice);
                              setDeviceModalOpen(true);
                            }}
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </Button>
                        </Tooltip>
                        <Tooltip content="删除设备">
                          <Button
                            size="sm"
                            isIconOnly
                            variant="light"
                            className="text-red-400"
                            onPress={() => handleDeleteDevice(selectedDevice)}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </Tooltip>
                      </div>
                    )}
                  </div>

                  {/* 状态徽标与快捷刷新 */}
                  <div className="flex items-center justify-between p-2.5 rounded bg-slate-850 border border-slate-800">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          selectedDevice.telemetry?.online_status === 'online'
                            ? 'bg-emerald-400 ring-2 ring-emerald-500/20'
                            : 'bg-red-400'
                        }`}
                      />
                      <span className="text-xs font-medium">
                        {selectedDevice.telemetry?.online_status === 'online' ? '正常在线' : '离线 / 未响应'}
                      </span>
                    </div>
                    {userRole === 'admin' && (
                      <Button
                        size="sm"
                        variant="light"
                        className="text-xs text-sky-400 h-6 px-2"
                        startContent={<RefreshCw className="w-3 h-3" />}
                        onPress={() => handleCollectRefresh(selectedDevice)}
                      >
                        立即探测
                      </Button>
                    )}
                  </div>

                  {/* 硬件指标指标卡 */}
                  <div className="space-y-2 text-xs">
                    <span className="font-semibold text-slate-400 block text-[11px] uppercase tracking-wider">
                      实时遥测与硬件状态
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="p-2 rounded bg-slate-900 border border-slate-800">
                        <span className="text-[10px] text-slate-500 block">进风口/最高温度</span>
                        <span className="font-mono text-sm font-bold text-amber-400">
                          {selectedDevice.telemetry?.max_temp_c != null
                            ? `${Math.round(selectedDevice.telemetry.max_temp_c)}°C`
                            : '--'}
                        </span>
                      </div>
                      <div className="p-2 rounded bg-slate-900 border border-slate-800">
                        <span className="text-[10px] text-slate-500 block">磁盘健康与数量</span>
                        <span className="font-mono text-xs font-bold text-slate-200">
                          {selectedDevice.telemetry?.disk_count
                            ? `${selectedDevice.telemetry.disk_count} 块可用`
                            : '--'}
                        </span>
                      </div>
                      <div className="p-2 rounded bg-slate-900 border border-slate-800">
                        <span className="text-[10px] text-slate-500 block">CPU 规格</span>
                        <span className="text-xs text-slate-200 truncate block" title={selectedDevice.telemetry?.cpu_model}>
                          {selectedDevice.telemetry?.cpu_model || '--'}
                        </span>
                      </div>
                      <div className="p-2 rounded bg-slate-900 border border-slate-800">
                        <span className="text-[10px] text-slate-500 block">总内存</span>
                        <span className="font-mono text-xs font-bold text-slate-200">
                          {selectedDevice.telemetry?.memory_gb ? `${selectedDevice.telemetry.memory_gb} GB` : '--'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 控制台操作入口 */}
                  <div className="space-y-2 border-t border-slate-800 pt-3">
                    <span className="font-semibold text-slate-400 block text-[11px] uppercase tracking-wider">
                      远程交互控制台
                    </span>
                    <div className="grid grid-cols-1 gap-2">
                      {selectedDevice.mgmt_ip && (
                        <Button
                          size="sm"
                          variant="flat"
                          color="primary"
                          className="justify-start text-xs"
                          startContent={<Terminal className="w-3.5 h-3.5" />}
                          isDisabled={userRole !== 'admin'}
                          onPress={() => {
                            setTermType('webssh');
                            setTermDevice({
                              id: selectedDevice.id,
                              name: selectedDevice.name,
                              ip: selectedDevice.mgmt_ip,
                            });
                            setTermOpen(true);
                          }}
                        >
                          打开 WebSSH 终端 ({selectedDevice.mgmt_ip})
                        </Button>
                      )}

                      {selectedDevice.bmc_ip && (
                        <>
                          <Button
                            size="sm"
                            variant="flat"
                            color="secondary"
                            className="justify-start text-xs"
                            startContent={<Terminal className="w-3.5 h-3.5" />}
                            isDisabled={userRole !== 'admin'}
                            onPress={() => {
                              setTermType('ipmisol');
                              setTermDevice({
                                id: selectedDevice.id,
                                name: selectedDevice.name,
                                ip: selectedDevice.bmc_ip,
                              });
                              setTermOpen(true);
                            }}
                          >
                            打开 IPMI 串口终端 (SOL)
                          </Button>

                          <Button
                            size="sm"
                            variant="bordered"
                            className="justify-start text-xs border-slate-700 text-slate-200"
                            startContent={<ExternalLink className="w-3.5 h-3.5" />}
                            isDisabled={userRole !== 'admin'}
                            onPress={() => {
                              window.open(`/api/v1/console/bmc-proxy/${selectedDevice.id}/`, '_blank');
                            }}
                          >
                            原生 BMC / Web 控制台 (反代穿透)
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* 资产与网络详细信息 */}
                  <div className="space-y-1.5 text-xs border-t border-slate-800 pt-3 text-slate-400">
                    <div>
                      <span className="text-slate-500">位置：</span>
                      {rack?.name} ({rack?.code}) / U{selectedDevice.start_u}~U
                      {selectedDevice.start_u + selectedDevice.u_height - 1}
                    </div>
                    {selectedDevice.asset_tag && (
                      <div>
                        <span className="text-slate-500">资产号：</span>
                        <span className="font-mono">{selectedDevice.asset_tag}</span>
                      </div>
                    )}
                    {selectedDevice.serial_number && (
                      <div>
                        <span className="text-slate-500">序列号：</span>
                        <span className="font-mono">{selectedDevice.serial_number}</span>
                      </div>
                    )}
                    <div>
                      <span className="text-slate-500">使用人：</span>
                      <span>{selectedDevice.owner || '（未指定）'}</span>
                    </div>
                    {selectedDevice.notes && (
                      <div className="pt-1 text-[11px] text-slate-400 bg-slate-900 p-2 rounded border border-slate-800">
                        {selectedDevice.notes}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-slate-500 text-xs text-center py-12">
                  <Server className="w-8 h-8 mb-2 opacity-30" />
                  <span>点击左侧 U 位中的设备</span>
                  <span>即可查看实时硬件指标与打开 Web 控制台</span>
                </div>
              )}
            </div>
          </DrawerBody>
        </DrawerContent>
      </Drawer>

      {/* 设备位置选择（先选 U 数，再选位置） */}
      {rack && placementOpen && (
        <PlacementModal
          isOpen={placementOpen}
          rack={rack}
          initialStartU={placementStartU}
          onClose={() => setPlacementOpen(false)}
          onConfirm={(startU, uHeight) => {
            setPlacementOpen(false);
            setEditingDevice(null);
            setDeviceModalStartU(startU);
            setDeviceModalUHeight(uHeight);
            setDeviceModalOpen(true);
          }}
        />
      )}

      {/* 设备编辑/添加弹窗 */}
      {rack && deviceModalOpen && (
        <DeviceModal
          isOpen={deviceModalOpen}
          onClose={() => setDeviceModalOpen(false)}
          rackId={rack.id}
          rackCode={rack.code}
          totalU={rack.total_u || 42}
          initialStartU={deviceModalStartU}
          initialUHeight={deviceModalUHeight}
          editingDevice={editingDevice}
          onSave={async (payload) => {
            if (editingDevice) {
              await api.updateDevice(editingDevice.id, payload);
            } else {
              await api.createDevice(payload);
            }
            fetchRack();
            onDeviceChange();
          }}
        />
      )}

      {/* WebSSH / IPMI 弹窗 */}
      {termDevice && (
        <WebTerminalModal
          isOpen={termOpen}
          onClose={() => setTermOpen(false)}
          deviceId={termDevice.id}
          deviceName={termDevice.name}
          ip={termDevice.ip}
          type={termType}
        />
      )}
    </>
  );
}
