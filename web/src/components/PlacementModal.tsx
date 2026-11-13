import { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Chip,
  Input,
} from '@heroui/react';
import { ArrowDown, ArrowUp, Check, Grid2x2, ShieldAlert } from 'lucide-react';
import { Rack, Device } from '../types';

const CELL = 12;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  rack: Rack | null;
  initialStartU?: number;
  onConfirm: (startU: number, uHeight: number) => void;
}

function findOverlap(devices: Device[], start: number, height: number): Device | null {
  const end = start + height - 1;
  for (const d of devices) {
    const dStart = d.start_u;
    const dEnd = d.start_u + d.u_height - 1;
    if (start <= dEnd && end >= dStart) return d;
  }
  return null;
}

export function PlacementModal({ isOpen, onClose, rack, initialStartU, onConfirm }: Props) {
  const totalU = rack?.total_u || 42;
  const devices = rack?.devices || [];
  const [uHeight, setUHeight] = useState(1);
  const [startU, setStartU] = useState(1);

  const occupiedSet = useMemo(() => {
    const set: Record<number, Device> = {};
    for (const d of devices) {
      for (let u = d.start_u; u < d.start_u + d.u_height; u++) set[u] = d;
    }
    return set;
  }, [devices]);

  const clampStart = (value: number, height: number) => {
    const maxStart = Math.max(1, totalU - height + 1);
    return Math.max(1, Math.min(maxStart, value));
  };

  useEffect(() => {
    if (!isOpen) return;
    const h = Math.max(1, uHeight);
    setStartU(clampStart(initialStartU || 1, h));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialStartU, rack?.id]);

  useEffect(() => {
    setStartU((s) => clampStart(s, uHeight));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uHeight]);

  const overlap = findOverlap(devices, startU, uHeight);
  const valid = !overlap && startU >= 1 && startU + uHeight - 1 <= totalU;

  const heights = [1, 2, 4, 6, 8];

  const slots = [];
  for (let u = totalU; u >= 1; u--) {
    const occupied = occupiedSet[u];
    const inGhost = u >= startU && u < startU + uHeight;
    const ghostTop = inGhost && u === startU + uHeight - 1;
    const ghostBottom = inGhost && u === startU;
    slots.push(
      <div
        key={u}
        className={`relative flex items-center border-b border-slate-800/70 cursor-pointer transition-colors ${
          occupied
            ? 'bg-slate-800/70 cursor-not-allowed'
            : inGhost
            ? valid
              ? `bg-sky-500/25 border-x-2 border-sky-400 ${ghostTop ? 'border-t-2 rounded-t' : ''} ${ghostBottom ? 'border-b-2 rounded-b' : ''}`
              : `bg-red-500/25 border-x-2 border-red-400 ${ghostTop ? 'border-t-2 rounded-t' : ''} ${ghostBottom ? 'border-b-2 rounded-b' : ''}`
            : 'bg-slate-900/50 hover:bg-slate-800/60'
        }`}
        style={{ height: CELL }}
        onClick={() => {
          if (occupied) return;
          setStartU(clampStart(u, uHeight));
        }}
      >
        <span className="w-8 text-right pr-2 font-mono text-[9px] text-slate-500">{u}</span>
        {occupied ? (
          <span className="text-[9px] text-slate-400 truncate">
            {occupied.name} · {occupied.u_height}U
          </span>
        ) : inGhost ? (
          <span className="text-[9px] font-semibold text-sky-200">
            {u === startU + uHeight - 1 ? `U${startU}~U${startU + uHeight - 1}（待放置）` : ''}
          </span>
        ) : (
          <span className="text-[9px] text-slate-600">空闲</span>
        )}
      </div>
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      classNames={{ base: 'bg-slate-900 border border-slate-700 text-slate-100' }}
    >
      <ModalContent>
        <ModalHeader className="border-b border-slate-800 flex items-center gap-2">
          <Grid2x2 className="w-4 h-4 text-sky-400" />
          选择设备 U 数与安装位置
        </ModalHeader>
        <ModalBody className="py-4 space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-slate-400">占用高度：</span>
            {heights.map((h) => (
              <Button
                key={h}
                size="sm"
                variant={uHeight === h ? 'solid' : 'bordered'}
                color={uHeight === h ? 'primary' : 'default'}
                className={`text-xs h-7 min-w-12 ${uHeight === h ? '' : 'border-slate-600 text-slate-300'}`}
                onPress={() => setUHeight(h)}
              >
                {h}U
              </Button>
            ))}
            <div className="w-24">
              <Input
                size="sm"
                type="number"
                value={String(uHeight)}
                onChange={(e) => setUHeight(Math.max(1, Math.min(totalU, parseInt(e.target.value) || 1)))}
                classNames={{ inputWrapper: 'bg-slate-800 border-slate-700 h-7 min-h-7' }}
              />
            </div>
            <span className="text-[11px] text-slate-500">机柜共 {totalU}U</span>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-48 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950">
              <div className="flex flex-col" style={{ direction: 'ltr' }}>
                {devices.length === 0 && (
                  <div className="text-center py-2 text-[10px] text-slate-500">机柜为空，点击任意 U 位放置</div>
                )}
                {slots}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Button
                size="sm"
                isIconOnly
                variant="flat"
                className="text-slate-300 bg-slate-800"
                onPress={() => setStartU((s) => clampStart(s + 1, uHeight))}
                title="上移"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </Button>
              <Button
                size="sm"
                isIconOnly
                variant="flat"
                className="text-slate-300 bg-slate-800"
                onPress={() => setStartU((s) => clampStart(s - 1, uHeight))}
                title="下移"
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className={`font-mono font-semibold ${valid ? 'text-sky-300' : 'text-red-300'}`}>
              将占用 U{startU} ~ U{startU + uHeight - 1}（{uHeight}U）
            </span>
            {overlap && (
              <Chip size="sm" color="danger" variant="flat" startContent={<ShieldAlert className="w-3 h-3" />} className="text-[10px]">
                与 {overlap.name} 重叠
              </Chip>
            )}
          </div>
        </ModalBody>
        <ModalFooter className="border-t border-slate-800">
          <Button variant="flat" size="sm" onPress={onClose}>取消</Button>
          <Button
            color="primary"
            size="sm"
            startContent={<Check className="w-4 h-4" />}
            isDisabled={!valid}
            onPress={() => {
              if (valid) onConfirm(startU, uHeight);
            }}
          >
            确认位置，填写设备信息
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
