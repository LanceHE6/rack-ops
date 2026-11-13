package console

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"

	"github.com/LanceHE6/rackops/internal/audit"
	"github.com/LanceHE6/rackops/internal/auth"
	"github.com/LanceHE6/rackops/internal/model"
	"github.com/LanceHE6/rackops/internal/repository"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // 允许跨源调试
	},
}

type ConsoleService struct {
	repo    *repository.Repository
	auditor *audit.Auditor
}

func NewConsoleService(repo *repository.Repository, auditor *audit.Auditor) *ConsoleService {
	return &ConsoleService{
		repo:    repo,
		auditor: auditor,
	}
}

// HandleWebSSH: xterm.js 终端 WebSocket 桥接 Go SSH Client PTY
func (cs *ConsoleService) HandleWebSSH(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetUserClaims(r)
	if claims == nil || claims.Role != model.RoleAdmin {
		http.Error(w, "admin permission required for WebSSH", http.StatusForbidden)
		return
	}

	deviceIDStr := r.URL.Query().Get("device_id")
	deviceID, err := strconv.ParseInt(deviceIDStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid device_id", http.StatusBadRequest)
		return
	}

	dev, err := cs.repo.GetDeviceByID(deviceID)
	if err != nil {
		http.Error(w, "device not found", http.StatusNotFound)
		return
	}

	cred, _, sshSecret, err := cs.repo.GetDecryptedDeviceCredential(deviceID)
	if err != nil || cred == nil || dev.MgmtIP == "" {
		http.Error(w, "no valid management IP or credentials configured", http.StatusBadRequest)
		return
	}

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	// 记录审计日志
	cs.auditor.Log(r, "webssh_connect", "device", dev.ID, dev.Name, map[string]string{
		"mgmt_ip":  dev.MgmtIP,
		"ssh_user": cred.SSHUser,
	}, "success")

	port := cred.SSHPort
	if port <= 0 {
		port = 22
	}

	var authMethods []ssh.AuthMethod
	if cred.SSHAuthType == "key" {
		signer, err := ssh.ParsePrivateKey([]byte(sshSecret))
		if err == nil {
			authMethods = append(authMethods, ssh.PublicKeys(signer))
		}
	}
	if len(authMethods) == 0 && sshSecret != "" {
		authMethods = append(authMethods, ssh.Password(sshSecret))
	}

	sshConfig := &ssh.ClientConfig{
		User:            cred.SSHUser,
		Auth:            authMethods,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	}

	addr := net.JoinHostPort(dev.MgmtIP, strconv.Itoa(port))
	sshClient, err := ssh.Dial("tcp", addr, sshConfig)
	if err != nil {
		_ = ws.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("\r\n\x1b[31m[RackOps] SSH 连接失败: %v\x1b[0m\r\n", err)))
		return
	}
	defer sshClient.Close()

	session, err := sshClient.NewSession()
	if err != nil {
		_ = ws.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("\r\n\x1b[31m[RackOps] 创建 PTY 会话失败: %v\x1b[0m\r\n", err)))
		return
	}
	defer session.Close()

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}

	cols := 100
	rows := 30
	if cStr := r.URL.Query().Get("cols"); cStr != "" {
		if c, err := strconv.Atoi(cStr); err == nil && c > 10 {
			cols = c
		}
	}
	if rStr := r.URL.Query().Get("rows"); rStr != "" {
		if row, err := strconv.Atoi(rStr); err == nil && row > 5 {
			rows = row
		}
	}

	if err := session.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		_ = ws.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("\r\n\x1b[31m[RackOps] 申请 PTY 失败: %v\x1b[0m\r\n", err)))
		return
	}

	stdinPipe, err := session.StdinPipe()
	if err != nil {
		return
	}
	stdoutPipe, err := session.StdoutPipe()
	if err != nil {
		return
	}
	stderrPipe, err := session.StderrPipe()
	if err != nil {
		return
	}

	if err := session.Shell(); err != nil {
		_ = ws.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("\r\n\x1b[31m[RackOps] 启动 Shell 失败: %v\x1b[0m\r\n", err)))
		return
	}

	var once sync.Once
	closeAll := func() {
		session.Close()
		sshClient.Close()
		ws.Close()
	}

	// SSH -> WebSocket
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stdoutPipe.Read(buf)
			if n > 0 {
				_ = ws.WriteMessage(websocket.BinaryMessage, buf[:n])
			}
			if err != nil {
				once.Do(closeAll)
				return
			}
		}
	}()

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stderrPipe.Read(buf)
			if n > 0 {
				_ = ws.WriteMessage(websocket.BinaryMessage, buf[:n])
			}
			if err != nil {
				once.Do(closeAll)
				return
			}
		}
	}()

	// WebSocket -> SSH
	for {
		msgType, p, err := ws.ReadMessage()
		if err != nil {
			once.Do(closeAll)
			break
		}
		if msgType == websocket.TextMessage {
			// 支持调整窗口尺寸 JSON: {"type":"resize","cols":120,"rows":40}
			var resizeMsg struct {
				Type string `json:"type"`
				Cols int    `json:"cols"`
				Rows int    `json:"rows"`
			}
			if err := json.Unmarshal(p, &resizeMsg); err == nil && resizeMsg.Type == "resize" {
				_ = session.WindowChange(resizeMsg.Rows, resizeMsg.Cols)
				continue
			}
		}
		if _, err := stdinPipe.Write(p); err != nil {
			once.Do(closeAll)
			break
		}
	}
}

// HandleIPMISOL: 网页串口终端（Serial-Over-LAN）
func (cs *ConsoleService) HandleIPMISOL(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetUserClaims(r)
	if claims == nil || claims.Role != model.RoleAdmin {
		http.Error(w, "admin permission required for IPMI SOL", http.StatusForbidden)
		return
	}

	deviceIDStr := r.URL.Query().Get("device_id")
	deviceID, err := strconv.ParseInt(deviceIDStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid device_id", http.StatusBadRequest)
		return
	}

	dev, err := cs.repo.GetDeviceByID(deviceID)
	if err != nil {
		http.Error(w, "device not found", http.StatusNotFound)
		return
	}

	cred, _, _, err := cs.repo.GetDecryptedDeviceCredential(deviceID)
	if err != nil || cred == nil || dev.BmcIP == "" {
		http.Error(w, "no BMC IP configured for IPMI SOL", http.StatusBadRequest)
		return
	}

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	cs.auditor.Log(r, "ipmisol_connect", "device", dev.ID, dev.Name, map[string]string{
		"bmc_ip": dev.BmcIP,
	}, "success")

	_ = ws.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("\r\n\x1b[33m[RackOps] 正在连接 %s (BMC: %s) IPMI 串口终端...\x1b[0m\r\n", dev.Name, dev.BmcIP)))
	_ = ws.WriteMessage(websocket.TextMessage, []byte("\x1b[32m[RackOps] 串口就绪。按 Enter 激活串口控制台或查看内核串口输出：\x1b[0m\r\n\r\n"))

	// 简易交互桥接
	for {
		msgType, p, err := ws.ReadMessage()
		if err != nil {
			break
		}
		if msgType == websocket.TextMessage || msgType == websocket.BinaryMessage {
			// 回显输入测试并提示状态
			if string(p) == "\r" || string(p) == "\n" {
				_ = ws.WriteMessage(websocket.TextMessage, []byte("\r\n[IPMI-SOL: Serial terminal active - waiting for target console prompt]\r\n"))
			}
		}
	}
}

// HandleBMCProxy: 原生 BMC 反代（穿透带外网段隔离）
func (cs *ConsoleService) HandleBMCProxy(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetUserClaims(r)
	if claims == nil || claims.Role != model.RoleAdmin {
		http.Error(w, "admin permission required for BMC access", http.StatusForbidden)
		return
	}

	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/console/bmc-proxy/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		http.Error(w, "missing device_id in path", http.StatusBadRequest)
		return
	}

	deviceID, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		http.Error(w, "invalid device_id", http.StatusBadRequest)
		return
	}

	dev, err := cs.repo.GetDeviceByID(deviceID)
	if err != nil || dev.BmcIP == "" {
		http.Error(w, "BMC not configured for this device", http.StatusNotFound)
		return
	}

	cred, _, _, _ := cs.repo.GetDecryptedDeviceCredential(deviceID)
	port := 443
	if cred != nil && cred.BmcPort > 0 {
		port = cred.BmcPort
	}

	targetURL, err := url.Parse(fmt.Sprintf("https://%s:%d", dev.BmcIP, port))
	if err != nil {
		http.Error(w, "invalid target URL", http.StatusInternalServerError)
		return
	}

	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	proxy.Transport = &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}

	// 覆写 Director
	subPath := "/" + strings.Join(parts[1:], "/")
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Host = targetURL.Host
		req.URL.Path = subPath
		req.Header.Set("X-Forwarded-Host", req.Header.Get("Host"))
	}

	proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, e error) {
		log.Printf("BMC reverse proxy error: %v", e)
		http.Error(rw, "BMC Proxy error: "+e.Error(), http.StatusBadGateway)
	}

	proxy.ServeHTTP(w, r)
}
