import React, { useState, useEffect } from 'react';
import {
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  Button,
  Chip,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Input,
  Select,
  SelectItem,
} from '@heroui/react';
import { Users as UsersIcon, Plus, Trash2, KeyRound } from 'lucide-react';
import { User, Role } from '../types';
import { api } from '../api/client';

export function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // 表单状态
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [error, setError] = useState('');

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const data = await api.getUsers();
      setUsers(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleCreate = async () => {
    if (!username.trim() || !password.trim()) {
      setError('请输入用户名和密码');
      return;
    }
    setError('');
    try {
      await api.createUser({
        username: username.trim(),
        password: password.trim(),
        role,
      });
      setModalOpen(false);
      setUsername('');
      setPassword('');
      fetchUsers();
    } catch (err: any) {
      setError(err.message || '创建用户失败');
    }
  };

  const handleDelete = async (u: User) => {
    if (!window.confirm(`确认删除用户 ${u.username}？`)) return;
    try {
      await api.deleteUser(u.id);
      fetchUsers();
    } catch (err: any) {
      alert(err.message || '删除失败');
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <UsersIcon className="w-5 h-5 text-sky-400" />
            用户与权限管理
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            管理员（admin）拥有拓扑编辑与远程控制台权限，普通成员（viewer）仅只读访问
          </p>
        </div>
        <Button
          size="sm"
          color="primary"
          startContent={<Plus className="w-4 h-4" />}
          onPress={() => setModalOpen(true)}
        >
          新建用户
        </Button>
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden p-2">
        <Table
          aria-label="Users Table"
          classNames={{
            base: 'min-w-full',
            table: 'min-w-full',
            th: 'bg-slate-800/80 text-slate-300 text-xs font-semibold',
            td: 'text-xs text-slate-200 border-b border-slate-800/50 py-3',
          }}
        >
          <TableHeader>
            <TableColumn>用户账号</TableColumn>
            <TableColumn>权限角色</TableColumn>
            <TableColumn>账号状态</TableColumn>
            <TableColumn>创建时间</TableColumn>
            <TableColumn>操作</TableColumn>
          </TableHeader>
          <TableBody emptyContent="暂无用户" items={users}>
            {(u) => (
              <TableRow key={u.id}>
                <TableCell className="font-semibold text-slate-200">{u.username}</TableCell>
                <TableCell>
                  <Chip
                    size="sm"
                    color={u.role === 'admin' ? 'primary' : 'default'}
                    variant="flat"
                    className="text-xs"
                  >
                    {u.role === 'admin' ? '系统管理员' : '只读查看者'}
                  </Chip>
                </TableCell>
                <TableCell>
                  <Chip size="sm" color={u.enabled ? 'success' : 'danger'} variant="dot" className="text-xs">
                    {u.enabled ? '正常启用' : '已禁用'}
                  </Chip>
                </TableCell>
                <TableCell className="font-mono text-slate-400">
                  {new Date(u.created_at).toLocaleString()}
                </TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="light"
                    color="danger"
                    isIconOnly
                    onPress={() => handleDelete(u)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} size="sm" classNames={{ base: 'bg-slate-900 border border-slate-700 text-slate-100' }}>
        <ModalContent>
          <ModalHeader className="border-b border-slate-800">新建账号</ModalHeader>
          <ModalBody className="py-4 space-y-3">
            {error && (
              <div className="p-2 text-xs rounded bg-red-950 border border-red-800 text-red-200">
                {error}
              </div>
            )}
            <Input
              label="用户名"
              size="sm"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
            />
            <Input
              label="登录密码"
              type="password"
              size="sm"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              classNames={{ inputWrapper: 'bg-slate-800 border-slate-700' }}
            />
            <Select
              label="角色权限"
              size="sm"
              selectedKeys={[role]}
              onChange={(e) => setRole(e.target.value as Role)}
              classNames={{ trigger: 'bg-slate-800 border-slate-700' }}
            >
              <SelectItem key="viewer">只读成员 (Viewer - 仅浏览与搜索)</SelectItem>
              <SelectItem key="admin">管理员 (Admin - 拓扑编辑与 WebSSH)</SelectItem>
            </Select>
          </ModalBody>
          <ModalFooter className="border-t border-slate-800">
            <Button variant="flat" onPress={() => setModalOpen(false)}>取消</Button>
            <Button color="primary" onPress={handleCreate}>确认创建</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
