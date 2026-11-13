import { User, RoomRow, Rack, Device, AuditLog, LayoutApplyPayload } from '../types';

const TOKEN_KEY = 'rackops_jwt_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    clearToken();
    if (!window.location.pathname.includes('/login')) {
      window.location.href = '/login';
    }
    throw new Error('未授权或登录已过期');
  }

  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error || `请求失败: ${res.status}`);
  }
  return json as T;
}

export const api = {
  // Auth
  login: (body: { username: string; password: string }) =>
    request<{ token: string; user: User }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getMe: () => request<User>('/api/v1/auth/me'),
  changePassword: (body: { old_password: string; new_password: string }) =>
    request<{ message: string }>('/api/v1/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Topology
  getRows: () => request<RoomRow[]>('/api/v1/topology/rows'),
  createRow: (body: { name: string; sort_order: number; rack_count: number; default_u_height: number; aisle_direction: string; prefix: string }) =>
    request<RoomRow>('/api/v1/topology/rows', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateRow: (id: number, body: { name: string; sort_order: number; aisle_direction: string; prefix: string }) =>
    request<{ message: string }>(`/api/v1/topology/rows/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteRow: (id: number) =>
    request<{ message: string; undo_token: string; label: string }>(`/api/v1/topology/rows/${id}`, {
      method: 'DELETE',
    }),
  getRack: (id: number) => request<Rack>(`/api/v1/topology/racks/${id}`),
  updateRack: (id: number, body: { name: string; total_u: number; description: string }) =>
    request<{ message: string }>(`/api/v1/topology/racks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  getRowDetail: (id: number) => request<RoomRow>(`/api/v1/topology/rows/${id}`),
  updateRowPosition: (id: number, body: { pos_x: number; pos_y: number }) =>
    request<{ message: string }>(`/api/v1/topology/rows/${id}/position`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  updateRackPosition: (id: number, body: { rel_x: number; rel_y: number }) =>
    request<{ message: string }>(`/api/v1/topology/racks/${id}/position`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  createRackInRow: (rowId: number, totalU?: number) =>
    request<Rack>(`/api/v1/topology/rows/${rowId}/racks`, {
      method: 'POST',
      body: JSON.stringify({ total_u: totalU || 0 }),
    }),
  deleteRack: (id: number) =>
    request<{ message: string; undo_token: string; label: string }>(`/api/v1/topology/racks/${id}`, {
      method: 'DELETE',
    }),
  restoreRack: (undoToken: string) =>
    request<Rack>('/api/v1/topology/racks/restore', {
      method: 'POST',
      body: JSON.stringify({ undo_token: undoToken }),
    }),
  restoreRow: (undoToken: string) =>
    request<RoomRow>('/api/v1/topology/rows/restore', {
      method: 'POST',
      body: JSON.stringify({ undo_token: undoToken }),
    }),
  applyLayout: (body: LayoutApplyPayload) =>
    request<{ message: string; rows: RoomRow[] }>('/api/v1/topology/layout/apply', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Devices
  getAllDevices: () => request<Device[]>('/api/v1/devices'),
  getDevice: (id: number) => request<Device>(`/api/v1/devices/${id}`),
  createDevice: (body: unknown) =>
    request<Device>('/api/v1/devices', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateDevice: (id: number, body: unknown) =>
    request<{ message: string }>(`/api/v1/devices/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteDevice: (id: number) =>
    request<{ message: string }>(`/api/v1/devices/${id}`, {
      method: 'DELETE',
    }),
  searchDevices: (q: string) =>
    request<Device[]>(`/api/v1/devices/search?q=${encodeURIComponent(q)}`),
  triggerCollect: (deviceId?: number) =>
    request<{ message: string }>(`/api/v1/devices/collect${deviceId ? `?device_id=${deviceId}` : ''}`, {
      method: 'POST',
    }),

  // Audit Logs
  getAuditLogs: (limit = 50, offset = 0) =>
    request<{ items: AuditLog[]; total: number; limit: number; offset: number }>(`/api/v1/audit-logs?limit=${limit}&offset=${offset}`),

  // Users
  getUsers: () => request<User[]>('/api/v1/users'),
  createUser: (body: { username: string; password: string; role: string }) =>
    request<User>('/api/v1/users', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateUser: (id: number, body: { role: string; enabled: boolean; new_password?: string }) =>
    request<{ message: string }>(`/api/v1/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteUser: (id: number) =>
    request<{ message: string }>(`/api/v1/users/${id}`, {
      method: 'DELETE',
    }),
};
