package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/LanceHE6/rackops/internal/audit"
	"github.com/LanceHE6/rackops/internal/auth"
	"github.com/LanceHE6/rackops/internal/collector"
	"github.com/LanceHE6/rackops/internal/console"
	"github.com/LanceHE6/rackops/internal/crypto"
	"github.com/LanceHE6/rackops/internal/model"
	"github.com/LanceHE6/rackops/internal/repository"
)

type undoEntry struct {
	kind    string // rack / row
	rack    *model.RackSnapshot
	row     *model.RowSnapshot
	expires time.Time
}

type Server struct {
	repo      *repository.Repository
	auditor   *audit.Auditor
	engine    *collector.Engine
	console   *console.ConsoleService
	jwtSecret []byte

	undoMu    sync.Mutex
	undoStore map[string]undoEntry
}

func NewServer(repo *repository.Repository, auditor *audit.Auditor, engine *collector.Engine, cs *console.ConsoleService, jwtSecret []byte) *Server {
	return &Server{
		repo:      repo,
		auditor:   auditor,
		engine:    engine,
		console:   cs,
		jwtSecret: jwtSecret,
		undoStore: make(map[string]undoEntry),
	}
}

// storeUndo 将删除快照暂存在服务端（10 分钟有效），返回撤销令牌。
// 快照含凭据密文，不下发到浏览器，撤销时凭令牌取回。
func (s *Server) storeUndo(kind string, rack *model.RackSnapshot, row *model.RowSnapshot) string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	token := hex.EncodeToString(buf)

	s.undoMu.Lock()
	defer s.undoMu.Unlock()
	now := time.Now()
	for k, e := range s.undoStore {
		if now.After(e.expires) {
			delete(s.undoStore, k)
		}
	}
	s.undoStore[token] = undoEntry{kind: kind, rack: rack, row: row, expires: now.Add(10 * time.Minute)}
	return token
}

func (s *Server) takeUndo(token, kind string) (undoEntry, bool) {
	s.undoMu.Lock()
	defer s.undoMu.Unlock()
	e, ok := s.undoStore[token]
	if !ok || e.kind != kind || time.Now().After(e.expires) {
		return undoEntry{}, false
	}
	delete(s.undoStore, token)
	return e, true
}

func (s *Server) requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	claims := auth.GetUserClaims(r)
	if claims == nil || claims.Role != model.RoleAdmin {
		writeError(w, http.StatusForbidden, "需要管理员权限")
		return false
	}
	return true
}

func (s *Server) RegisterRoutes(mux *http.ServeMux) {
	// 公开路由
	mux.HandleFunc("/api/v1/auth/login", s.handleLogin)

	// 需要鉴权的路由包裹
	authWrapper := auth.AuthMiddleware(s.jwtSecret)

	mux.Handle("/api/v1/auth/me", authWrapper(http.HandlerFunc(s.handleMe)))
	mux.Handle("/api/v1/auth/change-password", authWrapper(http.HandlerFunc(s.handleChangePassword)))

	// 拓扑相关
	mux.Handle("/api/v1/topology/rows", authWrapper(http.HandlerFunc(s.handleRows)))
	mux.Handle("/api/v1/topology/rows/", authWrapper(http.HandlerFunc(s.handleRowDetail)))
	mux.Handle("/api/v1/topology/racks/", authWrapper(http.HandlerFunc(s.handleRackDetail)))
	mux.Handle("/api/v1/topology/layout/apply", authWrapper(http.HandlerFunc(s.handleLayoutApply)))

	// 设备管理
	mux.Handle("/api/v1/devices", authWrapper(http.HandlerFunc(s.handleDevices)))
	mux.Handle("/api/v1/devices/", authWrapper(http.HandlerFunc(s.handleDeviceDetail)))
	mux.Handle("/api/v1/devices/search", authWrapper(http.HandlerFunc(s.handleSearchDevices)))
	mux.Handle("/api/v1/devices/collect", authWrapper(http.HandlerFunc(s.handleTriggerCollect)))

	// 控制台 WebSocket & BMC 反代
	mux.Handle("/api/v1/console/webssh", authWrapper(http.HandlerFunc(s.console.HandleWebSSH)))
	mux.Handle("/api/v1/console/ipmisol", authWrapper(http.HandlerFunc(s.console.HandleIPMISOL)))
	mux.Handle("/api/v1/console/bmc-proxy/", authWrapper(http.HandlerFunc(s.console.HandleBMCProxy)))

	// 审计日志
	mux.Handle("/api/v1/audit-logs", authWrapper(http.HandlerFunc(s.handleListAuditLogs)))

	// 用户管理 (仅管理员)
	adminWrapper := auth.RequireRole(model.RoleAdmin)
	mux.Handle("/api/v1/users", authWrapper(adminWrapper(http.HandlerFunc(s.handleUsers))))
	mux.Handle("/api/v1/users/", authWrapper(adminWrapper(http.HandlerFunc(s.handleUserDetail))))
}

// 统一 JSON 返回工具
func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// Auth Handlers
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	user, err := s.repo.GetUserByUsername(req.Username)
	if err != nil || !crypto.CheckPassword(req.Password, user.PasswordHash) {
		s.auditor.Log(r, "login", "user", 0, req.Username, map[string]string{"reason": "wrong credentials"}, "failure")
		writeError(w, http.StatusUnauthorized, "用户名或密码错误")
		return
	}
	if !user.Enabled {
		writeError(w, http.StatusForbidden, "账号已被禁用")
		return
	}

	token, err := auth.GenerateToken(user, s.jwtSecret, 24*time.Hour)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "rackops_token",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   86400,
	})

	s.auditor.Log(r, "login", "user", user.ID, user.Username, nil, "success")
	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"user":  user,
	})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetUserClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	user, err := s.repo.GetUserByID(claims.UserID)
	if err != nil {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	claims := auth.GetUserClaims(r)
	var req struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	user, _ := s.repo.GetUserByID(claims.UserID)
	if !crypto.CheckPassword(req.OldPassword, user.PasswordHash) {
		writeError(w, http.StatusBadRequest, "旧密码错误")
		return
	}
	_ = s.repo.UpdateUser(user.ID, user.Role, user.Enabled, req.NewPassword)
	s.auditor.Log(r, "change_password", "user", user.ID, user.Username, nil, "success")
	writeJSON(w, http.StatusOK, map[string]string{"message": "密码修改成功"})
}

// Topology Handlers
func (s *Server) handleRows(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, err := s.repo.ListRoomRows()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, rows)
	case http.MethodPost:
		claims := auth.GetUserClaims(r)
		if claims.Role != model.RoleAdmin {
			writeError(w, http.StatusForbidden, "admin required")
			return
		}
		var req struct {
			Name           string `json:"name"`
			SortOrder      int    `json:"sort_order"`
			RackCount      int    `json:"rack_count"`
			DefaultUHeight int    `json:"default_u_height"`
			AisleDirection string `json:"aisle_direction"`
			Prefix         string `json:"prefix"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid body")
			return
		}
		row, err := s.repo.CreateRoomRow(req.Name, req.SortOrder, req.RackCount, req.DefaultUHeight, req.AisleDirection, req.Prefix)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.auditor.Log(r, "row_create", "row", row.ID, row.Name, req, "success")
		writeJSON(w, http.StatusCreated, row)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleLayoutApply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	var req repository.LayoutApply
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}
	if req.IsEmpty() {
		writeJSON(w, http.StatusOK, map[string]string{"message": "nothing to apply"})
		return
	}
	if err := s.repo.ApplyLayout(req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditor.Log(r, "layout_apply", "topology", 0, "room", req, "success")
	rows, err := s.repo.ListRoomRows()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"message": "布局已保存", "rows": rows})
}

func (s *Server) handleRowDetail(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/topology/rows/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusBadRequest, "invalid row path")
		return
	}
	if parts[0] == "restore" {
		s.handleRowRestore(w, r)
		return
	}
	rowID, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid row id")
		return
	}

	if len(parts) > 1 {
		switch parts[1] {
		case "position":
			s.handleRowPosition(w, r, rowID)
		case "racks":
			s.handleRowRacks(w, r, rowID)
		default:
			writeError(w, http.StatusNotFound, "unknown row subpath")
		}
		return
	}

	switch r.Method {
	case http.MethodGet:
		row, err := s.repo.GetRowDetail(rowID)
		if err != nil {
			writeError(w, http.StatusNotFound, "机排不存在")
			return
		}
		writeJSON(w, http.StatusOK, row)
	case http.MethodPut:
		if !s.requireAdmin(w, r) {
			return
		}
		var req struct {
			Name           string `json:"name"`
			SortOrder      int    `json:"sort_order"`
			AisleDirection string `json:"aisle_direction"`
			Prefix         string `json:"prefix"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid body")
			return
		}
		if err := s.repo.UpdateRoomRow(rowID, req.Name, req.SortOrder, req.AisleDirection, req.Prefix); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.auditor.Log(r, "row_update", "row", rowID, req.Name, req, "success")
		writeJSON(w, http.StatusOK, map[string]string{"message": "updated"})
	case http.MethodDelete:
		if !s.requireAdmin(w, r) {
			return
		}
		snap, err := s.repo.SnapshotRow(rowID)
		if err != nil {
			writeError(w, http.StatusNotFound, "机排不存在")
			return
		}
		if err := s.repo.DeleteRoomRow(rowID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		token := s.storeUndo("row", nil, snap)
		s.auditor.Log(r, "row_delete", "row", rowID, snap.Row.Name, nil, "success")
		writeJSON(w, http.StatusOK, map[string]any{
			"message":    "deleted",
			"undo_token": token,
			"label":      snap.Row.Name,
		})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleRowPosition(w http.ResponseWriter, r *http.Request, rowID int64) {
	if r.Method != http.MethodPut {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	var req struct {
		PosX float64 `json:"pos_x"`
		PosY float64 `json:"pos_y"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := s.repo.UpdateRowPosition(rowID, req.PosX, req.PosY); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.auditor.Log(r, "row_position", "row", rowID, "", req, "success")
	writeJSON(w, http.StatusOK, map[string]string{"message": "position updated"})
}

func (s *Server) handleRowRacks(w http.ResponseWriter, r *http.Request, rowID int64) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	var req struct {
		TotalU int `json:"total_u"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	rack, err := s.repo.CreateRack(rowID, req.TotalU)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditor.Log(r, "rack_create", "rack", rack.ID, rack.Code, req, "success")
	writeJSON(w, http.StatusCreated, rack)
}

func (s *Server) handleRowRestore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	var req struct {
		UndoToken string `json:"undo_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	entry, ok := s.takeUndo(req.UndoToken, "row")
	if !ok {
		writeError(w, http.StatusGone, "撤销已过期或无效")
		return
	}
	row, err := s.repo.RestoreRow(entry.row)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditor.Log(r, "row_restore", "row", row.ID, row.Name, nil, "success")
	writeJSON(w, http.StatusOK, row)
}

func (s *Server) handleRackDetail(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/topology/racks/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusBadRequest, "invalid rack path")
		return
	}
	if parts[0] == "restore" {
		s.handleRackRestore(w, r)
		return
	}
	rackID, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid rack id")
		return
	}

	if len(parts) > 1 && parts[1] == "position" {
		s.handleRackPosition(w, r, rackID)
		return
	}

	switch r.Method {
	case http.MethodGet:
		rack, err := s.repo.GetRackByID(rackID)
		if err != nil {
			writeError(w, http.StatusNotFound, "rack not found")
			return
		}
		writeJSON(w, http.StatusOK, rack)
	case http.MethodPut:
		if !s.requireAdmin(w, r) {
			return
		}
		var req struct {
			Name        string `json:"name"`
			TotalU      int    `json:"total_u"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid body")
			return
		}
		if err := s.repo.UpdateRack(rackID, req.Name, req.TotalU, req.Description); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.auditor.Log(r, "rack_update", "rack", rackID, req.Name, req, "success")
		writeJSON(w, http.StatusOK, map[string]string{"message": "updated"})
	case http.MethodDelete:
		if !s.requireAdmin(w, r) {
			return
		}
		snap, err := s.repo.SnapshotRack(rackID)
		if err != nil {
			writeError(w, http.StatusNotFound, "机柜不存在")
			return
		}
		if err := s.repo.DeleteRack(rackID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		token := s.storeUndo("rack", snap, nil)
		s.auditor.Log(r, "rack_delete", "rack", rackID, snap.Rack.Code, nil, "success")
		writeJSON(w, http.StatusOK, map[string]any{
			"message":    "deleted",
			"undo_token": token,
			"label":      snap.Rack.Code,
		})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleRackPosition(w http.ResponseWriter, r *http.Request, rackID int64) {
	if r.Method != http.MethodPut {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	var req struct {
		RelX float64 `json:"rel_x"`
		RelY float64 `json:"rel_y"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := s.repo.UpdateRackPosition(rackID, req.RelX, req.RelY); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.auditor.Log(r, "rack_position", "rack", rackID, "", req, "success")
	writeJSON(w, http.StatusOK, map[string]string{"message": "position updated"})
}

func (s *Server) handleRackRestore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	var req struct {
		UndoToken string `json:"undo_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	entry, ok := s.takeUndo(req.UndoToken, "rack")
	if !ok {
		writeError(w, http.StatusGone, "撤销已过期或无效")
		return
	}
	rack, err := s.repo.RestoreRack(entry.rack)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditor.Log(r, "rack_restore", "rack", rack.ID, rack.Code, nil, "success")
	writeJSON(w, http.StatusOK, rack)
}

// Device Handlers
func (s *Server) handleDevices(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		devices, err := s.repo.ListAllDevices()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, devices)
	case http.MethodPost:
		claims := auth.GetUserClaims(r)
		if claims.Role != model.RoleAdmin {
			writeError(w, http.StatusForbidden, "admin required")
			return
		}
		var req struct {
			RackID       int64            `json:"rack_id"`
			StartU       int              `json:"start_u"`
			UHeight      int              `json:"u_height"`
			Type         model.DeviceType `json:"type"`
			SubBrand     string           `json:"sub_brand"`
			Name         string           `json:"name"`
			Hostname     string           `json:"hostname"`
			AssetTag     string           `json:"asset_tag"`
			Vendor       string           `json:"vendor"`
			Model        string           `json:"model"`
			SerialNumber string           `json:"serial_number"`
			MgmtIP       string           `json:"mgmt_ip"`
			BmcIP        string           `json:"bmc_ip"`
			Notes        string           `json:"notes"`
			Owner        string           `json:"owner"`
			Credential   *struct {
				BmcProtocol string `json:"bmc_protocol"`
				BmcPort     int    `json:"bmc_port"`
				BmcUser     string `json:"bmc_user"`
				BmcPassword string `json:"bmc_password"`
				SSHPort     int    `json:"ssh_port"`
				SSHUser     string `json:"ssh_user"`
				SSHAuthType string `json:"ssh_auth_type"`
				SSHSecret   string `json:"ssh_secret"`
			} `json:"credential"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		if req.UHeight <= 0 {
			req.UHeight = 1
		}
		dev := &model.Device{
			RackID:       req.RackID,
			StartU:       req.StartU,
			UHeight:      req.UHeight,
			Type:         req.Type,
			SubBrand:     req.SubBrand,
			Name:         req.Name,
			Hostname:     req.Hostname,
			AssetTag:     req.AssetTag,
			Vendor:       req.Vendor,
			Model:        req.Model,
			SerialNumber: req.SerialNumber,
			MgmtIP:       req.MgmtIP,
			BmcIP:        req.BmcIP,
			Notes:        req.Notes,
			Owner:        req.Owner,
		}
		var cred *model.DeviceCredential
		if req.Credential != nil {
			cred = &model.DeviceCredential{
				BmcProtocol:     req.Credential.BmcProtocol,
				BmcPort:         req.Credential.BmcPort,
				BmcUser:         req.Credential.BmcUser,
				BmcPasswordMask: req.Credential.BmcPassword,
				SSHPort:         req.Credential.SSHPort,
				SSHUser:         req.Credential.SSHUser,
				SSHAuthType:     req.Credential.SSHAuthType,
				SSHSecretMask:   req.Credential.SSHSecret,
			}
		}

		created, err := s.repo.CreateDevice(dev, cred)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		s.auditor.Log(r, "device_create", "device", created.ID, created.Name, req, "success")
		// 异步触发一次即时探测
		go func(id int64) {
			_ = s.engine.CollectDevice(id)
		}(created.ID)

		writeJSON(w, http.StatusCreated, created)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleDeviceDetail(w http.ResponseWriter, r *http.Request) {
	idStr := strings.TrimPrefix(r.URL.Path, "/api/v1/devices/")
	deviceID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid device id")
		return
	}

	switch r.Method {
	case http.MethodGet:
		dev, err := s.repo.GetDeviceByID(deviceID)
		if err != nil {
			writeError(w, http.StatusNotFound, "device not found")
			return
		}
		writeJSON(w, http.StatusOK, dev)
	case http.MethodPut:
		claims := auth.GetUserClaims(r)
		if claims.Role != model.RoleAdmin {
			writeError(w, http.StatusForbidden, "admin required")
			return
		}
		var req struct {
			RackID       int64            `json:"rack_id"`
			StartU       int              `json:"start_u"`
			UHeight      int              `json:"u_height"`
			Type         model.DeviceType `json:"type"`
			SubBrand     string           `json:"sub_brand"`
			Name         string           `json:"name"`
			Hostname     string           `json:"hostname"`
			AssetTag     string           `json:"asset_tag"`
			Vendor       string           `json:"vendor"`
			Model        string           `json:"model"`
			SerialNumber string           `json:"serial_number"`
			MgmtIP       string           `json:"mgmt_ip"`
			BmcIP        string           `json:"bmc_ip"`
			Notes        string           `json:"notes"`
			Owner        string           `json:"owner"`
			Credential   *struct {
				BmcProtocol string `json:"bmc_protocol"`
				BmcPort     int    `json:"bmc_port"`
				BmcUser     string `json:"bmc_user"`
				BmcPassword string `json:"bmc_password"`
				SSHPort     int    `json:"ssh_port"`
				SSHUser     string `json:"ssh_user"`
				SSHAuthType string `json:"ssh_auth_type"`
				SSHSecret   string `json:"ssh_secret"`
			} `json:"credential"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		dev := &model.Device{
			ID:           deviceID,
			RackID:       req.RackID,
			StartU:       req.StartU,
			UHeight:      req.UHeight,
			Type:         req.Type,
			SubBrand:     req.SubBrand,
			Name:         req.Name,
			Hostname:     req.Hostname,
			AssetTag:     req.AssetTag,
			Vendor:       req.Vendor,
			Model:        req.Model,
			SerialNumber: req.SerialNumber,
			MgmtIP:       req.MgmtIP,
			BmcIP:        req.BmcIP,
			Notes:        req.Notes,
			Owner:        req.Owner,
		}
		var cred *model.DeviceCredential
		if req.Credential != nil {
			cred = &model.DeviceCredential{
				BmcProtocol:     req.Credential.BmcProtocol,
				BmcPort:         req.Credential.BmcPort,
				BmcUser:         req.Credential.BmcUser,
				BmcPasswordMask: req.Credential.BmcPassword,
				SSHPort:         req.Credential.SSHPort,
				SSHUser:         req.Credential.SSHUser,
				SSHAuthType:     req.Credential.SSHAuthType,
				SSHSecretMask:   req.Credential.SSHSecret,
			}
		}
		if err := s.repo.UpdateDevice(dev, cred); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.auditor.Log(r, "device_update", "device", deviceID, dev.Name, req, "success")
		go func(id int64) {
			_ = s.engine.CollectDevice(id)
		}(deviceID)
		writeJSON(w, http.StatusOK, map[string]string{"message": "updated"})
	case http.MethodDelete:
		claims := auth.GetUserClaims(r)
		if claims.Role != model.RoleAdmin {
			writeError(w, http.StatusForbidden, "admin required")
			return
		}
		dev, _ := s.repo.GetDeviceByID(deviceID)
		devName := ""
		if dev != nil {
			devName = dev.Name
		}
		if err := s.repo.DeleteDevice(deviceID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.auditor.Log(r, "device_delete", "device", deviceID, devName, nil, "success")
		writeJSON(w, http.StatusOK, map[string]string{"message": "deleted"})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleSearchDevices(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, []*model.Device{})
		return
	}
	devices, err := s.repo.SearchDevices(q)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, devices)
}

func (s *Server) handleTriggerCollect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	claims := auth.GetUserClaims(r)
	if claims.Role != model.RoleAdmin {
		writeError(w, http.StatusForbidden, "admin required")
		return
	}

	deviceIDStr := r.URL.Query().Get("device_id")
	if deviceIDStr != "" {
		id, err := strconv.ParseInt(deviceIDStr, 10, 64)
		if err == nil {
			go func(dID int64) {
				_ = s.engine.CollectDevice(dID)
			}(id)
			s.auditor.Log(r, "collect_refresh", "device", id, "", nil, "success")
			writeJSON(w, http.StatusOK, map[string]string{"message": "single device collect triggered"})
			return
		}
	}

	go s.engine.CollectAll()
	s.auditor.Log(r, "collect_refresh", "system", 0, "all_devices", nil, "success")
	writeJSON(w, http.StatusOK, map[string]string{"message": "full room collect triggered"})
}

// Audit Log Handlers
func (s *Server) handleListAuditLogs(w http.ResponseWriter, r *http.Request) {
	limit := 50
	offset := 0
	if lStr := r.URL.Query().Get("limit"); lStr != "" {
		if l, err := strconv.Atoi(lStr); err == nil && l > 0 {
			limit = l
		}
	}
	if oStr := r.URL.Query().Get("offset"); oStr != "" {
		if o, err := strconv.Atoi(oStr); err == nil && o >= 0 {
			offset = o
		}
	}
	logs, total, err := s.repo.ListAuditLogs(limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":  logs,
		"total":  total,
		"limit":  limit,
		"offset": offset,
	})
}

// User Handlers
func (s *Server) handleUsers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		users, err := s.repo.ListUsers()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, users)
	case http.MethodPost:
		var req struct {
			Username string     `json:"username"`
			Password string     `json:"password"`
			Role     model.Role `json:"role"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid body")
			return
		}
		user, err := s.repo.CreateUser(req.Username, req.Password, req.Role)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.auditor.Log(r, "user_create", "user", user.ID, user.Username, nil, "success")
		writeJSON(w, http.StatusCreated, user)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleUserDetail(w http.ResponseWriter, r *http.Request) {
	idStr := strings.TrimPrefix(r.URL.Path, "/api/v1/users/")
	userID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}

	switch r.Method {
	case http.MethodPut:
		var req struct {
			Role        model.Role `json:"role"`
			Enabled     bool       `json:"enabled"`
			NewPassword string     `json:"new_password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid body")
			return
		}
		if err := s.repo.UpdateUser(userID, req.Role, req.Enabled, req.NewPassword); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.auditor.Log(r, "user_update", "user", userID, "", req, "success")
		writeJSON(w, http.StatusOK, map[string]string{"message": "updated"})
	case http.MethodDelete:
		if err := s.repo.DeleteUser(userID); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.auditor.Log(r, "user_delete", "user", userID, "", nil, "success")
		writeJSON(w, http.StatusOK, map[string]string{"message": "deleted"})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
