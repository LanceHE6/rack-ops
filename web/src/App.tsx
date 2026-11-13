import React, { useState, useEffect } from 'react';
import {
  Navbar,
  NavbarBrand,
  NavbarContent,
  NavbarItem,
  Button,
  Chip,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
} from '@heroui/react';
import {
  Server,
  Layers,
  History,
  Users,
  LogOut,
  User as UserIcon,
} from 'lucide-react';
import { User } from './types';
import { api, getToken, clearToken } from './api/client';
import { LoginPage } from './pages/LoginPage';
import { TopologyPage } from './pages/TopologyPage';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { UsersPage } from './pages/UsersPage';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<'topology' | 'audit' | 'users'>('topology');
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      const token = getToken();
      if (!token) {
        setInitializing(false);
        return;
      }
      try {
        const user = await api.getMe();
        setCurrentUser(user);
      } catch (err) {
        clearToken();
      } finally {
        setInitializing(false);
      }
    };
    checkAuth();
  }, []);

  const handleLogout = () => {
    clearToken();
    setCurrentUser(null);
  };

  if (initializing) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#070a13] text-slate-400 text-sm">
        <Server className="w-6 h-6 mr-2 animate-bounce text-sky-400" />
        RackOps 正在加载环境...
      </div>
    );
  }

  if (!currentUser) {
    return <LoginPage onLoginSuccess={(u) => setCurrentUser(u)} />;
  }

  return (
    <div className="min-h-screen bg-[#070a13] text-slate-100 flex flex-col font-sans">
      {/* 顶部主导航 */}
      <Navbar
        isBordered
        className="bg-slate-900/80 border-b border-slate-800 backdrop-blur max-w-full"
        classNames={{ wrapper: 'max-w-full px-6' }}
      >
        <NavbarBrand className="gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center shadow-md shadow-sky-500/20">
            <Server className="w-4 h-4 text-white" />
          </div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-lg text-slate-100 tracking-tight">RackOps</span>
            <Chip size="sm" variant="flat" color="primary" className="text-[10px] h-4 px-1 font-mono">
              v0.1.0
            </Chip>
          </div>
        </NavbarBrand>

        <NavbarContent className="hidden sm:flex gap-4" justify="center">
          <NavbarItem isActive={activeTab === 'topology'}>
            <Button
              variant={activeTab === 'topology' ? 'flat' : 'light'}
              color={activeTab === 'topology' ? 'primary' : 'default'}
              size="sm"
              startContent={<Layers className="w-4 h-4" />}
              onPress={() => setActiveTab('topology')}
              className="text-xs"
            >
              机房拓扑透视
            </Button>
          </NavbarItem>
          <NavbarItem isActive={activeTab === 'audit'}>
            <Button
              variant={activeTab === 'audit' ? 'flat' : 'light'}
              color={activeTab === 'audit' ? 'primary' : 'default'}
              size="sm"
              startContent={<History className="w-4 h-4" />}
              onPress={() => setActiveTab('audit')}
              className="text-xs"
            >
              审计追踪
            </Button>
          </NavbarItem>
          {currentUser.role === 'admin' && (
            <NavbarItem isActive={activeTab === 'users'}>
              <Button
                variant={activeTab === 'users' ? 'flat' : 'light'}
                color={activeTab === 'users' ? 'primary' : 'default'}
                size="sm"
                startContent={<Users className="w-4 h-4" />}
                onPress={() => setActiveTab('users')}
                className="text-xs"
              >
                成员管理
              </Button>
            </NavbarItem>
          )}
        </NavbarContent>

        <NavbarContent justify="end">
          <Dropdown placement="bottom-end" className="bg-slate-900 border border-slate-700 text-slate-100">
            <DropdownTrigger>
              <Button size="sm" variant="flat" className="gap-2 bg-slate-800 text-slate-200 text-xs">
                <UserIcon className="w-3.5 h-3.5 text-sky-400" />
                <span>{currentUser.username}</span>
                <Chip size="sm" variant="bordered" className="text-[10px] h-4 border-slate-600">
                  {currentUser.role}
                </Chip>
              </Button>
            </DropdownTrigger>
            <DropdownMenu aria-label="User Actions" variant="flat">
              <DropdownItem key="profile" className="h-12 gap-2" textValue="登录身份">
                <p className="font-semibold text-xs">当前身份</p>
                <p className="font-semibold text-xs text-sky-400">{currentUser.username} ({currentUser.role})</p>
              </DropdownItem>
              <DropdownItem
                key="logout"
                color="danger"
                startContent={<LogOut className="w-4 h-4" />}
                onPress={handleLogout}
              >
                退出登录
              </DropdownItem>
            </DropdownMenu>
          </Dropdown>
        </NavbarContent>
      </Navbar>

      {/* 视图内容切换 */}
      <main className="flex-1">
        {activeTab === 'topology' && <TopologyPage currentUser={currentUser} />}
        {activeTab === 'audit' && <AuditLogsPage />}
        {activeTab === 'users' && currentUser.role === 'admin' && <UsersPage />}
      </main>
    </div>
  );
}
