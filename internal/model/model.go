package model

import "time"

type Role string

const (
	RoleAdmin  Role = "admin"
	RoleViewer Role = "viewer"
)

type User struct {
	ID           int64     `json:"id"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"`
	Role         Role      `json:"role"`
	Enabled      bool      `json:"enabled"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type RoomRow struct {
	ID             int64     `json:"id"`
	Name           string    `json:"name"`             // 如 "A排"
	SortOrder      int       `json:"sort_order"`       // 排序号
	RackCount      int       `json:"rack_count"`       // 该排机柜数量
	DefaultUHeight int       `json:"default_u_height"` // 默认机柜U数，如 42
	AisleDirection string    `json:"aisle_direction"`  // cold/hot 面对冷通道还是热通道
	Prefix         string    `json:"prefix"`           // 编号前缀，如 "A"
	PosX           float64   `json:"pos_x"`            // 机房俯视图位置（单位：机柜格，1格=1个机柜宽）
	PosY           float64   `json:"pos_y"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	Racks          []*Rack   `json:"racks,omitempty"`
}

type Rack struct {
	ID          int64     `json:"id"`
	RowID       int64     `json:"row_id"`
	ColIndex    int       `json:"col_index"` // 排内第几个机柜（从1开始）
	Code        string    `json:"code"`      // 如 "A01"
	Name        string    `json:"name"`      // 机柜展示名称
	TotalU      int       `json:"total_u"`   // 总U数，默认42
	Description string    `json:"description"`
	RelX        float64   `json:"rel_x"` // 相对机排原点横向位置（单位：机柜格）
	RelY        float64   `json:"rel_y"` // 相对机排原点纵向位置
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`

	// 动态统计字段
	UsedU       int       `json:"used_u,omitempty"`
	MaxTemp     *float64  `json:"max_temp,omitempty"`
	HealthState string    `json:"health_state,omitempty"` // ok, warning, critical, unknown
	Devices     []*Device `json:"devices,omitempty"`
}

type DeviceType string

const (
	DeviceTypeServer  DeviceType = "server"
	DeviceTypeSwitch  DeviceType = "switch"
	DeviceTypeStorage DeviceType = "storage"
	DeviceTypeOther   DeviceType = "other"
)

type Device struct {
	ID           int64      `json:"id"`
	RackID       int64      `json:"rack_id"`
	StartU       int        `json:"start_u"`   // 起始U位（从下往上，1到TotalU）
	UHeight      int        `json:"u_height"`  // 占用U高（如 1U, 2U, 4U）
	Type         DeviceType `json:"type"`      // server, switch, storage, other
	SubBrand     string     `json:"sub_brand"` // inspur_m5, inspur_m6, xfusion, netrix, hygon, centec, h3c, brocade, san, other
	Name         string     `json:"name"`
	Hostname     string     `json:"hostname"`
	AssetTag     string     `json:"asset_tag"`
	Vendor       string     `json:"vendor"`
	Model        string     `json:"model"`
	SerialNumber string     `json:"serial_number"`
	MgmtIP       string     `json:"mgmt_ip"`
	BmcIP        string     `json:"bmc_ip"`
	Notes        string     `json:"notes"`
	Owner        string     `json:"owner"` // 使用人（默认空）
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`

	// 关联或聚合字段
	RackCode   string            `json:"rack_code,omitempty"`
	RowName    string            `json:"row_name,omitempty"`
	Credential *DeviceCredential `json:"credential,omitempty"`
	Telemetry  *DeviceTelemetry  `json:"telemetry,omitempty"`
}

type DeviceCredential struct {
	DeviceID        int64  `json:"device_id"`
	BmcProtocol     string `json:"bmc_protocol"` // redfish, ipmi
	BmcPort         int    `json:"bmc_port"`
	BmcUser         string `json:"bmc_user"`
	BmcPasswordEnc  string `json:"-"`
	BmcPasswordMask string `json:"bmc_password_mask,omitempty"`
	BmcInsecureTLS  bool   `json:"bmc_insecure_tls"`
	SSHPort         int    `json:"ssh_port"`
	SSHUser         string `json:"ssh_user"`
	SSHAuthType     string `json:"ssh_auth_type"` // password, key
	SSHSecretEnc    string `json:"-"`
	SSHSecretMask   string `json:"ssh_secret_mask,omitempty"`
}

type DeviceTelemetry struct {
	DeviceID          int64      `json:"device_id"`
	OnlineStatus      string     `json:"online_status"` // online, offline, unknown
	PowerState        string     `json:"power_state"`   // on, off, unknown
	HealthStatus      string     `json:"health_status"` // ok, warning, critical, unknown
	MaxTempC          *float64   `json:"max_temp_c"`
	InletTempC        *float64   `json:"inlet_temp_c"`
	CPUModel          string     `json:"cpu_model"`
	CPUCount          int        `json:"cpu_count"`
	MemoryGB          int        `json:"memory_gb"`
	DiskCount         int        `json:"disk_count"`
	DiskHealthSummary string     `json:"disk_health_summary"`
	FirmwareVersion   string     `json:"firmware_version"`
	OSInfo            string     `json:"os_info"`
	RawSensorsJSON    string     `json:"raw_sensors_json,omitempty"`
	LastCollectedAt   *time.Time `json:"last_collected_at"`
	LastError         string     `json:"last_error"`
}

type AuditLog struct {
	ID         int64     `json:"id"`
	UserID     int64     `json:"user_id"`
	Username   string    `json:"username"`
	Role       Role      `json:"role"`
	Action     string    `json:"action"`      // login, topology_edit, device_create, device_update, device_delete, webssh_start, ipmisol_start, collect_refresh
	TargetType string    `json:"target_type"` // row, rack, device, user, system
	TargetID   int64     `json:"target_id"`
	TargetName string    `json:"target_name"`
	DetailJSON string    `json:"detail_json"`
	ClientIP   string    `json:"client_ip"`
	Status     string    `json:"status"` // success, failure
	CreatedAt  time.Time `json:"created_at"`
}

// ---- 拓扑快照（删除后用于撤销恢复） ----

type DeviceSnapshot struct {
	Device         *Device           `json:"device"`
	Credential     *DeviceCredential `json:"credential,omitempty"`
	BmcPasswordEnc string            `json:"bmc_password_enc"`
	SSHSecretEnc   string            `json:"ssh_secret_enc"`
	Telemetry      *DeviceTelemetry  `json:"telemetry"`
}

type RackSnapshot struct {
	Rack    *Rack             `json:"rack"`
	Devices []*DeviceSnapshot `json:"devices"`
}

type RowSnapshot struct {
	Row   *RoomRow        `json:"row"`
	Racks []*RackSnapshot `json:"racks"`
}
