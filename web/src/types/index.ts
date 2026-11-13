export type Role = 'admin' | 'viewer';

export interface User {
  id: number;
  username: string;
  role: Role;
  enabled: boolean;
  created_at: string;
}

export interface RoomRow {
  id: number;
  name: string;
  sort_order: number;
  rack_count: number;
  default_u_height: number;
  aisle_direction: string;
  prefix: string;
  pos_x: number;
  pos_y: number;
  created_at?: string;
  updated_at?: string;
  racks?: Rack[];
}

export interface Rack {
  id: number;
  row_id: number;
  col_index: number;
  code: string;
  name: string;
  total_u: number;
  description: string;
  rel_x: number;
  rel_y: number;
  created_at?: string;
  updated_at?: string;
  used_u?: number;
  max_temp?: number;
  health_state?: 'ok' | 'warning' | 'critical' | 'unknown';
  devices?: Device[];
}

export type DeviceType = 'server' | 'switch' | 'storage' | 'other';

export interface Device {
  id: number;
  rack_id: number;
  start_u: number;
  u_height: number;
  type: DeviceType;
  sub_brand: string;
  name: string;
  hostname: string;
  asset_tag: string;
  vendor: string;
  model: string;
  serial_number: string;
  mgmt_ip: string;
  bmc_ip: string;
  notes: string;
  owner: string;
  created_at: string;
  updated_at: string;
  rack_code?: string;
  row_name?: string;
  telemetry?: DeviceTelemetry;
  credential?: DeviceCredential;
}

export interface DeviceCredential {
  device_id: number;
  bmc_protocol: string;
  bmc_port: number;
  bmc_user: string;
  bmc_password_mask?: string;
  bmc_insecure_tls: boolean;
  ssh_port: number;
  ssh_user: string;
  ssh_auth_type: string;
  ssh_secret_mask?: string;
}

export interface DeviceTelemetry {
  device_id: number;
  online_status: 'online' | 'offline' | 'unknown';
  power_state: 'on' | 'off' | 'unknown';
  health_status: 'ok' | 'warning' | 'critical' | 'unknown';
  max_temp_c?: number;
  inlet_temp_c?: number;
  cpu_model: string;
  cpu_count: number;
  memory_gb: number;
  disk_count: number;
  disk_health_summary: string;
  firmware_version: string;
  os_info: string;
  last_collected_at?: string;
  last_error: string;
}

export interface LayoutApplyPayload {
  row_positions: { id: number; pos_x: number; pos_y: number }[];
  rack_positions: { id: number; rel_x: number; rel_y: number }[];
  rack_creates: { row_id: number; total_u: number; rel_x: number; rel_y: number }[];
  row_creates: {
    name: string;
    prefix: string;
    aisle_direction: string;
    default_u_height: number;
    sort_order: number;
    pos_x: number;
    pos_y: number;
    racks: { rel_x: number; rel_y: number }[];
  }[];
  rack_deletes: number[];
  row_deletes: number[];
}

export interface AuditLog {
  id: number;
  user_id: number;
  username: string;
  role: Role;
  action: string;
  target_type: string;
  target_id: number;
  target_name: string;
  detail_json: string;
  client_ip: string;
  status: string;
  created_at: string;
}
