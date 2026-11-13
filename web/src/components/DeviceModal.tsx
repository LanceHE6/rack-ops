import React, { useState, useEffect } from 'react';
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
  Textarea,
  Tabs,
  Tab,
  Autocomplete,
  AutocompleteItem,
} from '@heroui/react';
import { Device, DeviceType } from '../types';
import { Grid2x2 } from 'lucide-react';

// 按设备类型给出品牌候选，型号候选再按品牌过滤；两者都允许手动输入
const BRANDS_BY_TYPE: Record<DeviceType, string[]> = {
  server: ['浪潮', '超聚变', '宁畅', '中科可控（海光）', '华为', '联想', '戴尔', 'H3C'],
  switch: ['华三 H3C', '盛科 Centec', '博科 Brocade', '华为', '思科 Cisco', '锐捷 Ruijie'],
  storage: ['宏杉 MacrosSAN', '华为', '浪潮', 'NetApp', 'Dell EMC'],
  other: ['动环监控', 'KVM', 'PDU', '其他'],
};

const MODELS_BY_BRAND: Record<string, string[]> = {
  浪潮: ['NF5280M5', 'NF5280M6', 'NF5180M6', 'NF8480M6', 'NF5270M5'],
  超聚变: ['FusionServer 2288H V5', 'FusionServer 2288H V6', 'FusionServer 1288H V6'],
  宁畅: ['R620 G40', 'R420 G40', 'X620 G40'],
  '中科可控（海光）': ['海光 C86 2 代平台', '海光 C86 3 代平台', '海光 C86 4 代平台'],
  '华三 H3C': ['S6800-54QT', 'S5560-30C-EI', 'S6520X-30HC'],
  '盛科 Centec': ['CTC7132 (V580)', 'CTC8164'],
  '博科 Brocade': ['G620', '6505'],
  '宏杉 MacrosSAN': ['MS5000G2', 'MS2000G2', 'MS7000G2'],
};

// 采集器依赖 sub_brand 选择解析规则，这里由品牌+型号自动推断
function inferSubBrand(vendor: string, model: string, type: DeviceType): string {
  const v = (vendor || '').toLowerCase();
  const m = (model || '').toLowerCase();
  if (v.includes('浪潮')) return m.includes('m6') ? 'inspur_m6' : m.includes('m5') ? 'inspur_m5' : 'inspur_m6';
  if (v.includes('超聚变') || v.includes('xfusion')) return 'xfusion';
  if (v.includes('宁畅') || v.includes('netrix')) return 'netrix';
  if (v.includes('可控') || v.includes('海光') || v.includes('hygon')) return 'hygon';
  if (v.includes('宏杉') || v.includes('macrosan')) return 'san';
  if (v.includes('华三') || v.includes('h3c')) return 'h3c';
  if (v.includes('盛科') || v.includes('centec')) return 'centec';
  if (v.includes('博科') || v.includes('brodade') || v.includes('brocade')) return 'brocade';
  if (type === 'storage') return 'san';
  return 'other';
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  rackId: number;
  rackCode: string;
  totalU: number;
  initialStartU?: number;
  initialUHeight?: number;
  editingDevice?: Device | null;
  onSave: (payload: any) => Promise<void>;
}

export function DeviceModal({
  isOpen,
  onClose,
  rackId,
  rackCode,
  totalU,
  initialStartU,
  initialUHeight,
  editingDevice,
  onSave,
}: Props) {
  const [activeTab, setActiveTab] = useState<string>('basic');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // 基础字段
  const [startU, setStartU] = useState<number>(1);
  const [uHeight, setUHeight] = useState<number>(1);
  const [type, setType] = useState<DeviceType | ''>('');
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState('');
  const [assetTag, setAssetTag] = useState('');
  const [vendor, setVendor] = useState('');
  const [model, setModel] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [mgmtIP, setMgmtIP] = useState('');
  const [bmcIP, setBmcIP] = useState('');
  const [notes, setNotes] = useState('');
  const [owner, setOwner] = useState('');

  // 凭据字段
  const [bmcProtocol, setBmcProtocol] = useState('redfish');
  const [bmcPort, setBmcPort] = useState(443);
  const [bmcUser, setBmcUser] = useState('admin');
  const [bmcPassword, setBmcPassword] = useState('');
  const [sshPort, setSshPort] = useState(22);
  const [sshUser, setSshUser] = useState('root');
  const [sshAuthType, setSshAuthType] = useState('password');
  const [sshSecret, setSshSecret] = useState('');

  useEffect(() => {
    if (editingDevice) {
      setStartU(editingDevice.start_u);
      setUHeight(editingDevice.u_height);
      setType(editingDevice.type);
      setName(editingDevice.name);
      setHostname(editingDevice.hostname || '');
      setAssetTag(editingDevice.asset_tag || '');
      setVendor(editingDevice.vendor || '');
      setModel(editingDevice.model || '');
      setSerialNumber(editingDevice.serial_number || '');
      setMgmtIP(editingDevice.mgmt_ip || '');
      setBmcIP(editingDevice.bmc_ip || '');
      setNotes(editingDevice.notes || '');
      setOwner(editingDevice.owner || '');

      if (editingDevice.credential) {
        setBmcProtocol(editingDevice.credential.bmc_protocol || 'redfish');
        setBmcPort(editingDevice.credential.bmc_port || 443);
        setBmcUser(editingDevice.credential.bmc_user || '');
        setSshPort(editingDevice.credential.ssh_port || 22);
        setSshUser(editingDevice.credential.ssh_user || 'root');
        setSshAuthType(editingDevice.credential.ssh_auth_type || 'password');
      }
      setBmcPassword('');
      setSshSecret('');
    } else {
      setStartU(initialStartU || 1);
      setUHeight(initialUHeight && initialUHeight > 0 ? initialUHeight : 1);
      setType('');
      setName('');
      setHostname('');
      setAssetTag('');
      setVendor('');
      setModel('');
      setSerialNumber('');
      setMgmtIP('');
      setBmcIP('');
      setNotes('');
      setOwner('');
      setBmcProtocol('redfish');
      setBmcPort(443);
      setBmcUser('');
      setSshPort(22);
      setSshUser('');
      setSshAuthType('password');
      setBmcPassword('');
      setSshSecret('');
    }
    setError('');
    setActiveTab('basic');
  }, [editingDevice, initialStartU, initialUHeight, isOpen]);

  const brandOptions = (type ? BRANDS_BY_TYPE[type] : []).map((b) => ({ key: b, name: b }));
  const modelOptions = modelForBrand(vendor).map((m) => ({ key: m, name: m }));

  function modelForBrand(b: string): string[] {
    const direct = MODELS_BY_BRAND[b];
    if (direct) return direct;
    // 模糊匹配：品牌输入里带品牌关键字
    const key = Object.keys(MODELS_BY_BRAND).find((k) => b && (b.includes(k) || k.includes(b)));
    return key ? MODELS_BY_BRAND[key] : [];
  }

  const handleTypeChange = (val: string) => {
    if (!val) {
      setType('');
      return;
    }
    if (val !== type) {
      setType(val as DeviceType);
    }
  };

  const handleSubmit = async () => {
    if (!type) {
      setError('请先选择设备类型');
      return;
    }
    if (!name.trim()) {
      setError('请输入设备名称');
      return;
    }
    if (startU < 1 || startU + uHeight - 1 > totalU) {
      setError(`起始 U 位 + 高度超出机柜有效范围 (1 ~ ${totalU}U)`);
      return;
    }

    setLoading(true);
    setError('');
    try {
      await onSave({
        rack_id: rackId,
        start_u: startU,
        u_height: uHeight,
        type,
        sub_brand: inferSubBrand(vendor.trim(), model.trim(), type),
        name: name.trim(),
        hostname: hostname.trim(),
        asset_tag: assetTag.trim(),
        vendor: vendor.trim(),
        model: model.trim(),
        serial_number: serialNumber.trim(),
        mgmt_ip: mgmtIP.trim(),
        bmc_ip: bmcIP.trim(),
        notes: notes.trim(),
        owner: owner.trim(),
        credential: {
          bmc_protocol: bmcProtocol,
          bmc_port: bmcPort,
          bmc_user: bmcUser.trim(),
          bmc_password: bmcPassword,
          ssh_port: sshPort,
          ssh_user: sshUser.trim(),
          ssh_auth_type: sshAuthType,
          ssh_secret: sshSecret,
        },
      });
      onClose();
    } catch (err: any) {
      setError(err.message || '保存失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="2xl"
      classNames={{
        base: 'bg-slate-900 border border-slate-700 text-slate-100',
        header: 'border-b border-slate-800',
        footer: 'border-t border-slate-800',
      }}
    >
      <ModalContent>
        <ModalHeader>
          <div className="flex flex-col">
            <span className="text-lg font-bold">
              {editingDevice ? `编辑设备: ${editingDevice.name}` : `在 ${rackCode} 机柜新增设备`}
            </span>
            <span className="text-xs text-slate-400 font-normal">
              机柜空间: 总 {totalU}U 位
            </span>
          </div>
        </ModalHeader>
        <ModalBody className="py-4">
          {error && (
            <div className="mb-3 px-3 py-2 text-xs rounded bg-red-950/80 border border-red-700 text-red-200">
              {error}
            </div>
          )}

          <Tabs
            selectedKey={activeTab}
            onSelectionChange={(k) => setActiveTab(k as string)}
            color="primary"
            variant="underlined"
            classNames={{
              tabList: 'border-b border-slate-800 pb-0 gap-6',
              tab: 'text-sm data-[selected=true]:text-sky-400',
            }}
          >
            <Tab key="basic" title="基础与空间信息">
              <div className="grid grid-cols-2 gap-4 mt-3">
                <Select
                  label="设备类型"
                  size="sm"
                  isRequired
                  placeholder="请选择设备类型"
                  selectedKeys={type ? [type] : []}
                  onChange={(e) => handleTypeChange(e.target.value)}
                  classNames={{ trigger: 'bg-slate-800 border-slate-700' }}
                >
                  <SelectItem key="server">服务器 (Server)</SelectItem>
                  <SelectItem key="switch">交换机 (Switch)</SelectItem>
                  <SelectItem key="storage">存储设备 (Storage)</SelectItem>
                  <SelectItem key="other">其他网络/辅助设备</SelectItem>
                </Select>

                <Autocomplete
                  label="厂商 / 品牌"
                  size="sm"
                  allowsCustomValue
                  items={brandOptions}
                  inputValue={vendor}
                  onInputChange={setVendor}
                  isDisabled={!type}
                  placeholder={type ? '选择或手动输入品牌' : '请先选择设备类型'}
                  classNames={{ base: 'bg-slate-800/70 rounded-medium' }}
                >
                  {(item) => {
                    const it = item as { key: string; name: string };
                    return <AutocompleteItem key={it.key}>{it.name}</AutocompleteItem>;
                  }}
                </Autocomplete>

                <div className="col-span-2">
                  <Autocomplete
                    label="型号 (Model)"
                    size="sm"
                    allowsCustomValue
                    items={modelOptions}
                    inputValue={model}
                    onInputChange={setModel}
                    placeholder={modelOptions.length ? '选择或手动输入型号' : '手动输入型号'}
                    classNames={{ base: 'bg-slate-800/70 rounded-medium' }}
                  >
                    {(item) => {
                      const it = item as { key: string; name: string };
                      return <AutocompleteItem key={it.key}>{it.name}</AutocompleteItem>;
                    }}
                  </Autocomplete>
                </div>

                {editingDevice ? (
                  <>
                    <Input
                      label="起始 U 位 (从下往上 1 起)"
                      type="number"
                      size="sm"
                      value={startU.toString()}
                      onChange={(e) => setStartU(parseInt(e.target.value) || 1)}
                      classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                    />

                    <Input
                      label="占用 U 高度"
                      type="number"
                      size="sm"
                      value={uHeight.toString()}
                      onChange={(e) => setUHeight(parseInt(e.target.value) || 1)}
                      classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                    />
                  </>
                ) : (
                  <div className="col-span-2 flex items-center gap-2 px-3 py-2 rounded-lg border border-sky-500/30 bg-sky-500/5 text-xs">
                    <Grid2x2 className="w-4 h-4 text-sky-400" />
                    <span className="text-slate-300">已选安装位置：</span>
                    <span className="font-mono font-semibold text-sky-300">
                      U{startU} ~ U{startU + uHeight - 1}（{uHeight}U）
                    </span>
                    <span className="text-[10px] text-slate-500">位置已在选择步骤确定，如需调整请重新点击「添加设备」</span>
                  </div>
                )}

                <Input
                  label="设备名称"
                  placeholder="如: App-Server-01"
                  size="sm"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                  isRequired
                />

                <Input
                  label="主机名 (Hostname)"
                  placeholder="如: k8s-worker-01"
                  size="sm"
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                />

                <Input
                  label="资产编号 (Asset Tag)"
                  size="sm"
                  value={assetTag}
                  onChange={(e) => setAssetTag(e.target.value)}
                  classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                />

                <Input
                  label="序列号 (SN)"
                  size="sm"
                  value={serialNumber}
                  onChange={(e) => setSerialNumber(e.target.value)}
                  classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                />

                <Input
                  label="使用人 (Owner)"
                  placeholder="默认为空，可填写负责人"
                  size="sm"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                />
              </div>

              <div className="mt-3">
                <Textarea
                  label="备注信息"
                  size="sm"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                  rows={2}
                />
              </div>
            </Tab>

            <Tab key="network" title="网络与带外管理配置">
              <div className="space-y-4 mt-3">
                <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/50">
                  <span className="text-xs font-semibold text-sky-400 block mb-2">
                    业务 / 管理口 SSH 通道
                  </span>
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      label="管理口 IP"
                      placeholder="192.168.1.100"
                      size="sm"
                      value={mgmtIP}
                      onChange={(e) => setMgmtIP(e.target.value)}
                      classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                    />
                    <Input
                      label="SSH 端口"
                      type="number"
                      size="sm"
                      value={sshPort.toString()}
                      onChange={(e) => setSshPort(parseInt(e.target.value) || 22)}
                      classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                    />
                    <Input
                      label="SSH 用户名"
                      size="sm"
                      value={sshUser}
                      onChange={(e) => setSshUser(e.target.value)}
                      classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                    />
                    <Input
                      label="SSH 密码 / 私钥"
                      type="password"
                      placeholder={editingDevice ? '留空则保持原密码' : '输入密码'}
                      size="sm"
                      value={sshSecret}
                      onChange={(e) => setSshSecret(e.target.value)}
                      classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                    />
                  </div>
                </div>

                <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/50">
                  <span className="text-xs font-semibold text-amber-400 block mb-2">
                    BMC / IPMI 带外管理通道
                  </span>
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    <Input
                      label="BMC / IPMI IP"
                      placeholder="172.16.1.100"
                      size="sm"
                      value={bmcIP}
                      onChange={(e) => setBmcIP(e.target.value)}
                      classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                    />
                    <Select
                      label="协议"
                      size="sm"
                      selectedKeys={[bmcProtocol]}
                      onChange={(e) => setBmcProtocol(e.target.value)}
                      classNames={{ trigger: 'bg-slate-800 border-slate-700' }}
                    >
                      <SelectItem key="redfish">Redfish (HTTPS)</SelectItem>
                      <SelectItem key="ipmi">IPMI 2.0 (RMCP+)</SelectItem>
                    </Select>
                    <Input
                      label="BMC 端口"
                      type="number"
                      size="sm"
                      value={bmcPort.toString()}
                      onChange={(e) => setBmcPort(parseInt(e.target.value) || 443)}
                      classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      label="BMC 用户名"
                      size="sm"
                      value={bmcUser}
                      onChange={(e) => setBmcUser(e.target.value)}
                      classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                    />
                    <Input
                      label="BMC 密码"
                      type="password"
                      placeholder={editingDevice ? '留空则保持原密码' : '输入 BMC 密码'}
                      size="sm"
                      value={bmcPassword}
                      onChange={(e) => setBmcPassword(e.target.value)}
                      classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
                    />
                  </div>
                </div>
              </div>
            </Tab>
          </Tabs>
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose} isDisabled={loading}>
            取消
          </Button>
          <Button color="primary" onPress={handleSubmit} isLoading={loading}>
            {editingDevice ? '保存更改' : '确认添加'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
