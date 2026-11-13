import React, { useState, useEffect } from 'react';
import {
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  Chip,
  Pagination,
  Button,
} from '@heroui/react';
import { RefreshCw, ShieldAlert, History } from 'lucide-react';
import { AuditLog } from '../types';
import { api } from '../api/client';

export function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const limit = 20;

  const fetchLogs = async (p = 1) => {
    setLoading(true);
    try {
      const data = await api.getAuditLogs(limit, (p - 1) * limit);
      setLogs(data.items || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs(page);
  }, [page]);

  const getActionColor = (action: string) => {
    if (action.includes('delete')) return 'danger';
    if (action.includes('create') || action.includes('connect')) return 'primary';
    if (action.includes('update')) return 'warning';
    return 'default';
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <History className="w-5 h-5 text-sky-400" />
            操作与运维审计日志
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            记录机房拓扑编辑、设备增删改、WebSSH / IPMI 控制台会话与采集动作
          </p>
        </div>
        <Button
          size="sm"
          variant="flat"
          className="text-xs"
          startContent={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />}
          onPress={() => fetchLogs(page)}
        >
          刷新
        </Button>
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden p-2">
        <Table
          aria-label="Audit Logs Table"
          classNames={{
            base: 'min-w-full',
            table: 'min-w-full',
            th: 'bg-slate-800/80 text-slate-300 text-xs font-semibold',
            td: 'text-xs text-slate-200 border-b border-slate-800/50 py-3',
          }}
        >
          <TableHeader>
            <TableColumn>时间</TableColumn>
            <TableColumn>操作人</TableColumn>
            <TableColumn>操作行为</TableColumn>
            <TableColumn>目标对象</TableColumn>
            <TableColumn>客户端 IP</TableColumn>
            <TableColumn>状态</TableColumn>
            <TableColumn>变更明细</TableColumn>
          </TableHeader>
          <TableBody emptyContent="暂无审计记录" items={logs}>
            {(item) => (
              <TableRow key={item.id}>
                <TableCell className="font-mono text-slate-400">
                  {new Date(item.created_at).toLocaleString()}
                </TableCell>
                <TableCell>
                  <span className="font-semibold">{item.username}</span>
                  <span className="text-[10px] text-slate-400 ml-1">({item.role})</span>
                </TableCell>
                <TableCell>
                  <Chip size="sm" variant="flat" color={getActionColor(item.action)} className="text-[11px] h-5">
                    {item.action}
                  </Chip>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-slate-300">
                    {item.target_type}: {item.target_name || item.target_id}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-slate-400">
                  {item.client_ip || 'local'}
                </TableCell>
                <TableCell>
                  <Chip
                    size="sm"
                    variant="dot"
                    color={item.status === 'success' ? 'success' : 'danger'}
                    className="text-[11px]"
                  >
                    {item.status}
                  </Chip>
                </TableCell>
                <TableCell>
                  <span
                    className="font-mono text-[11px] text-slate-400 truncate max-w-xs block"
                    title={item.detail_json}
                  >
                    {item.detail_json || '--'}
                  </span>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        {total > limit && (
          <div className="flex justify-center p-4 border-t border-slate-800">
            <Pagination
              total={Math.ceil(total / limit)}
              page={page}
              onChange={setPage}
              size="sm"
              color="primary"
            />
          </div>
        )}
      </div>
    </div>
  );
}
