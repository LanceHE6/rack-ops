import { Button, Chip } from '@heroui/react';
import {
  ArrowLeft,
  Plus,
  Server,
  Network,
  Database,
  Cpu,
  Thermometer,
  ChevronRight,
} from 'lucide-react';
import { RoomRow, Rack, Device, Role } from '../types';
import { api } from '../api/client';

const CELL = 11; // 每 U 像素高度
const RAIL_W = 26; // 左侧 U 编号轨宽

interface Props {
  row: RoomRow;
  userRole: Role;
  highlightRackId?: number | null;
  onBack: () => void;
  onOpenRack: (rack: Rack, deviceId?: number) => void;
  onRefresh: () => Promise<void> | void;
  onToast: (message: string, undo?: () => Promise<void>) => void;
}

const TYPE_STYLE: Record<string, { bg: string; border: string; icon: typeof Server }> = {
  server: { bg: 'linear-gradient(135deg, #0284c7 0%, #1d4ed8 100%)', border: 'rgba(125, 211, 252, 0.5)', icon: Server },
  switch: { bg: 'linear-gradient(135deg, #059669 0%, #047857 100%)', border: 'rgba(110, 231, 183, 0.5)', icon: Network },
  storage: { bg: 'linear-gradient(135deg, #d97706 0%, #b45309 100%)', border: 'rgba(252, 211, 77, 0.5)', icon: Database },
  other: { bg: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)', border: 'rgba(196, 181, 253, 0.5)', icon: Cpu },
};

function DeviceCell({ dev, onOpen }: { dev: Device; onOpen: (d: Device) => void }) {
  const style = TYPE_STYLE[dev.type] || TYPE_STYLE.other;
  const Icon = style.icon;
  const offline = dev.telemetry?.online_status === 'offline';
  const critical = dev.telemetry?.health_status === 'critical';
  const warning = dev.telemetry?.health_status === 'warning';
  const ledColor = offline || critical ? '#f87171' : warning ? '#fbbf24' : '#4ade80';
  const h = dev.u_height * CELL - 2;

  return (
    <div
      data-device={dev.id}
      data-device-u={dev.start_u}
      className="absolute rounded-[4px] border cursor-pointer overflow-hidden transition-transform hover:brightness-125 hover:scale-[1.015]"
      style={{
        left: RAIL_W + 3,
        right: 6,
        bottom: (dev.start_u - 1) * CELL + 1,
        height: h,
        background: style.bg,
        borderColor: style.border,
        filter: offline ? 'saturate(0.35) brightness(0.75)' : undefined,
        boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
      }}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(dev);
      }}
      title={`${dev.name} · U${dev.start_u}~U${dev.start_u + dev.u_height - 1} · ${dev.vendor} ${dev.model}`}
    >
      <div className="flex items-center h-full px-1.5 gap-1">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${critical ? 'led-critical' : ''}`}
          style={{ background: ledColor, boxShadow: `0 0 5px ${ledColor}` }}
        />
        {h >= 20 && <Icon className="w-3 h-3 text-white/80 shrink-0" />}
        <span className="text-[9px] font-semibold text-white truncate leading-none">{dev.name}</span>
        {h >= 20 && dev.telemetry?.max_temp_c != null && dev.telemetry.max_temp_c > 0 && (
          <span className={`ml-auto text-[8px] font-mono shrink-0 ${dev.telemetry.max_temp_c >= 70 ? 'text-red-200' : 'text-white/70'}`}>
            {Math.round(dev.telemetry.max_temp_c)}°
          </span>
        )}
      </div>
      {/* 设备面板散热孔纹理 */}
      <div
        className="absolute inset-0 pointer-events-none opacity-20"
        style={{
          backgroundImage: 'repeating-linear-gradient(90deg, transparent 0 3px, rgba(0,0,0,0.5) 3px 4px)',
        }}
      />
    </div>
  );
}

function RackElevationCard({
  rack,
  highlight,
  onOpen,
}: {
  rack: Rack;
  highlight: boolean;
  onOpen: (rack: Rack, deviceId?: number) => void;
}) {
  const totalU = rack.total_u || 42;
  const devices = rack.devices || [];
  const used = rack.used_u || 0;
  const servers = devices.filter((d) => d.type === 'server').length;
  const switches = devices.filter((d) => d.type === 'switch').length;
  const storage = devices.filter((d) => d.type === 'storage').length;

  const uLabels = [];
  for (let u = totalU; u >= 1; u -= 6) {
    uLabels.push(
      <span
        key={u}
        className="absolute left-0 w-[22px] text-right text-[8px] font-mono text-slate-500 leading-none"
        style={{ bottom: (u - 1) * CELL + CELL / 2 - 4 }}
      >
        {u}
      </span>
    );
  }

  return (
    <div
      data-rack={rack.code}
      data-rack-id={rack.id}
      className={`shrink-0 w-[248px] rounded-xl border bg-slate-900/80 overflow-hidden transition-all hover:-translate-y-1 hover:shadow-xl hover:shadow-sky-950/50 cursor-pointer ${
        highlight ? 'border-sky-400 rack-highlight' : 'border-slate-700/80 hover:border-sky-500/60'
      }`}
      onClick={() => onOpen(rack)}
    >
      {/* 卡片头 */}
      <div className="px-3 py-2.5 border-b border-slate-800 bg-gradient-to-r from-slate-800/80 to-slate-900/40">
        <div className="flex items-center justify-between">
          <span className="font-mono text-base font-bold text-sky-300">{rack.code}</span>
          <div className="flex items-center gap-1.5">
            {rack.max_temp != null && (
              <span className="flex items-center gap-0.5 text-[10px] font-mono text-amber-300">
                <Thermometer className="w-3 h-3" />
                {Math.round(rack.max_temp)}°C
              </span>
            )}
            <span
              className={`w-2 h-2 rounded-full ${rack.health_state === 'critical' ? 'led-critical' : ''}`}
              style={{
                background: rack.health_state === 'critical' ? '#f87171' : rack.health_state === 'warning' ? '#fbbf24' : '#34d399',
              }}
            />
          </div>
        </div>
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-[11px] text-slate-400 truncate">{rack.name}</span>
          <span className="text-[10px] font-mono text-slate-500">{used}/{totalU}U</span>
        </div>
      </div>

      {/* U 位格子区：设备按真实 U 位相对位置渲染 */}
      <div className="relative mx-3 my-2" style={{ height: totalU * CELL }}>
        {/* 背景网格（每 U 一格） */}
        <div
          className="absolute inset-0 rounded border border-slate-700/60"
          style={{
            background: '#0a0f1c',
            backgroundImage: `repeating-linear-gradient(0deg, transparent 0 ${CELL - 1}px, rgba(71, 85, 105, 0.35) ${CELL - 1}px ${CELL}px)`,
          }}
        />
        {uLabels}
        {/* 空闲格提示（底层） */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          {devices.length === 0 && (
            <span className="text-[10px] text-slate-600 italic">空机柜 · 点击添加设备</span>
          )}
        </div>
        {devices.map((dev) => (
          <DeviceCell key={dev.id} dev={dev} onOpen={(d) => onOpen(rack, d.id)} />
        ))}
      </div>

      {/* 卡片脚 */}
      <div className="px-3 py-2 border-t border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[10px] text-slate-400">
          {servers > 0 && <span className="flex items-center gap-0.5"><Server className="w-3 h-3 text-sky-400" />{servers}</span>}
          {switches > 0 && <span className="flex items-center gap-0.5"><Network className="w-3 h-3 text-emerald-400" />{switches}</span>}
          {storage > 0 && <span className="flex items-center gap-0.5"><Database className="w-3 h-3 text-amber-400" />{storage}</span>}
          {devices.length === 0 && <span className="text-slate-600">无设备</span>}
        </div>
        <span className="flex items-center gap-0.5 text-[10px] text-sky-400 font-medium">
          进入机柜 <ChevronRight className="w-3 h-3" />
        </span>
      </div>
    </div>
  );
}

export function RowView({ row, userRole, highlightRackId, onBack, onOpenRack, onRefresh, onToast }: Props) {
  const racks = row.racks || [];
  const allDevices = racks.flatMap((r) => r.devices || []);
  const alerts = allDevices.filter(
    (d) => d.telemetry?.health_status === 'critical' || d.telemetry?.health_status === 'warning'
  ).length;

  const addRack = async () => {
    try {
      const rk = await api.createRackInRow(row.id);
      onToast(`已添加机柜 ${rk.code}`);
      await onRefresh();
    } catch (err: any) {
      onToast(`添加机柜失败: ${err.message}`);
    }
  };

  return (
    <div className="flex flex-col h-full view-in">
      {/* 机排视角头部 */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-slate-900/50">
        <div className="flex items-center gap-3">
          <Button size="sm" variant="flat" className="text-xs text-slate-300" startContent={<ArrowLeft className="w-3.5 h-3.5" />} onPress={onBack}>
            机房总览
          </Button>
          <span className="text-slate-600">/</span>
          <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded bg-sky-500" />
            {row.name}
            <span className="text-xs font-normal text-slate-500">机排视角 · 设备按真实 U 位显示</span>
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <Chip size="sm" variant="flat" className="text-[11px] bg-slate-800 text-slate-300">{racks.length} 个机柜</Chip>
          <Chip size="sm" variant="flat" className="text-[11px] bg-slate-800 text-slate-300">{allDevices.length} 台设备</Chip>
          {alerts > 0 && (
            <Chip size="sm" variant="flat" color="warning" className="text-[11px]">{alerts} 条告警</Chip>
          )}
          {userRole === 'admin' && (
            <Button size="sm" color="primary" variant="flat" className="text-xs" startContent={<Plus className="w-3.5 h-3.5" />} onPress={addRack}>
              添加机柜
            </Button>
          )}
        </div>
      </div>

      {/* 机柜卡片横向阵列 */}
      <div className="flex-1 overflow-x-auto overflow-y-auto">
        <div className="flex gap-5 p-6 min-w-max items-start">
          {racks.map((rack) => (
            <RackElevationCard
              key={rack.id}
              rack={rack}
              highlight={rack.id === highlightRackId}
              onOpen={onOpenRack}
            />
          ))}
          {racks.length === 0 && (
            <div className="text-sm text-slate-500 py-12">该机排暂无机柜{userRole === 'admin' ? '，点击右上角「添加机柜」开始部署' : ''}</div>
          )}
        </div>
      </div>
    </div>
  );
}
