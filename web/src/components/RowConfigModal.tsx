import React, { useState } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Select,
  SelectItem,
} from '@heroui/react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  nextSortOrder: number;
  onCreate?: (data: {
    name: string;
    prefix: string;
    rack_count: number;
    default_u_height: number;
    aisle_direction: string;
    sort_order: number;
  }) => Promise<void> | void;
}

export function RowConfigModal({ isOpen, onClose, onSuccess, nextSortOrder, onCreate }: Props) {
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [rackCount, setRackCount] = useState(6);
  const [defaultU, setDefaultU] = useState(42);
  const [aisleDirection, setAisleDirection] = useState('cold');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('请输入行排名称（如：C排）');
      return;
    }
    const pfx = prefix.trim() || name.trim().replace(/排|行/g, '').toUpperCase();
    if (!pfx) {
      setError('请输入机柜编号前缀');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const payload = {
        name: name.trim(),
        prefix: pfx,
        sort_order: nextSortOrder,
        rack_count: rackCount,
        default_u_height: defaultU,
        aisle_direction: aisleDirection,
      };
      if (onCreate) {
        await onCreate(payload);
      } else {
        const { api } = await import('../api/client');
        await api.createRow(payload);
      }
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || '创建失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" classNames={{ base: 'bg-slate-900 border border-slate-700 text-slate-100' }}>
      <ModalContent>
        <ModalHeader className="border-b border-slate-800">新增机房排（Row）</ModalHeader>
        <ModalBody className="py-4 space-y-3">
          {error && (
            <div className="p-2 text-xs rounded bg-red-950/80 border border-red-700 text-red-200">
              {error}
            </div>
          )}
          <Input
            label="排名称"
            placeholder="如: C排"
            size="sm"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!prefix) {
                setPrefix(e.target.value.replace(/排|行/g, '').toUpperCase());
              }
            }}
            classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
            isRequired
          />
          <Input
            label="机柜编号前缀"
            placeholder="如: C (生成 C01, C02...)"
            size="sm"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
            isRequired
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="机柜数量"
              type="number"
              size="sm"
              value={rackCount.toString()}
              onChange={(e) => setRackCount(parseInt(e.target.value) || 1)}
              classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
            />
            <Input
              label="默认机柜 U 数"
              type="number"
              size="sm"
              value={defaultU.toString()}
              onChange={(e) => setDefaultU(parseInt(e.target.value) || 42)}
              classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
            />
          </div>
          <Select
            label="通道朝向"
            size="sm"
            selectedKeys={[aisleDirection]}
            onChange={(e) => setAisleDirection(e.target.value)}
            classNames={{ trigger: 'bg-slate-800 border-slate-700' }}
          >
            <SelectItem key="cold">冷通道封闭面对 (Cold Aisle)</SelectItem>
            <SelectItem key="hot">热通道面对 (Hot Aisle)</SelectItem>
          </Select>
        </ModalBody>
        <ModalFooter className="border-t border-slate-800">
          <Button variant="flat" onPress={onClose} isDisabled={loading}>取消</Button>
          <Button color="primary" onPress={handleSubmit} isLoading={loading}>创建并生成机柜</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
