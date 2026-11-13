import React, { useState } from 'react';
import { Card, CardHeader, CardBody, Input, Button } from '@heroui/react';
import { Server, Lock, User as UserIcon } from 'lucide-react';
import { api, setToken } from '../api/client';
import { User } from '../types';

interface Props {
  onLoginSuccess: (user: User) => void;
}

export function LoginPage({ onLoginSuccess }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      setError('请输入用户名和密码');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.login({ username, password });
      setToken(res.token);
      onLoginSuccess(res.user);
    } catch (err: any) {
      setError(err.message || '登录失败，请检查账号密码');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-[#070a13] px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-sky-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-sky-500/20 mb-3">
            <Server className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-100 tracking-tight">RackOps 机房管理平台</h1>
          <p className="text-xs text-slate-400 mt-1">2D/3D 机柜拓扑 · 硬件状态采集 · 远程控制台</p>
        </div>

        <Card className="bg-slate-900/90 border border-slate-800 shadow-2xl p-2">
          <CardHeader className="flex flex-col items-start px-4 pt-4 pb-2">
            <h2 className="text-base font-semibold text-slate-200">系统登录</h2>
            <p className="text-xs text-slate-400">使用平台管理员或成员账号访问机房资源</p>
          </CardHeader>
          <CardBody className="px-4 pb-4">
            <form onSubmit={handleLogin} className="space-y-4">
              {error && (
                <div className="p-2.5 rounded-lg bg-red-950/80 border border-red-800 text-red-200 text-xs">
                  {error}
                </div>
              )}
              <Input
                label="账号"
                placeholder="admin"
                size="sm"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                startContent={<UserIcon className="w-4 h-4 text-slate-400" />}
                classNames={{
                  inputWrapper: 'bg-slate-800 border-slate-700',
                }}
              />
              <Input
                label="密码"
                type="password"
                placeholder="••••••••"
                size="sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                startContent={<Lock className="w-4 h-4 text-slate-400" />}
                classNames={{
                  inputWrapper: 'bg-slate-800 border-slate-700',
                }}
              />
              <Button
                type="submit"
                color="primary"
                className="w-full mt-2 font-medium"
                isLoading={loading}
              >
                立即登录
              </Button>
            </form>
          </CardBody>
        </Card>

        <div className="text-center mt-6 text-xs text-slate-500 font-mono">
          默认初始化管理员：admin / admin123
        </div>
      </div>
    </div>
  );
}
