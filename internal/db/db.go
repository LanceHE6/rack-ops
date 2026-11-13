package db

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"

	"github.com/LanceHE6/rackops/internal/crypto"
)

func InitDB(dbPath string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dbPath+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite db: %w", err)
	}

	db.SetMaxOpenConns(1) // SQLite 单写入者模式，避免 database locked
	db.SetMaxIdleConns(1)

	if err := createTables(db); err != nil {
		return nil, err
	}

	if err := migrateSchema(db); err != nil {
		return nil, err
	}

	if err := initDefaultData(db); err != nil {
		return nil, err
	}

	return db, nil
}

func createTables(db *sql.DB) error {
	schema := `
	CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT UNIQUE NOT NULL,
		password_hash TEXT NOT NULL,
		role TEXT NOT NULL DEFAULT 'viewer',
		enabled INTEGER NOT NULL DEFAULT 1,
		created_at DATETIME NOT NULL,
		updated_at DATETIME NOT NULL
	);

	CREATE TABLE IF NOT EXISTS room_rows (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		sort_order INTEGER NOT NULL DEFAULT 0,
		rack_count INTEGER NOT NULL DEFAULT 0,
		default_u_height INTEGER NOT NULL DEFAULT 42,
		aisle_direction TEXT NOT NULL DEFAULT 'cold',
		prefix TEXT NOT NULL DEFAULT '',
		pos_x REAL NOT NULL DEFAULT 0,
		pos_y REAL NOT NULL DEFAULT 0,
		created_at DATETIME NOT NULL,
		updated_at DATETIME NOT NULL
	);

	CREATE TABLE IF NOT EXISTS racks (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		row_id INTEGER NOT NULL REFERENCES room_rows(id) ON DELETE CASCADE,
		col_index INTEGER NOT NULL,
		code TEXT NOT NULL UNIQUE,
		name TEXT NOT NULL,
		total_u INTEGER NOT NULL DEFAULT 42,
		description TEXT NOT NULL DEFAULT '',
		rel_x REAL NOT NULL DEFAULT 0,
		rel_y REAL NOT NULL DEFAULT 0,
		created_at DATETIME NOT NULL,
		updated_at DATETIME NOT NULL
	);

	CREATE TABLE IF NOT EXISTS devices (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		rack_id INTEGER NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
		start_u INTEGER NOT NULL,
		u_height INTEGER NOT NULL DEFAULT 1,
		type TEXT NOT NULL DEFAULT 'server',
		sub_brand TEXT NOT NULL DEFAULT 'other',
		name TEXT NOT NULL,
		hostname TEXT NOT NULL DEFAULT '',
		asset_tag TEXT NOT NULL DEFAULT '',
		vendor TEXT NOT NULL DEFAULT '',
		model TEXT NOT NULL DEFAULT '',
		serial_number TEXT NOT NULL DEFAULT '',
		mgmt_ip TEXT NOT NULL DEFAULT '',
		bmc_ip TEXT NOT NULL DEFAULT '',
		notes TEXT NOT NULL DEFAULT '',
		owner TEXT NOT NULL DEFAULT '',
		created_at DATETIME NOT NULL,
		updated_at DATETIME NOT NULL
	);

	CREATE TABLE IF NOT EXISTS device_credentials (
		device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
		bmc_protocol TEXT NOT NULL DEFAULT 'redfish',
		bmc_port INTEGER NOT NULL DEFAULT 443,
		bmc_user TEXT NOT NULL DEFAULT '',
		bmc_password_enc TEXT NOT NULL DEFAULT '',
		bmc_insecure_tls INTEGER NOT NULL DEFAULT 1,
		ssh_port INTEGER NOT NULL DEFAULT 22,
		ssh_user TEXT NOT NULL DEFAULT 'root',
		ssh_auth_type TEXT NOT NULL DEFAULT 'password',
		ssh_secret_enc TEXT NOT NULL DEFAULT ''
	);

	CREATE TABLE IF NOT EXISTS device_telemetry (
		device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
		online_status TEXT NOT NULL DEFAULT 'unknown',
		power_state TEXT NOT NULL DEFAULT 'unknown',
		health_status TEXT NOT NULL DEFAULT 'unknown',
		max_temp_c REAL,
		inlet_temp_c REAL,
		cpu_model TEXT NOT NULL DEFAULT '',
		cpu_count INTEGER NOT NULL DEFAULT 0,
		memory_gb INTEGER NOT NULL DEFAULT 0,
		disk_count INTEGER NOT NULL DEFAULT 0,
		disk_health_summary TEXT NOT NULL DEFAULT '',
		firmware_version TEXT NOT NULL DEFAULT '',
		os_info TEXT NOT NULL DEFAULT '',
		raw_sensors_json TEXT NOT NULL DEFAULT '',
		last_collected_at DATETIME,
		last_error TEXT NOT NULL DEFAULT ''
	);

	CREATE TABLE IF NOT EXISTS audit_logs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL DEFAULT 0,
		username TEXT NOT NULL,
		role TEXT NOT NULL DEFAULT 'viewer',
		action TEXT NOT NULL,
		target_type TEXT NOT NULL,
		target_id INTEGER NOT NULL DEFAULT 0,
		target_name TEXT NOT NULL DEFAULT '',
		detail_json TEXT NOT NULL DEFAULT '',
		client_ip TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL DEFAULT 'success',
		created_at DATETIME NOT NULL
	);

	CREATE TABLE IF NOT EXISTS app_meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL DEFAULT ''
	);

	-- 索引
	CREATE INDEX IF NOT EXISTS idx_racks_row_id ON racks(row_id);
	CREATE INDEX IF NOT EXISTS idx_devices_rack_id ON devices(rack_id);
	CREATE INDEX IF NOT EXISTS idx_devices_mgmt_ip ON devices(mgmt_ip);
	CREATE INDEX IF NOT EXISTS idx_devices_bmc_ip ON devices(bmc_ip);
	CREATE INDEX IF NOT EXISTS idx_devices_asset_tag ON devices(asset_tag);
	CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
	`
	_, err := db.Exec(schema)
	return err
}

func metaGet(db *sql.DB, key string) (string, bool) {
	var v string
	err := db.QueryRow("SELECT value FROM app_meta WHERE key = ?", key).Scan(&v)
	if err != nil {
		return "", false
	}
	return v, true
}

func metaSet(db *sql.DB, key, value string) {
	_, _ = db.Exec("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
}

// migrateSchema 为旧版本数据库补齐布局坐标列，并一次性回填默认布局
func migrateSchema(db *sql.DB) error {
	addColumn := func(table, col, def string) error {
		rows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
		if err != nil {
			return err
		}
		exists := false
		for rows.Next() {
			var cid int
			var name, ctype string
			var notnull int
			var dflt sql.NullString
			var pk int
			if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err == nil && name == col {
				exists = true
			}
		}
		rows.Close()
		if !exists {
			_, err = db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, col, def))
		}
		return err
	}

	if err := addColumn("room_rows", "pos_x", "REAL NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := addColumn("room_rows", "pos_y", "REAL NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := addColumn("racks", "rel_x", "REAL NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := addColumn("racks", "rel_y", "REAL NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := addColumn("devices", "owner", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}

	if _, done := metaGet(db, "layout_v1"); !done {
		// 旧数据默认布局：机排纵向间隔 3 格，机柜横向间隔 1 格（紧邻）
		_, _ = db.Exec(`UPDATE room_rows SET pos_y = (sort_order - 1) * 3 WHERE pos_x = 0 AND pos_y = 0`)
		_, _ = db.Exec(`UPDATE racks SET rel_x = (col_index - 1) * 1.0 WHERE rel_x = 0 AND rel_y = 0`)
		metaSet(db, "layout_v1", "1")
	}

	// 严格网格归一：所有机排/机柜坐标吸附到整数格，机柜按列连续排列
	if _, done := metaGet(db, "grid_snap_v1"); !done {
		_, _ = db.Exec(`UPDATE room_rows SET pos_x = ROUND(pos_x), pos_y = ROUND(pos_y)`)
		rows, err := db.Query("SELECT id FROM room_rows ORDER BY sort_order, id")
		if err == nil {
			var rowIDs []int64
			for rows.Next() {
				var id int64
				if err := rows.Scan(&id); err == nil {
					rowIDs = append(rowIDs, id)
				}
			}
			_ = rows.Close()
			for _, rowID := range rowIDs {
				rks, err := db.Query("SELECT id FROM racks WHERE row_id = ? ORDER BY rel_x, col_index, id", rowID)
				if err != nil {
					continue
				}
				var rackIDs []int64
				for rks.Next() {
					var id int64
					if err := rks.Scan(&id); err == nil {
						rackIDs = append(rackIDs, id)
					}
				}
				_ = rks.Close()
				for i, rackID := range rackIDs {
					_, _ = db.Exec("UPDATE racks SET rel_x = ?, rel_y = 0 WHERE id = ?", float64(i), rackID)
				}
			}
		}
		metaSet(db, "grid_snap_v1", "1")
	}

	// 设备 U 位重叠修复：历史数据可能存在同柜设备 U 区间重叠（视图中表现为互相穿插），
	// 这里一次性把冲突设备挪到最近的空闲 U 位，避免再次出现穿模。
	if _, done := metaGet(db, "device_u_fix_v1"); !done {
		rackRows, err := db.Query("SELECT id, total_u FROM racks")
		if err == nil {
			type rackInfo struct {
				id    int64
				total int
			}
			var racks []rackInfo
			for rackRows.Next() {
				var id int64
				var total int
				if err := rackRows.Scan(&id, &total); err == nil {
					racks = append(racks, rackInfo{id, total})
				}
			}
			_ = rackRows.Close()
			for _, rk := range racks {
				total := rk.total
				if total <= 0 {
					total = 42
				}
				devRows, err := db.Query("SELECT id, start_u, u_height FROM devices WHERE rack_id = ? ORDER BY start_u, id", rk.id)
				if err != nil {
					continue
				}
				type dv struct {
					id, s, h int
				}
				var devs []dv
				for devRows.Next() {
					var d dv
					if err := devRows.Scan(&d.id, &d.s, &d.h); err == nil {
						devs = append(devs, d)
					}
				}
				_ = devRows.Close()
				occupied := map[int]bool{}
				for _, d := range devs {
					if d.h < 1 {
						d.h = 1
					}
					s := d.s
					if s < 1 {
						s = 1
					}
					for s+d.h-1 <= total && uOverlaps(occupied, s, d.h) {
						s++
					}
					if s+d.h-1 > total {
						s = 1
						for s+d.h-1 <= total && uOverlaps(occupied, s, d.h) {
							s++
						}
					}
					if s+d.h-1 > total {
						continue
					}
					for u := s; u < s+d.h; u++ {
						occupied[u] = true
					}
					if s != d.s {
						_, _ = db.Exec("UPDATE devices SET start_u = ? WHERE id = ?", s, d.id)
					}
				}
			}
		}
		metaSet(db, "device_u_fix_v1", "1")
	}
	return nil
}

// uOverlaps 判断 [start, start+height-1] 是否与已占用 U 位冲突
func uOverlaps(occupied map[int]bool, start, height int) bool {
	for u := start; u < start+height; u++ {
		if occupied[u] {
			return true
		}
	}
	return false
}

func initDefaultData(db *sql.DB) error {
	var count int
	err := db.QueryRow("SELECT COUNT(*) FROM users").Scan(&count)
	if err != nil {
		return err
	}
	now := time.Now()
	if count == 0 {
		hash, _ := crypto.HashPassword("admin123")
		_, err = db.Exec(`INSERT INTO users (username, password_hash, role, enabled, created_at, updated_at)
			VALUES (?, ?, 'admin', 1, ?, ?)`, "admin", hash, now, now)
		if err != nil {
			return err
		}
	}

	var rowCount int
	err = db.QueryRow("SELECT COUNT(*) FROM room_rows").Scan(&rowCount)
	if err != nil {
		return err
	}
	if rowCount == 0 {
		initSampleLayout(db, now)
	}

	seedDemoData(db, now)
	return nil
}

func initSampleLayout(db *sql.DB, now time.Time) {
	rows := []struct {
		name      string
		prefix    string
		rackCount int
	}{
		{"A排", "A", 4},
		{"B排", "B", 4},
	}

	for i, r := range rows {
		posY := float64(i) * 3
		res, err := db.Exec(`INSERT INTO room_rows (name, sort_order, rack_count, default_u_height, aisle_direction, prefix, pos_x, pos_y, created_at, updated_at)
			VALUES (?, ?, ?, 42, 'cold', ?, 0, ?, ?, ?)`, r.name, i+1, r.rackCount, r.prefix, posY, now, now)
		if err != nil {
			continue
		}
		rowID, _ := res.LastInsertId()
		for c := 1; c <= r.rackCount; c++ {
			code := fmt.Sprintf("%s%02d", r.prefix, c)
			rackName := fmt.Sprintf("%s排-%02d号机柜", r.prefix, c)
			relX := float64(c - 1)
			_, _ = db.Exec(`INSERT INTO racks (row_id, col_index, code, name, total_u, description, rel_x, rel_y, created_at, updated_at)
				VALUES (?, ?, ?, ?, 42, '', ?, 0, ?, ?)`, rowID, c, code, rackName, relX, now, now)
		}
	}
}

// seedDemoData 首次启动时填充演示设备与遥测，让拓扑视图开箱即有真实感数据。
// 演示设备 notes 带 [demo] 标记，采集器会自动跳过，不会被轮询覆盖。
func seedDemoData(db *sql.DB, now time.Time) {
	if _, done := metaGet(db, "demo_seed_v1"); done {
		return
	}
	var devCount int
	_ = db.QueryRow("SELECT COUNT(*) FROM devices").Scan(&devCount)
	if devCount >= 5 {
		metaSet(db, "demo_seed_v1", "skip")
		return
	}

	type demoDev struct {
		rackCode               string
		startU, uHeight        int
		devType, subBrand      string
		name, hostname         string
		vendor, model          string
		mgmtIP, bmcIP          string
		online, health         string
		maxTemp, inletTemp     float64
		cpu                    string
		cpuCount, memGB, disks int
		osInfo                 string
	}

	demo := []demoDev{
		// A01 核心网络 + K8s 控制面
		{"A01", 42, 1, "switch", "h3c", "H3C-S6800-Core-A", "core-sw-a", "华三", "S6800-54QT", "192.168.10.2", "", "online", "ok", 41, 28, "", 0, 0, 0, "Comware V7.1.070"},
		{"A01", 40, 1, "switch", "centec", "Centec-V580-TOR-A", "tor-a", "盛科", "CTC7132", "192.168.10.3", "", "online", "ok", 38, 27, "", 0, 0, 0, "SONiC 202311"},
		{"A01", 36, 2, "server", "inspur_m6", "K8s-Master-01", "k8s-master-01", "浪潮", "NF5280M6", "192.168.20.11", "172.16.20.11", "online", "ok", 46, 24, "Intel Xeon Gold 6330", 2, 256, 2, "Ubuntu 22.04.4 LTS"},
		{"A01", 32, 2, "server", "xfusion", "K8s-Master-02", "k8s-master-02", "超聚变", "FusionServer 2288H V6", "192.168.20.12", "172.16.20.12", "online", "ok", 44, 23, "Intel Xeon Gold 6330", 2, 256, 2, "Ubuntu 22.04.4 LTS"},
		{"A01", 28, 2, "server", "inspur_m5", "K8s-Master-03", "k8s-master-03", "浪潮", "NF5280M5", "192.168.20.13", "172.16.20.13", "online", "ok", 47, 25, "Intel Xeon Silver 4314", 2, 128, 2, "Ubuntu 22.04.4 LTS"},
		// A02 计算节点
		{"A02", 42, 1, "switch", "h3c", "H3C-S6800-TOR-B", "tor-b", "华三", "S6800-54QT", "192.168.10.4", "", "online", "ok", 40, 28, "", 0, 0, 0, "Comware V7.1.070"},
		{"A02", 38, 2, "server", "inspur_m6", "K8s-Worker-01", "k8s-worker-01", "浪潮", "NF5280M6", "192.168.20.21", "172.16.20.21", "online", "ok", 52, 24, "Intel Xeon Gold 6338", 2, 512, 4, "Ubuntu 22.04.4 LTS"},
		{"A02", 34, 2, "server", "inspur_m6", "K8s-Worker-02", "k8s-worker-02", "浪潮", "NF5280M6", "192.168.20.22", "172.16.20.22", "online", "ok", 55, 25, "Intel Xeon Gold 6338", 2, 512, 4, "Ubuntu 22.04.4 LTS"},
		{"A02", 30, 2, "server", "netrix", "K8s-Worker-03", "k8s-worker-03", "宁畅", "R620 G40", "192.168.20.23", "172.16.20.23", "online", "ok", 51, 24, "Intel Xeon Gold 6348", 2, 512, 4, "Ubuntu 22.04.4 LTS"},
		{"A02", 26, 2, "server", "hygon", "K8s-Worker-04", "k8s-worker-04", "中科可控", "海光 C86 平台", "192.168.20.24", "172.16.20.24", "online", "ok", 49, 23, "Hygon C86 7390", 2, 256, 4, "Kylin V10 SP3"},
		{"A02", 22, 2, "server", "inspur_m5", "K8s-Worker-05", "k8s-worker-05", "浪潮", "NF5280M5", "192.168.20.25", "172.16.20.25", "online", "ok", 58, 26, "Intel Xeon Silver 4314", 2, 256, 4, "Ubuntu 22.04.4 LTS"},
		// A03 计算 + AI（含一台高温告警）
		{"A03", 42, 1, "switch", "centec", "Centec-V580-TOR-C", "tor-c", "盛科", "CTC7132", "192.168.10.5", "", "online", "ok", 39, 27, "", 0, 0, 0, "SONiC 202311"},
		{"A03", 38, 2, "server", "xfusion", "K8s-Worker-06", "k8s-worker-06", "超聚变", "FusionServer 2288H V6", "192.168.20.26", "172.16.20.26", "online", "ok", 53, 24, "Intel Xeon Gold 6338", 2, 512, 4, "Ubuntu 22.04.4 LTS"},
		{"A03", 34, 2, "server", "inspur_m6", "K8s-Worker-07", "k8s-worker-07", "浪潮", "NF5280M6", "192.168.20.27", "172.16.20.27", "online", "warning", 74, 31, "Intel Xeon Gold 6338", 2, 512, 4, "Ubuntu 22.04.4 LTS"},
		{"A03", 30, 2, "server", "netrix", "K8s-Worker-08", "k8s-worker-08", "宁畅", "R620 G40", "192.168.20.28", "172.16.20.28", "online", "ok", 50, 24, "Intel Xeon Gold 6348", 2, 512, 4, "Ubuntu 22.04.4 LTS"},
		{"A03", 26, 2, "server", "hygon", "AI-Train-01", "ai-train-01", "中科可控", "海光 C86 平台", "192.168.20.29", "172.16.20.29", "online", "ok", 61, 27, "Hygon C86 7390", 2, 512, 8, "Kylin V10 SP3"},
		// A04 SAN 存储
		{"A04", 42, 1, "switch", "brocade", "Brocade-G620-SAN-A", "san-fc-a", "博科", "G620", "192.168.10.6", "", "online", "ok", 36, 26, "", 0, 0, 0, "Fabric OS 9.1"},
		{"A04", 36, 4, "storage", "san", "MacrosSAN-Head-A", "san-head-a", "宏杉", "MS5000G2", "192.168.30.11", "172.16.30.11", "online", "ok", 42, 25, "", 0, 0, 24, "MacroSAN OS 3.2"},
		{"A04", 30, 4, "storage", "san", "MacrosSAN-Head-B", "san-head-b", "宏杉", "MS5000G2", "192.168.30.12", "172.16.30.12", "online", "ok", 43, 25, "", 0, 0, 24, "MacroSAN OS 3.2"},
		{"A04", 24, 2, "server", "inspur_m5", "Ceph-MON-01", "ceph-mon-01", "浪潮", "NF5280M5", "192.168.20.31", "172.16.20.31", "online", "ok", 45, 24, "Intel Xeon Silver 4314", 2, 128, 12, "Ubuntu 22.04.4 LTS"},
		// B01 Ceph OSD
		{"B01", 42, 1, "switch", "h3c", "H3C-S6800-TOR-D", "tor-d", "华三", "S6800-54QT", "192.168.10.7", "", "online", "ok", 41, 28, "", 0, 0, 0, "Comware V7.1.070"},
		{"B01", 38, 2, "server", "inspur_m6", "Ceph-OSD-01", "ceph-osd-01", "浪潮", "NF5280M6", "192.168.20.41", "172.16.20.41", "online", "ok", 48, 24, "Intel Xeon Silver 4316", 2, 256, 12, "Ubuntu 22.04.4 LTS"},
		{"B01", 34, 2, "server", "inspur_m6", "Ceph-OSD-02", "ceph-osd-02", "浪潮", "NF5280M6", "192.168.20.42", "172.16.20.42", "online", "ok", 49, 24, "Intel Xeon Silver 4316", 2, 256, 12, "Ubuntu 22.04.4 LTS"},
		{"B01", 30, 2, "server", "netrix", "Ceph-OSD-03", "ceph-osd-03", "宁畅", "R620 G40", "192.168.20.43", "172.16.20.43", "online", "ok", 47, 23, "Intel Xeon Silver 4316", 2, 256, 12, "Ubuntu 22.04.4 LTS"},
		// B02 Ceph + 备份（含一台离线）
		{"B02", 42, 1, "switch", "centec", "Centec-V580-TOR-E", "tor-e", "盛科", "CTC7132", "192.168.10.8", "", "online", "ok", 38, 27, "", 0, 0, 0, "SONiC 202311"},
		{"B02", 38, 2, "server", "xfusion", "Ceph-OSD-04", "ceph-osd-04", "超聚变", "FusionServer 2288H V6", "192.168.20.44", "172.16.20.44", "online", "ok", 50, 24, "Intel Xeon Silver 4316", 2, 256, 12, "Ubuntu 22.04.4 LTS"},
		{"B02", 34, 2, "server", "inspur_m5", "Ceph-OSD-05", "ceph-osd-05", "浪潮", "NF5280M5", "192.168.20.45", "172.16.20.45", "offline", "critical", 0, 0, "Intel Xeon Silver 4314", 2, 256, 12, "Ubuntu 22.04.4 LTS"},
		{"B02", 30, 2, "server", "hygon", "Backup-Server-01", "backup-01", "中科可控", "海光 C86 平台", "192.168.20.46", "172.16.20.46", "online", "ok", 44, 23, "Hygon C86 7390", 2, 128, 16, "Kylin V10 SP3"},
		// B03 存储扩展 + 虚拟化
		{"B03", 42, 1, "switch", "brocade", "Brocade-G620-SAN-B", "san-fc-b", "博科", "G620", "192.168.10.9", "", "online", "ok", 35, 26, "", 0, 0, 0, "Fabric OS 9.1"},
		{"B03", 36, 4, "storage", "san", "MacrosSAN-Expand-01", "san-exp-01", "宏杉", "MS2000G2 扩展柜", "192.168.30.13", "", "online", "ok", 40, 25, "", 0, 0, 60, "MacroSAN OS 3.2"},
		{"B03", 28, 2, "server", "inspur_m6", "VM-Host-01", "vm-host-01", "浪潮", "NF5280M6", "192.168.20.51", "172.16.20.51", "online", "ok", 54, 25, "Intel Xeon Gold 6348", 2, 768, 6, "VMware ESXi 8.0"},
		{"B03", 24, 2, "server", "inspur_m6", "VM-Host-02", "vm-host-02", "浪潮", "NF5280M6", "192.168.20.52", "172.16.20.52", "online", "ok", 56, 25, "Intel Xeon Gold 6348", 2, 768, 6, "VMware ESXi 8.0"},
		// B04 接入 + 动环
		{"B04", 42, 1, "switch", "h3c", "H3C-S5560-Access", "access-sw", "华三", "S5560-30C-EI", "192.168.10.10", "", "online", "ok", 35, 26, "", 0, 0, 0, "Comware V7.1.070"},
		{"B04", 1, 2, "other", "other", "UPS-Monitor-01", "ups-mon", "动环监控", "EMS-200", "192.168.10.20", "", "online", "ok", 30, 25, "", 0, 0, 0, "EMS Linux 2.4"},
	}

	for _, d := range demo {
		var rackID int64
		err := db.QueryRow("SELECT id FROM racks WHERE code = ?", d.rackCode).Scan(&rackID)
		if err != nil {
			continue
		}
		serial := fmt.Sprintf("DEMO-%s-%02d", d.rackCode, d.startU)
		res, err := db.Exec(`INSERT INTO devices (rack_id, start_u, u_height, type, sub_brand, name, hostname, asset_tag, vendor, model, serial_number, mgmt_ip, bmc_ip, notes, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			rackID, d.startU, d.uHeight, d.devType, d.subBrand, d.name, d.hostname,
			fmt.Sprintf("ZC-%s-%02d", d.rackCode, d.startU), d.vendor, d.model, serial,
			d.mgmtIP, d.bmcIP, "[demo] 演示设备，采集器自动跳过", now, now)
		if err != nil {
			continue
		}
		devID, _ := res.LastInsertId()

		var maxTemp, inletTemp any
		if d.maxTemp > 0 {
			maxTemp = d.maxTemp
		}
		if d.inletTemp > 0 {
			inletTemp = d.inletTemp
		}
		power := "on"
		if d.online == "offline" {
			power = "unknown"
		}
		diskSummary := ""
		if d.disks > 0 {
			diskSummary = fmt.Sprintf("%d 块磁盘正常", d.disks)
		}
		lastErr := ""
		if d.online == "offline" {
			lastErr = "SSH/BMC 探测超时（演示数据）"
		}
		_, _ = db.Exec(`INSERT INTO device_telemetry (device_id, online_status, power_state, health_status, max_temp_c, inlet_temp_c, cpu_model, cpu_count, memory_gb, disk_count, disk_health_summary, firmware_version, os_info, raw_sensors_json, last_collected_at, last_error)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, '', ?, ?)`,
			devID, d.online, power, d.health, maxTemp, inletTemp,
			d.cpu, d.cpuCount, d.memGB, d.disks, diskSummary, d.osInfo, now, lastErr)
	}
	metaSet(db, "demo_seed_v1", "1")
}
