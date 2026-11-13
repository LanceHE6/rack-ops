package repository

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/LanceHE6/rackops/internal/crypto"
	"github.com/LanceHE6/rackops/internal/model"
)

type Repository struct {
	db        *sql.DB
	secretKey []byte
}

func NewRepository(db *sql.DB, secretKey []byte) *Repository {
	return &Repository{
		db:        db,
		secretKey: secretKey,
	}
}

// User methods
func (r *Repository) GetUserByUsername(username string) (*model.User, error) {
	row := r.db.QueryRow("SELECT id, username, password_hash, role, enabled, created_at, updated_at FROM users WHERE username = ?", username)
	u := &model.User{}
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.Enabled, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (r *Repository) GetUserByID(id int64) (*model.User, error) {
	row := r.db.QueryRow("SELECT id, username, password_hash, role, enabled, created_at, updated_at FROM users WHERE id = ?", id)
	u := &model.User{}
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.Enabled, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (r *Repository) ListUsers() ([]*model.User, error) {
	rows, err := r.db.Query("SELECT id, username, role, enabled, created_at, updated_at FROM users ORDER BY id ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []*model.User
	for rows.Next() {
		u := &model.User{}
		if err := rows.Scan(&u.ID, &u.Username, &u.Role, &u.Enabled, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, nil
}

func (r *Repository) CreateUser(username, password string, role model.Role) (*model.User, error) {
	hash, err := crypto.HashPassword(password)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	res, err := r.db.Exec("INSERT INTO users (username, password_hash, role, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
		username, hash, role, now, now)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &model.User{
		ID:        id,
		Username:  username,
		Role:      role,
		Enabled:   true,
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

func (r *Repository) UpdateUser(id int64, role model.Role, enabled bool, newPassword string) error {
	now := time.Now()
	if newPassword != "" {
		hash, err := crypto.HashPassword(newPassword)
		if err != nil {
			return err
		}
		_, err = r.db.Exec("UPDATE users SET role = ?, enabled = ?, password_hash = ?, updated_at = ? WHERE id = ?",
			role, enabled, hash, now, id)
		return err
	}
	_, err := r.db.Exec("UPDATE users SET role = ?, enabled = ?, updated_at = ? WHERE id = ?",
		role, enabled, now, id)
	return err
}

func (r *Repository) DeleteUser(id int64) error {
	var count int
	_ = r.db.QueryRow("SELECT COUNT(*) FROM users WHERE role = 'admin'").Scan(&count)
	var targetRole string
	_ = r.db.QueryRow("SELECT role FROM users WHERE id = ?", id).Scan(&targetRole)
	if targetRole == "admin" && count <= 1 {
		return errors.New("cannot delete the only administrator")
	}
	_, err := r.db.Exec("DELETE FROM users WHERE id = ?", id)
	return err
}

// RoomRows and Racks (Topology)
func (r *Repository) ListRoomRows() ([]*model.RoomRow, error) {
	rows, err := r.db.Query("SELECT id, name, sort_order, rack_count, default_u_height, aisle_direction, prefix, pos_x, pos_y, created_at, updated_at FROM room_rows ORDER BY sort_order ASC, id ASC")
	if err != nil {
		return nil, err
	}

	var result []*model.RoomRow
	for rows.Next() {
		rr := &model.RoomRow{}
		if err := rows.Scan(&rr.ID, &rr.Name, &rr.SortOrder, &rr.RackCount, &rr.DefaultUHeight, &rr.AisleDirection, &rr.Prefix, &rr.PosX, &rr.PosY, &rr.CreatedAt, &rr.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, rr)
	}
	rows.Close()

	for _, rr := range result {
		racks, err := r.ListRacksByRowID(rr.ID)
		if err == nil {
			rr.Racks = racks
		}
	}
	return result, nil
}

func (r *Repository) ListRacksByRowID(rowID int64) ([]*model.Rack, error) {
	rows, err := r.db.Query(`
		SELECT r.id, r.row_id, r.col_index, r.code, r.name, r.total_u, r.description, r.rel_x, r.rel_y, r.created_at, r.updated_at,
		       COALESCE(SUM(d.u_height), 0) as used_u,
		       MAX(t.max_temp_c) as max_temp,
		       CASE 
		         WHEN SUM(CASE WHEN t.health_status = 'critical' THEN 1 ELSE 0 END) > 0 THEN 'critical'
		         WHEN SUM(CASE WHEN t.health_status = 'warning' THEN 1 ELSE 0 END) > 0 THEN 'warning'
		         WHEN SUM(CASE WHEN t.health_status = 'ok' THEN 1 ELSE 0 END) > 0 THEN 'ok'
		         ELSE 'unknown'
		       END as health_state
		FROM racks r
		LEFT JOIN devices d ON d.rack_id = r.id
		LEFT JOIN device_telemetry t ON t.device_id = d.id
		WHERE r.row_id = ?
		GROUP BY r.id
		ORDER BY r.col_index ASC
	`, rowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var racks []*model.Rack
	for rows.Next() {
		rk := &model.Rack{}
		var maxTemp sql.NullFloat64
		if err := rows.Scan(&rk.ID, &rk.RowID, &rk.ColIndex, &rk.Code, &rk.Name, &rk.TotalU, &rk.Description, &rk.RelX, &rk.RelY, &rk.CreatedAt, &rk.UpdatedAt, &rk.UsedU, &maxTemp, &rk.HealthState); err != nil {
			return nil, err
		}
		if maxTemp.Valid {
			tempVal := maxTemp.Float64
			rk.MaxTemp = &tempVal
		}
		racks = append(racks, rk)
	}
	return racks, nil
}

func (r *Repository) GetRackByID(rackID int64) (*model.Rack, error) {
	row := r.db.QueryRow(`
		SELECT r.id, r.row_id, r.col_index, r.code, r.name, r.total_u, r.description, r.rel_x, r.rel_y, r.created_at, r.updated_at,
		       COALESCE(SUM(d.u_height), 0) as used_u
	FROM racks r
	LEFT JOIN devices d ON d.rack_id = r.id
	WHERE r.id = ?
	GROUP BY r.id
`, rackID)
	rk := &model.Rack{}
	err := row.Scan(&rk.ID, &rk.RowID, &rk.ColIndex, &rk.Code, &rk.Name, &rk.TotalU, &rk.Description, &rk.RelX, &rk.RelY, &rk.CreatedAt, &rk.UpdatedAt, &rk.UsedU)
	if err != nil {
		return nil, err
	}
	devices, err := r.ListDevicesByRackID(rk.ID)
	if err == nil {
		rk.Devices = devices
	}
	return rk, nil
}

func (r *Repository) CreateRoomRow(name string, sortOrder int, rackCount int, defaultU int, aisle string, prefix string) (*model.RoomRow, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	now := time.Now()
	if defaultU <= 0 {
		defaultU = 42
	}
	if aisle == "" {
		aisle = "cold"
	}
	if prefix == "" {
		prefix = name
	}

	// 新排在机房俯视图中默认放置在现有最下方一排的下面
	var maxY float64
	_ = tx.QueryRow("SELECT COALESCE(MAX(pos_y), -3) FROM room_rows").Scan(&maxY)
	posY := maxY + 3

	res, err := tx.Exec("INSERT INTO room_rows (name, sort_order, rack_count, default_u_height, aisle_direction, prefix, pos_x, pos_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
		name, sortOrder, rackCount, defaultU, aisle, prefix, posY, now, now)
	if err != nil {
		return nil, err
	}
	rowID, _ := res.LastInsertId()

	for c := 1; c <= rackCount; c++ {
		code := fmt.Sprintf("%s%02d", prefix, c)
		rackName := fmt.Sprintf("%s-%02d", name, c)
		relX := float64(c-1) * RackSpacing
		_, err = tx.Exec("INSERT INTO racks (row_id, col_index, code, name, total_u, description, rel_x, rel_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', ?, 0, ?, ?)",
			rowID, c, code, rackName, defaultU, relX, now, now)
		if err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &model.RoomRow{
		ID:             rowID,
		Name:           name,
		SortOrder:      sortOrder,
		RackCount:      rackCount,
		DefaultUHeight: defaultU,
		AisleDirection: aisle,
		Prefix:         prefix,
		PosX:           0,
		PosY:           posY,
		CreatedAt:      now,
		UpdatedAt:      now,
	}, nil
}

func (r *Repository) UpdateRoomRow(id int64, name string, sortOrder int, aisle string, prefix string) error {
	now := time.Now()
	_, err := r.db.Exec("UPDATE room_rows SET name = ?, sort_order = ?, aisle_direction = ?, prefix = ?, updated_at = ? WHERE id = ?",
		name, sortOrder, aisle, prefix, now, id)
	return err
}

func (r *Repository) UpdateRack(id int64, name string, totalU int, description string) error {
	now := time.Now()
	// 校验当前机柜内最大设备 U 位是否超出新的 totalU
	var maxU int
	_ = r.db.QueryRow("SELECT COALESCE(MAX(start_u + u_height - 1), 0) FROM devices WHERE rack_id = ?", id).Scan(&maxU)
	if totalU < maxU {
		return fmt.Errorf("cannot reduce total_u to %d: device occupying up to %dU exists", totalU, maxU)
	}
	_, err := r.db.Exec("UPDATE racks SET name = ?, total_u = ?, description = ?, updated_at = ? WHERE id = ?",
		name, totalU, description, now, id)
	return err
}

// Device methods
func (r *Repository) ListDevicesByRackID(rackID int64) ([]*model.Device, error) {
	query := `
		SELECT d.id, d.rack_id, d.start_u, d.u_height, d.type, d.sub_brand, d.name, d.hostname, d.asset_tag,
		       d.vendor, d.model, d.serial_number, d.mgmt_ip, d.bmc_ip, d.notes, d.owner, d.created_at, d.updated_at,
		       r.code, rr.name,
		       t.online_status, t.power_state, t.health_status, t.max_temp_c, t.inlet_temp_c,
		       t.cpu_model, t.cpu_count, t.memory_gb, t.disk_count, t.disk_health_summary,
		       t.firmware_version, t.os_info, t.last_collected_at, t.last_error
		FROM devices d
		JOIN racks r ON r.id = d.rack_id
		JOIN room_rows rr ON rr.id = r.row_id
		LEFT JOIN device_telemetry t ON t.device_id = d.id
		WHERE d.rack_id = ?
		ORDER BY d.start_u DESC
	`
	rows, err := r.db.Query(query, rackID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []*model.Device
	for rows.Next() {
		dev, err := scanDeviceRow(rows)
		if err != nil {
			return nil, err
		}
		devices = append(devices, dev)
	}
	return devices, nil
}

func (r *Repository) GetDeviceByID(id int64) (*model.Device, error) {
	query := `
		SELECT d.id, d.rack_id, d.start_u, d.u_height, d.type, d.sub_brand, d.name, d.hostname, d.asset_tag,
		       d.vendor, d.model, d.serial_number, d.mgmt_ip, d.bmc_ip, d.notes, d.owner, d.created_at, d.updated_at,
		       r.code, rr.name,
		       t.online_status, t.power_state, t.health_status, t.max_temp_c, t.inlet_temp_c,
		       t.cpu_model, t.cpu_count, t.memory_gb, t.disk_count, t.disk_health_summary,
		       t.firmware_version, t.os_info, t.last_collected_at, t.last_error
		FROM devices d
		JOIN racks r ON r.id = d.rack_id
		JOIN room_rows rr ON rr.id = r.row_id
		LEFT JOIN device_telemetry t ON t.device_id = d.id
		WHERE d.id = ?
	`
	row := r.db.QueryRow(query, id)
	dev, err := scanDeviceRow(row)
	if err != nil {
		return nil, err
	}

	cred, err := r.GetDeviceCredential(id)
	if err == nil {
		dev.Credential = cred
	}
	return dev, nil
}

type scannable interface {
	Scan(dest ...any) error
}

func scanDeviceRow(s scannable) (*model.Device, error) {
	dev := &model.Device{}
	tel := &model.DeviceTelemetry{}
	var (
		onlineStatus, powerState, healthStatus      sql.NullString
		maxTemp, inletTemp                          sql.NullFloat64
		cpuModel, diskHealth, fw, osInfo, lastError sql.NullString
		cpuCount, memGB, diskCount                  sql.NullInt64
		lastCollected                               sql.NullTime
	)

	err := s.Scan(
		&dev.ID, &dev.RackID, &dev.StartU, &dev.UHeight, &dev.Type, &dev.SubBrand, &dev.Name, &dev.Hostname, &dev.AssetTag,
		&dev.Vendor, &dev.Model, &dev.SerialNumber, &dev.MgmtIP, &dev.BmcIP, &dev.Notes, &dev.Owner, &dev.CreatedAt, &dev.UpdatedAt,
		&dev.RackCode, &dev.RowName,
		&onlineStatus, &powerState, &healthStatus, &maxTemp, &inletTemp,
		&cpuModel, &cpuCount, &memGB, &diskCount, &diskHealth,
		&fw, &osInfo, &lastCollected, &lastError,
	)
	if err != nil {
		return nil, err
	}

	tel.DeviceID = dev.ID
	tel.OnlineStatus = "unknown"
	if onlineStatus.Valid {
		tel.OnlineStatus = onlineStatus.String
	}
	tel.PowerState = "unknown"
	if powerState.Valid {
		tel.PowerState = powerState.String
	}
	tel.HealthStatus = "unknown"
	if healthStatus.Valid {
		tel.HealthStatus = healthStatus.String
	}
	if maxTemp.Valid {
		v := maxTemp.Float64
		tel.MaxTempC = &v
	}
	if inletTemp.Valid {
		v := inletTemp.Float64
		tel.InletTempC = &v
	}
	if cpuModel.Valid {
		tel.CPUModel = cpuModel.String
	}
	if cpuCount.Valid {
		tel.CPUCount = int(cpuCount.Int64)
	}
	if memGB.Valid {
		tel.MemoryGB = int(memGB.Int64)
	}
	if diskCount.Valid {
		tel.DiskCount = int(diskCount.Int64)
	}
	if diskHealth.Valid {
		tel.DiskHealthSummary = diskHealth.String
	}
	if fw.Valid {
		tel.FirmwareVersion = fw.String
	}
	if osInfo.Valid {
		tel.OSInfo = osInfo.String
	}
	if lastCollected.Valid {
		t := lastCollected.Time
		tel.LastCollectedAt = &t
	}
	if lastError.Valid {
		tel.LastError = lastError.String
	}

	dev.Telemetry = tel
	return dev, nil
}

func (r *Repository) CheckUConflict(rackID int64, startU, uHeight int, excludeDeviceID int64) error {
	if startU < 1 {
		return fmt.Errorf("start_u (%d) must be at least 1", startU)
	}
	var totalU int
	err := r.db.QueryRow("SELECT total_u FROM racks WHERE id = ?", rackID).Scan(&totalU)
	if err != nil {
		return fmt.Errorf("rack not found: %w", err)
	}
	endU := startU + uHeight - 1
	if endU > totalU {
		return fmt.Errorf("device U range [%d, %d] exceeds rack total U (%d)", startU, endU, totalU)
	}

	query := "SELECT id, name, start_u, u_height FROM devices WHERE rack_id = ? AND NOT (start_u + u_height - 1 < ? OR start_u > ?)"
	var rows *sql.Rows
	if excludeDeviceID > 0 {
		query += " AND id != ?"
		rows, err = r.db.Query(query, rackID, startU, endU, excludeDeviceID)
	} else {
		rows, err = r.db.Query(query, rackID, startU, endU)
	}
	if err != nil {
		return err
	}
	defer rows.Close()

	if rows.Next() {
		var conflictID int64
		var conflictName string
		var cStartU, cHeight int
		_ = rows.Scan(&conflictID, &conflictName, &cStartU, &cHeight)
		return fmt.Errorf("U space conflict with device '%s' (U%d~U%d)", conflictName, cStartU, cStartU+cHeight-1)
	}
	return nil
}

func (r *Repository) CreateDevice(dev *model.Device, cred *model.DeviceCredential) (*model.Device, error) {
	if err := r.CheckUConflict(dev.RackID, dev.StartU, dev.UHeight, 0); err != nil {
		return nil, err
	}

	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	now := time.Now()
	res, err := tx.Exec(`
		INSERT INTO devices (rack_id, start_u, u_height, type, sub_brand, name, hostname, asset_tag, vendor, model, serial_number, mgmt_ip, bmc_ip, notes, owner, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		dev.RackID, dev.StartU, dev.UHeight, dev.Type, dev.SubBrand, dev.Name, dev.Hostname, dev.AssetTag,
		dev.Vendor, dev.Model, dev.SerialNumber, dev.MgmtIP, dev.BmcIP, dev.Notes, dev.Owner, now, now)
	if err != nil {
		return nil, err
	}
	devID, _ := res.LastInsertId()
	dev.ID = devID
	dev.CreatedAt = now
	dev.UpdatedAt = now

	// 凭据处理
	if cred != nil {
		var bmcEnc, sshEnc string
		if cred.BmcPasswordMask != "" {
			bmcEnc, _ = crypto.Encrypt(cred.BmcPasswordMask, r.secretKey)
		}
		if cred.SSHSecretMask != "" {
			sshEnc, _ = crypto.Encrypt(cred.SSHSecretMask, r.secretKey)
		}
		_, err = tx.Exec(`
			INSERT INTO device_credentials (device_id, bmc_protocol, bmc_port, bmc_user, bmc_password_enc, bmc_insecure_tls, ssh_port, ssh_user, ssh_auth_type, ssh_secret_enc)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			devID, cred.BmcProtocol, cred.BmcPort, cred.BmcUser, bmcEnc, cred.BmcInsecureTLS,
			cred.SSHPort, cred.SSHUser, cred.SSHAuthType, sshEnc)
		if err != nil {
			return nil, err
		}
	}

	// 遥测初始行
	_, err = tx.Exec("INSERT INTO device_telemetry (device_id, online_status, power_state, health_status) VALUES (?, 'unknown', 'unknown', 'unknown')", devID)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return dev, nil
}

func (r *Repository) UpdateDevice(dev *model.Device, cred *model.DeviceCredential) error {
	if err := r.CheckUConflict(dev.RackID, dev.StartU, dev.UHeight, dev.ID); err != nil {
		return err
	}

	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	now := time.Now()
	_, err = tx.Exec(`
		UPDATE devices SET rack_id = ?, start_u = ?, u_height = ?, type = ?, sub_brand = ?, name = ?, hostname = ?,
		                   asset_tag = ?, vendor = ?, model = ?, serial_number = ?, mgmt_ip = ?, bmc_ip = ?, notes = ?, owner = ?, updated_at = ?
		WHERE id = ?`,
		dev.RackID, dev.StartU, dev.UHeight, dev.Type, dev.SubBrand, dev.Name, dev.Hostname,
		dev.AssetTag, dev.Vendor, dev.Model, dev.SerialNumber, dev.MgmtIP, dev.BmcIP, dev.Notes, dev.Owner, now, dev.ID)
	if err != nil {
		return err
	}

	if cred != nil {
		var existingBmcEnc, existingSSHEnc string
		_ = tx.QueryRow("SELECT bmc_password_enc, ssh_secret_enc FROM device_credentials WHERE device_id = ?", dev.ID).Scan(&existingBmcEnc, &existingSSHEnc)

		bmcEnc := existingBmcEnc
		if cred.BmcPasswordMask != "" {
			bmcEnc, _ = crypto.Encrypt(cred.BmcPasswordMask, r.secretKey)
		}
		sshEnc := existingSSHEnc
		if cred.SSHSecretMask != "" {
			sshEnc, _ = crypto.Encrypt(cred.SSHSecretMask, r.secretKey)
		}

		_, err = tx.Exec(`
			INSERT INTO device_credentials (device_id, bmc_protocol, bmc_port, bmc_user, bmc_password_enc, bmc_insecure_tls, ssh_port, ssh_user, ssh_auth_type, ssh_secret_enc)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(device_id) DO UPDATE SET
				bmc_protocol = excluded.bmc_protocol,
				bmc_port = excluded.bmc_port,
				bmc_user = excluded.bmc_user,
				bmc_password_enc = excluded.bmc_password_enc,
				bmc_insecure_tls = excluded.bmc_insecure_tls,
				ssh_port = excluded.ssh_port,
				ssh_user = excluded.ssh_user,
				ssh_auth_type = excluded.ssh_auth_type,
				ssh_secret_enc = excluded.ssh_secret_enc`,
			dev.ID, cred.BmcProtocol, cred.BmcPort, cred.BmcUser, bmcEnc, cred.BmcInsecureTLS,
			cred.SSHPort, cred.SSHUser, cred.SSHAuthType, sshEnc)
		if err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (r *Repository) DeleteDevice(id int64) error {
	_, err := r.db.Exec("DELETE FROM devices WHERE id = ?", id)
	return err
}

func (r *Repository) GetDeviceCredential(deviceID int64) (*model.DeviceCredential, error) {
	row := r.db.QueryRow(`
		SELECT device_id, bmc_protocol, bmc_port, bmc_user, bmc_password_enc, bmc_insecure_tls,
		       ssh_port, ssh_user, ssh_auth_type, ssh_secret_enc
		FROM device_credentials WHERE device_id = ?`, deviceID)
	c := &model.DeviceCredential{}
	var bmcEnc, sshEnc string
	err := row.Scan(&c.DeviceID, &c.BmcProtocol, &c.BmcPort, &c.BmcUser, &bmcEnc, &c.BmcInsecureTLS,
		&c.SSHPort, &c.SSHUser, &c.SSHAuthType, &sshEnc)
	if err != nil {
		return nil, err
	}
	c.BmcPasswordEnc = bmcEnc
	c.SSHSecretEnc = sshEnc
	if bmcEnc != "" {
		c.BmcPasswordMask = "******"
	}
	if sshEnc != "" {
		c.SSHSecretMask = "******"
	}
	return c, nil
}

func (r *Repository) GetDecryptedDeviceCredential(deviceID int64) (*model.DeviceCredential, string, string, error) {
	cred, err := r.GetDeviceCredential(deviceID)
	if err != nil {
		return nil, "", "", err
	}
	var bmcPass, sshSecret string
	if cred.BmcPasswordEnc != "" {
		bmcPass, _ = crypto.Decrypt(cred.BmcPasswordEnc, r.secretKey)
	}
	if cred.SSHSecretEnc != "" {
		sshSecret, _ = crypto.Decrypt(cred.SSHSecretEnc, r.secretKey)
	}
	return cred, bmcPass, sshSecret, nil
}

func (r *Repository) UpdateTelemetry(t *model.DeviceTelemetry) error {
	now := time.Now()
	_, err := r.db.Exec(`
		INSERT INTO device_telemetry (
			device_id, online_status, power_state, health_status, max_temp_c, inlet_temp_c,
			cpu_model, cpu_count, memory_gb, disk_count, disk_health_summary,
			firmware_version, os_info, raw_sensors_json, last_collected_at, last_error
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(device_id) DO UPDATE SET
			online_status = excluded.online_status,
			power_state = excluded.power_state,
			health_status = excluded.health_status,
			max_temp_c = excluded.max_temp_c,
			inlet_temp_c = excluded.inlet_temp_c,
			cpu_model = excluded.cpu_model,
			cpu_count = excluded.cpu_count,
			memory_gb = excluded.memory_gb,
			disk_count = excluded.disk_count,
			disk_health_summary = excluded.disk_health_summary,
			firmware_version = excluded.firmware_version,
			os_info = excluded.os_info,
			raw_sensors_json = excluded.raw_sensors_json,
			last_collected_at = excluded.last_collected_at,
			last_error = excluded.last_error`,
		t.DeviceID, t.OnlineStatus, t.PowerState, t.HealthStatus, t.MaxTempC, t.InletTempC,
		t.CPUModel, t.CPUCount, t.MemoryGB, t.DiskCount, t.DiskHealthSummary,
		t.FirmwareVersion, t.OSInfo, t.RawSensorsJSON, now, t.LastError)
	return err
}

func (r *Repository) ListAllDevices() ([]*model.Device, error) {
	query := `
		SELECT d.id, d.rack_id, d.start_u, d.u_height, d.type, d.sub_brand, d.name, d.hostname, d.asset_tag,
		       d.vendor, d.model, d.serial_number, d.mgmt_ip, d.bmc_ip, d.notes, d.owner, d.created_at, d.updated_at,
		       r.code, rr.name,
		       t.online_status, t.power_state, t.health_status, t.max_temp_c, t.inlet_temp_c,
		       t.cpu_model, t.cpu_count, t.memory_gb, t.disk_count, t.disk_health_summary,
		       t.firmware_version, t.os_info, t.last_collected_at, t.last_error
		FROM devices d
		JOIN racks r ON r.id = d.rack_id
		JOIN room_rows rr ON rr.id = r.row_id
		LEFT JOIN device_telemetry t ON t.device_id = d.id
		ORDER BY rr.sort_order ASC, r.col_index ASC, d.start_u DESC
	`
	rows, err := r.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []*model.Device
	for rows.Next() {
		dev, err := scanDeviceRow(rows)
		if err != nil {
			return nil, err
		}
		devices = append(devices, dev)
	}
	return devices, nil
}

func (r *Repository) SearchDevices(query string) ([]*model.Device, error) {
	wildcard := "%" + query + "%"
	sqlText := `
		SELECT d.id, d.rack_id, d.start_u, d.u_height, d.type, d.sub_brand, d.name, d.hostname, d.asset_tag,
		       d.vendor, d.model, d.serial_number, d.mgmt_ip, d.bmc_ip, d.notes, d.owner, d.created_at, d.updated_at,
		       r.code, rr.name,
		       t.online_status, t.power_state, t.health_status, t.max_temp_c, t.inlet_temp_c,
		       t.cpu_model, t.cpu_count, t.memory_gb, t.disk_count, t.disk_health_summary,
		       t.firmware_version, t.os_info, t.last_collected_at, t.last_error
		FROM devices d
		JOIN racks r ON r.id = d.rack_id
		JOIN room_rows rr ON rr.id = r.row_id
		LEFT JOIN device_telemetry t ON t.device_id = d.id
		WHERE d.name LIKE ? OR d.hostname LIKE ? OR d.asset_tag LIKE ? OR d.mgmt_ip LIKE ?
		   OR d.bmc_ip LIKE ? OR d.vendor LIKE ? OR d.model LIKE ? OR d.serial_number LIKE ?
		   OR r.code LIKE ? OR rr.name LIKE ?
		ORDER BY d.id DESC LIMIT 50
	`
	rows, err := r.db.Query(sqlText, wildcard, wildcard, wildcard, wildcard, wildcard, wildcard, wildcard, wildcard, wildcard, wildcard)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []*model.Device
	for rows.Next() {
		dev, err := scanDeviceRow(rows)
		if err != nil {
			return nil, err
		}
		devices = append(devices, dev)
	}
	return devices, nil
}

// Audit Logs
func (r *Repository) InsertAuditLog(log *model.AuditLog) error {
	now := time.Now()
	_, err := r.db.Exec(`
		INSERT INTO audit_logs (user_id, username, role, action, target_type, target_id, target_name, detail_json, client_ip, status, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		log.UserID, log.Username, log.Role, log.Action, log.TargetType, log.TargetID, log.TargetName, log.DetailJSON, log.ClientIP, log.Status, now)
	return err
}

func (r *Repository) ListAuditLogs(limit, offset int) ([]*model.AuditLog, int, error) {
	if limit <= 0 {
		limit = 50
	}
	var total int
	_ = r.db.QueryRow("SELECT COUNT(*) FROM audit_logs").Scan(&total)

	rows, err := r.db.Query("SELECT id, user_id, username, role, action, target_type, target_id, target_name, detail_json, client_ip, status, created_at FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?", limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var logs []*model.AuditLog
	for rows.Next() {
		l := &model.AuditLog{}
		if err := rows.Scan(&l.ID, &l.UserID, &l.Username, &l.Role, &l.Action, &l.TargetType, &l.TargetID, &l.TargetName, &l.DetailJSON, &l.ClientIP, &l.Status, &l.CreatedAt); err != nil {
			return nil, 0, err
		}
		logs = append(logs, l)
	}
	return logs, total, nil
}

// ---- 拓扑布局：位置、机柜增删、快照与撤销恢复 ----

// RackSpacing 机排内相邻机柜的横向间距（单位：机柜格）
const RackSpacing = 1.0

type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func (r *Repository) GetRowByID(id int64) (*model.RoomRow, error) {
	row := r.db.QueryRow("SELECT id, name, sort_order, rack_count, default_u_height, aisle_direction, prefix, pos_x, pos_y, created_at, updated_at FROM room_rows WHERE id = ?", id)
	rr := &model.RoomRow{}
	err := row.Scan(&rr.ID, &rr.Name, &rr.SortOrder, &rr.RackCount, &rr.DefaultUHeight, &rr.AisleDirection, &rr.Prefix, &rr.PosX, &rr.PosY, &rr.CreatedAt, &rr.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return rr, nil
}

// GetRowDetail 返回机排及其全部机柜、设备与遥测（机排视角使用）
func (r *Repository) GetRowDetail(id int64) (*model.RoomRow, error) {
	rr, err := r.GetRowByID(id)
	if err != nil {
		return nil, err
	}
	racks, err := r.ListRacksByRowID(id)
	if err != nil {
		return nil, err
	}
	for _, rk := range racks {
		devs, err := r.ListDevicesByRackID(rk.ID)
		if err == nil {
			rk.Devices = devs
		}
	}
	rr.Racks = racks
	return rr, nil
}

func (r *Repository) UpdateRowPosition(id int64, x, y float64) error {
	_, err := r.db.Exec("UPDATE room_rows SET pos_x = ?, pos_y = ?, updated_at = ? WHERE id = ?", x, y, time.Now(), id)
	return err
}

func (r *Repository) UpdateRackPosition(id int64, x, y float64) error {
	_, err := r.db.Exec("UPDATE racks SET rel_x = ?, rel_y = ?, updated_at = ? WHERE id = ?", x, y, time.Now(), id)
	return err
}

// CreateRack 在指定机排末尾追加一个机柜
func (r *Repository) CreateRack(rowID int64, totalU int) (*model.Rack, error) {
	rr, err := r.GetRowByID(rowID)
	if err != nil {
		return nil, fmt.Errorf("机排不存在: %w", err)
	}
	var maxCol int
	_ = r.db.QueryRow("SELECT COALESCE(MAX(col_index), 0) FROM racks WHERE row_id = ?", rowID).Scan(&maxCol)
	col := maxCol + 1
	code := fmt.Sprintf("%s%02d", rr.Prefix, col)
	for {
		var n int
		_ = r.db.QueryRow("SELECT COUNT(*) FROM racks WHERE code = ?", code).Scan(&n)
		if n == 0 {
			break
		}
		col++
		code = fmt.Sprintf("%s%02d", rr.Prefix, col)
	}
	var maxRelX float64
	_ = r.db.QueryRow("SELECT COALESCE(MAX(rel_x), -?) FROM racks WHERE row_id = ?", RackSpacing, rowID).Scan(&maxRelX)
	relX := maxRelX + RackSpacing
	if totalU <= 0 {
		totalU = rr.DefaultUHeight
	}
	if totalU <= 0 {
		totalU = 42
	}
	now := time.Now()
	name := fmt.Sprintf("%s-%02d", rr.Name, col)
	res, err := r.db.Exec("INSERT INTO racks (row_id, col_index, code, name, total_u, description, rel_x, rel_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', ?, 0, ?, ?)",
		rowID, col, code, name, totalU, relX, now, now)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	_, _ = r.db.Exec("UPDATE room_rows SET rack_count = (SELECT COUNT(*) FROM racks WHERE row_id = ?), updated_at = ? WHERE id = ?", rowID, now, rowID)
	return &model.Rack{
		ID: id, RowID: rowID, ColIndex: col, Code: code, Name: name,
		TotalU: totalU, RelX: relX, RelY: 0, CreatedAt: now, UpdatedAt: now,
	}, nil
}

func (r *Repository) deleteRackCascade(ex execer, rackID int64) error {
	if _, err := ex.Exec("DELETE FROM device_credentials WHERE device_id IN (SELECT id FROM devices WHERE rack_id = ?)", rackID); err != nil {
		return err
	}
	if _, err := ex.Exec("DELETE FROM device_telemetry WHERE device_id IN (SELECT id FROM devices WHERE rack_id = ?)", rackID); err != nil {
		return err
	}
	if _, err := ex.Exec("DELETE FROM devices WHERE rack_id = ?", rackID); err != nil {
		return err
	}
	_, err := ex.Exec("DELETE FROM racks WHERE id = ?", rackID)
	return err
}

func (r *Repository) DeleteRack(id int64) error {
	var rowID int64
	_ = r.db.QueryRow("SELECT row_id FROM racks WHERE id = ?", id).Scan(&rowID)
	if err := r.deleteRackCascade(r.db, id); err != nil {
		return err
	}
	if rowID > 0 {
		now := time.Now()
		_, _ = r.db.Exec("UPDATE room_rows SET rack_count = (SELECT COUNT(*) FROM racks WHERE row_id = ?), updated_at = ? WHERE id = ?", rowID, now, rowID)
	}
	return nil
}

func (r *Repository) DeleteRoomRow(id int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query("SELECT id FROM racks WHERE row_id = ?", id)
	if err != nil {
		return err
	}
	var rackIDs []int64
	for rows.Next() {
		var rid int64
		if err := rows.Scan(&rid); err == nil {
			rackIDs = append(rackIDs, rid)
		}
	}
	rows.Close()
	for _, rid := range rackIDs {
		if err := r.deleteRackCascade(tx, rid); err != nil {
			return err
		}
	}
	if _, err := tx.Exec("DELETE FROM room_rows WHERE id = ?", id); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repository) getRackBasic(rackID int64) (*model.Rack, error) {
	row := r.db.QueryRow("SELECT id, row_id, col_index, code, name, total_u, description, rel_x, rel_y, created_at, updated_at FROM racks WHERE id = ?", rackID)
	rk := &model.Rack{}
	err := row.Scan(&rk.ID, &rk.RowID, &rk.ColIndex, &rk.Code, &rk.Name, &rk.TotalU, &rk.Description, &rk.RelX, &rk.RelY, &rk.CreatedAt, &rk.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return rk, nil
}

// SnapshotRack 生成机柜完整快照（含设备、凭据密文、遥测），用于删除后撤销
func (r *Repository) SnapshotRack(rackID int64) (*model.RackSnapshot, error) {
	rk, err := r.getRackBasic(rackID)
	if err != nil {
		return nil, err
	}
	devs, err := r.ListDevicesByRackID(rackID)
	if err != nil {
		return nil, err
	}
	snap := &model.RackSnapshot{Rack: rk, Devices: []*model.DeviceSnapshot{}}
	for _, d := range devs {
		ds := &model.DeviceSnapshot{Device: d, Telemetry: d.Telemetry}
		cred, err := r.GetDeviceCredential(d.ID)
		if err == nil {
			ds.Credential = cred
			ds.BmcPasswordEnc = cred.BmcPasswordEnc
			ds.SSHSecretEnc = cred.SSHSecretEnc
		}
		d.Credential = nil
		snap.Devices = append(snap.Devices, ds)
	}
	return snap, nil
}

func (r *Repository) restoreRackTx(tx *sql.Tx, snap *model.RackSnapshot, rowID int64) (*model.Rack, error) {
	if snap == nil || snap.Rack == nil {
		return nil, errors.New("空的机柜快照")
	}
	rk := snap.Rack
	var n int
	_ = tx.QueryRow("SELECT COUNT(*) FROM racks WHERE code = ?", rk.Code).Scan(&n)
	if n > 0 {
		return nil, fmt.Errorf("机柜编号 %s 已存在，无法恢复", rk.Code)
	}
	now := time.Now()
	res, err := tx.Exec("INSERT INTO racks (row_id, col_index, code, name, total_u, description, rel_x, rel_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		rowID, rk.ColIndex, rk.Code, rk.Name, rk.TotalU, rk.Description, rk.RelX, rk.RelY, now, now)
	if err != nil {
		return nil, err
	}
	newID, _ := res.LastInsertId()

	for _, ds := range snap.Devices {
		if ds == nil || ds.Device == nil {
			continue
		}
		d := ds.Device
		dres, err := tx.Exec(`INSERT INTO devices (rack_id, start_u, u_height, type, sub_brand, name, hostname, asset_tag, vendor, model, serial_number, mgmt_ip, bmc_ip, notes, owner, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			newID, d.StartU, d.UHeight, d.Type, d.SubBrand, d.Name, d.Hostname, d.AssetTag,
			d.Vendor, d.Model, d.SerialNumber, d.MgmtIP, d.BmcIP, d.Notes, d.Owner, now, now)
		if err != nil {
			return nil, err
		}
		devID, _ := dres.LastInsertId()

		if ds.Credential != nil {
			c := ds.Credential
			_, err = tx.Exec(`INSERT INTO device_credentials (device_id, bmc_protocol, bmc_port, bmc_user, bmc_password_enc, bmc_insecure_tls, ssh_port, ssh_user, ssh_auth_type, ssh_secret_enc)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				devID, c.BmcProtocol, c.BmcPort, c.BmcUser, ds.BmcPasswordEnc, c.BmcInsecureTLS,
				c.SSHPort, c.SSHUser, c.SSHAuthType, ds.SSHSecretEnc)
			if err != nil {
				return nil, err
			}
		}
		if ds.Telemetry != nil {
			t := ds.Telemetry
			_, err = tx.Exec(`INSERT INTO device_telemetry (device_id, online_status, power_state, health_status, max_temp_c, inlet_temp_c, cpu_model, cpu_count, memory_gb, disk_count, disk_health_summary, firmware_version, os_info, raw_sensors_json, last_collected_at, last_error)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				devID, t.OnlineStatus, t.PowerState, t.HealthStatus, t.MaxTempC, t.InletTempC,
				t.CPUModel, t.CPUCount, t.MemoryGB, t.DiskCount, t.DiskHealthSummary,
				t.FirmwareVersion, t.OSInfo, t.RawSensorsJSON, t.LastCollectedAt, t.LastError)
			if err != nil {
				return nil, err
			}
		}
	}
	return &model.Rack{
		ID: newID, RowID: rowID, ColIndex: rk.ColIndex, Code: rk.Code, Name: rk.Name,
		TotalU: rk.TotalU, Description: rk.Description, RelX: rk.RelX, RelY: rk.RelY,
		CreatedAt: now, UpdatedAt: now,
	}, nil
}

func (r *Repository) RestoreRack(snap *model.RackSnapshot) (*model.Rack, error) {
	if snap == nil || snap.Rack == nil {
		return nil, errors.New("空的机柜快照")
	}
	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rk, err := r.restoreRackTx(tx, snap, snap.Rack.RowID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	now := time.Now()
	_, _ = r.db.Exec("UPDATE room_rows SET rack_count = (SELECT COUNT(*) FROM racks WHERE row_id = ?), updated_at = ? WHERE id = ?", rk.RowID, now, rk.RowID)
	return rk, nil
}

func (r *Repository) SnapshotRow(rowID int64) (*model.RowSnapshot, error) {
	rr, err := r.GetRowByID(rowID)
	if err != nil {
		return nil, err
	}
	racks, err := r.ListRacksByRowID(rowID)
	if err != nil {
		return nil, err
	}
	snap := &model.RowSnapshot{Row: rr, Racks: []*model.RackSnapshot{}}
	for _, rk := range racks {
		rs, err := r.SnapshotRack(rk.ID)
		if err == nil {
			snap.Racks = append(snap.Racks, rs)
		}
	}
	return snap, nil
}

func (r *Repository) RestoreRow(snap *model.RowSnapshot) (*model.RoomRow, error) {
	if snap == nil || snap.Row == nil {
		return nil, errors.New("空的机排快照")
	}
	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rr := snap.Row
	now := time.Now()
	res, err := tx.Exec("INSERT INTO room_rows (name, sort_order, rack_count, default_u_height, aisle_direction, prefix, pos_x, pos_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		rr.Name, rr.SortOrder, len(snap.Racks), rr.DefaultUHeight, rr.AisleDirection, rr.Prefix, rr.PosX, rr.PosY, now, now)
	if err != nil {
		return nil, err
	}
	newRowID, _ := res.LastInsertId()
	for _, rs := range snap.Racks {
		if _, err := r.restoreRackTx(tx, rs, newRowID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return r.GetRowByID(newRowID)
}

// ---- 布局批量保存（编辑模式：保存修改） ----

type LayoutRowPos struct {
	ID   int64   `json:"id"`
	PosX float64 `json:"pos_x"`
	PosY float64 `json:"pos_y"`
}

type LayoutRackPos struct {
	ID   int64   `json:"id"`
	RelX float64 `json:"rel_x"`
	RelY float64 `json:"rel_y"`
}

type LayoutRackCreate struct {
	RowID  int64   `json:"row_id"`
	TotalU int     `json:"total_u"`
	RelX   float64 `json:"rel_x"`
	RelY   float64 `json:"rel_y"`
}

type LayoutRackPlace struct {
	RelX float64 `json:"rel_x"`
	RelY float64 `json:"rel_y"`
}

type LayoutRowCreate struct {
	Name      string            `json:"name"`
	Prefix    string            `json:"prefix"`
	Aisle     string            `json:"aisle_direction"`
	DefaultU  int               `json:"default_u_height"`
	SortOrder int               `json:"sort_order"`
	PosX      float64           `json:"pos_x"`
	PosY      float64           `json:"pos_y"`
	Racks     []LayoutRackPlace `json:"racks"`
}

type LayoutApply struct {
	RowPositions  []LayoutRowPos     `json:"row_positions"`
	RackPositions []LayoutRackPos    `json:"rack_positions"`
	RackCreates   []LayoutRackCreate `json:"rack_creates"`
	RowCreates    []LayoutRowCreate  `json:"row_creates"`
	RackDeletes   []int64            `json:"rack_deletes"`
	RowDeletes    []int64            `json:"row_deletes"`
}

func (a LayoutApply) IsEmpty() bool {
	return len(a.RowPositions) == 0 && len(a.RackPositions) == 0 && len(a.RackCreates) == 0 &&
		len(a.RowCreates) == 0 && len(a.RackDeletes) == 0 && len(a.RowDeletes) == 0
}

func (r *Repository) deleteRoomRowTx(tx *sql.Tx, rowID int64) error {
	rows, err := tx.Query("SELECT id FROM racks WHERE row_id = ?", rowID)
	if err != nil {
		return err
	}
	var rackIDs []int64
	for rows.Next() {
		var rid int64
		if err := rows.Scan(&rid); err == nil {
			rackIDs = append(rackIDs, rid)
		}
	}
	rows.Close()
	for _, rid := range rackIDs {
		if err := r.deleteRackCascade(tx, rid); err != nil {
			return err
		}
	}
	_, err = tx.Exec("DELETE FROM room_rows WHERE id = ?", rowID)
	return err
}

func rackCodeTx(tx *sql.Tx, prefix string, startCol int) (string, int) {
	col := startCol
	for {
		code := fmt.Sprintf("%s%02d", prefix, col)
		var n int
		_ = tx.QueryRow("SELECT COUNT(*) FROM racks WHERE code = ?", code).Scan(&n)
		if n == 0 {
			return code, col
		}
		col++
	}
}

// ApplyLayout 在单个事务中应用编辑模式的全部变更，避免分批提交产生中间态。
func (r *Repository) ApplyLayout(a LayoutApply) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	now := time.Now()

	// 1) 删除机排（级联机柜与设备）
	for _, id := range a.RowDeletes {
		if err := r.deleteRoomRowTx(tx, id); err != nil {
			return err
		}
	}

	// 2) 删除机柜
	for _, id := range a.RackDeletes {
		if err := r.deleteRackCascade(tx, id); err != nil {
			return err
		}
	}

	// 3) 新建机排（含新建机柜）
	for _, rc := range a.RowCreates {
		if rc.DefaultU <= 0 {
			rc.DefaultU = 42
		}
		if rc.Aisle == "" {
			rc.Aisle = "cold"
		}
		res, err := tx.Exec(`INSERT INTO room_rows (name, sort_order, rack_count, default_u_height, aisle_direction, prefix, pos_x, pos_y, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			rc.Name, rc.SortOrder, len(rc.Racks), rc.DefaultU, rc.Aisle, rc.Prefix, rc.PosX, rc.PosY, now, now)
		if err != nil {
			return err
		}
		rowID, _ := res.LastInsertId()
		for i, rp := range rc.Racks {
			code, col := rackCodeTx(tx, rc.Prefix, i+1)
			name := fmt.Sprintf("%s-%02d", rc.Name, col)
			_, err := tx.Exec(`INSERT INTO racks (row_id, col_index, code, name, total_u, description, rel_x, rel_y, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)`,
				rowID, col, code, name, rc.DefaultU, rp.RelX, rp.RelY, now, now)
			if err != nil {
				return err
			}
		}
	}

	// 4) 新建机柜（挂到已有机排）
	for _, rc := range a.RackCreates {
		var prefix, rowName string
		var defU int
		if err := tx.QueryRow("SELECT prefix, name, default_u_height FROM room_rows WHERE id = ?", rc.RowID).Scan(&prefix, &rowName, &defU); err != nil {
			return fmt.Errorf("机排 %d 不存在: %w", rc.RowID, err)
		}
		var maxCol int
		_ = tx.QueryRow("SELECT COALESCE(MAX(col_index), 0) FROM racks WHERE row_id = ?", rc.RowID).Scan(&maxCol)
		code, col := rackCodeTx(tx, prefix, maxCol+1)
		totalU := rc.TotalU
		if totalU <= 0 {
			totalU = defU
		}
		name := fmt.Sprintf("%s-%02d", rowName, col)
		if _, err := tx.Exec(`INSERT INTO racks (row_id, col_index, code, name, total_u, description, rel_x, rel_y, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)`,
			rc.RowID, col, code, name, totalU, rc.RelX, rc.RelY, now, now); err != nil {
			return err
		}
	}

	// 5) 位置更新
	for _, p := range a.RowPositions {
		_, _ = tx.Exec("UPDATE room_rows SET pos_x = ?, pos_y = ?, updated_at = ? WHERE id = ?", p.PosX, p.PosY, now, p.ID)
	}
	for _, p := range a.RackPositions {
		_, _ = tx.Exec("UPDATE racks SET rel_x = ?, rel_y = ?, updated_at = ? WHERE id = ?", p.RelX, p.RelY, now, p.ID)
	}

	// 6) 同步机柜数量
	if _, err := tx.Exec("UPDATE room_rows SET rack_count = (SELECT COUNT(*) FROM racks WHERE row_id = room_rows.id)"); err != nil {
		return err
	}

	return tx.Commit()
}
