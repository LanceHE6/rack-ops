package collector

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/LanceHE6/rackops/internal/model"
	"github.com/LanceHE6/rackops/internal/repository"
)

type Engine struct {
	repo         *repository.Repository
	pollInterval time.Duration
	stopCh       chan struct{}
	mu           sync.Mutex
	collecting   bool
}

func NewEngine(repo *repository.Repository, intervalSec int) *Engine {
	if intervalSec < 30 {
		intervalSec = 300
	}
	return &Engine{
		repo:         repo,
		pollInterval: time.Duration(intervalSec) * time.Second,
		stopCh:       make(chan struct{}),
	}
}

func (e *Engine) Start() {
	go func() {
		// 启动后 3 秒触发一次初次采集
		select {
		case <-time.After(3 * time.Second):
			e.CollectAll()
		case <-e.stopCh:
			return
		}

		ticker := time.NewTicker(e.pollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				e.CollectAll()
			case <-e.stopCh:
				return
			}
		}
	}()
}

func (e *Engine) Stop() {
	close(e.stopCh)
}

func (e *Engine) CollectAll() {
	e.mu.Lock()
	if e.collecting {
		e.mu.Unlock()
		return
	}
	e.collecting = true
	e.mu.Unlock()

	defer func() {
		e.mu.Lock()
		e.collecting = false
		e.mu.Unlock()
	}()

	devices, err := e.repo.ListAllDevices()
	if err != nil {
		return
	}

	sem := make(chan struct{}, 10) // 最多并发 10 台
	var wg sync.WaitGroup

	for _, dev := range devices {
		wg.Add(1)
		sem <- struct{}{}
		go func(d *model.Device) {
			defer wg.Done()
			defer func() { <-sem }()
			_ = e.CollectDevice(d.ID)
		}(dev)
	}

	wg.Wait()
}

func (e *Engine) CollectDevice(deviceID int64) error {
	dev, err := e.repo.GetDeviceByID(deviceID)
	if err != nil {
		return err
	}
	// 演示设备不参与真实采集，避免覆盖演示遥测数据
	if strings.Contains(dev.Notes, "[demo]") {
		return nil
	}
	cred, bmcPass, sshSecret, _ := e.repo.GetDecryptedDeviceCredential(deviceID)

	telemetry := &model.DeviceTelemetry{
		DeviceID:     deviceID,
		OnlineStatus: "unknown",
		PowerState:   "unknown",
		HealthStatus: "unknown",
	}

	now := time.Now()
	telemetry.LastCollectedAt = &now

	// 1. 如果配置了 BMC，优先尝试带外 (Redfish/IPMI)
	if dev.BmcIP != "" && cred != nil {
		if cred.BmcProtocol == "redfish" || cred.BmcProtocol == "" {
			err = collectRedfish(dev, cred, bmcPass, telemetry)
		} else {
			err = collectIPMIPing(dev, cred, telemetry)
		}
	}

	// 2. 如果配置了 SSH，或者带外未完全获取到系统/硬件信息，通过 SSH 补充探测
	if dev.MgmtIP != "" && cred != nil && cred.SSHUser != "" {
		_ = collectSSH(dev, cred, sshSecret, telemetry)
	}

	// 3. 如果依然未连通，执行基础 TCP 探测确认存活
	if telemetry.OnlineStatus == "unknown" {
		targetIP := dev.MgmtIP
		if targetIP == "" {
			targetIP = dev.BmcIP
		}
		if targetIP != "" {
			targetPort := 22
			if dev.MgmtIP == "" && cred != nil && cred.BmcPort > 0 {
				targetPort = cred.BmcPort
			}
			conn, err := net.DialTimeout("tcp", net.JoinHostPort(targetIP, strconv.Itoa(targetPort)), 2*time.Second)
			if err == nil {
				conn.Close()
				telemetry.OnlineStatus = "online"
				if telemetry.HealthStatus == "unknown" {
					telemetry.HealthStatus = "ok"
				}
			} else {
				telemetry.OnlineStatus = "offline"
				telemetry.LastError = err.Error()
			}
		}
	}

	// 计算总体健康度
	if telemetry.HealthStatus == "unknown" {
		if telemetry.OnlineStatus == "online" {
			telemetry.HealthStatus = "ok"
		} else if telemetry.OnlineStatus == "offline" {
			telemetry.HealthStatus = "critical"
		}
	}

	return e.repo.UpdateTelemetry(telemetry)
}

// Redfish 规范采集（兼容浪潮 M5/M6、超聚变、宁畅、海光）
func collectRedfish(dev *model.Device, cred *model.DeviceCredential, password string, t *model.DeviceTelemetry) error {
	port := cred.BmcPort
	if port <= 0 {
		port = 443
	}

	tr := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		DialContext: (&net.Dialer{
			Timeout: 3 * time.Second,
		}).DialContext,
	}
	client := &http.Client{
		Transport: tr,
		Timeout:   6 * time.Second,
	}

	baseURL := fmt.Sprintf("https://%s:%d/redfish/v1", dev.BmcIP, port)

	// GET /redfish/v1/Systems
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"/Systems", nil)
	if err != nil {
		t.OnlineStatus = "offline"
		t.LastError = err.Error()
		return err
	}
	if cred.BmcUser != "" {
		req.SetBasicAuth(cred.BmcUser, password)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		t.OnlineStatus = "offline"
		t.LastError = "Redfish connect failed: " + err.Error()
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		t.OnlineStatus = "online"
		t.LastError = "Redfish auth failed: 401 Unauthorized"
		return fmt.Errorf("redfish 401 unauthorized")
	}

	t.OnlineStatus = "online"

	var systemsCollection struct {
		Members []struct {
			ODataID string `json:"@odata.id"`
		} `json:"Members"`
	}
	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &systemsCollection); err == nil && len(systemsCollection.Members) > 0 {
		sysURL := systemsCollection.Members[0].ODataID
		if !strings.HasPrefix(sysURL, "http") {
			sysURL = fmt.Sprintf("https://%s:%d%s", dev.BmcIP, port, sysURL)
		}
		parseRedfishSystem(client, sysURL, cred.BmcUser, password, t)
	}

	// 探测温度 Chassis/Thermal
	thermalURL := fmt.Sprintf("https://%s:%d/redfish/v1/Chassis/1/Thermal", dev.BmcIP, port)
	parseRedfishThermal(client, thermalURL, cred.BmcUser, password, t)

	return nil
}

func parseRedfishSystem(client *http.Client, url, user, pass string, t *model.DeviceTelemetry) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return
	}
	if user != "" {
		req.SetBasicAuth(user, pass)
	}
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		return
	}
	defer resp.Body.Close()

	var data struct {
		PowerState string `json:"PowerState"`
		Status     struct {
			Health     string `json:"Health"`
			HealthRoll string `json:"HealthRollup"`
			State      string `json:"State"`
		} `json:"Status"`
		Manufacturer     string `json:"Manufacturer"`
		Model            string `json:"Model"`
		SerialNumber     string `json:"SerialNumber"`
		ProcessorSummary struct {
			Count int    `json:"Count"`
			Model string `json:"Model"`
		} `json:"ProcessorSummary"`
		MemorySummary struct {
			TotalSystemMemoryGiB int `json:"TotalSystemMemoryGiB"`
		} `json:"MemorySummary"`
		BiosVersion string `json:"BiosVersion"`
	}

	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &data); err != nil {
		return
	}

	if data.PowerState != "" {
		t.PowerState = strings.ToLower(data.PowerState)
	}
	health := strings.ToLower(data.Status.Health)
	if health == "" {
		health = strings.ToLower(data.Status.HealthRoll)
	}
	switch health {
	case "ok":
		t.HealthStatus = "ok"
	case "warning":
		t.HealthStatus = "warning"
	case "critical":
		t.HealthStatus = "critical"
	}

	if data.ProcessorSummary.Count > 0 {
		t.CPUCount = data.ProcessorSummary.Count
	}
	if data.ProcessorSummary.Model != "" {
		t.CPUModel = data.ProcessorSummary.Model
	}
	if data.MemorySummary.TotalSystemMemoryGiB > 0 {
		t.MemoryGB = data.MemorySummary.TotalSystemMemoryGiB
	}
	if data.BiosVersion != "" {
		t.FirmwareVersion = data.BiosVersion
	}
}

func parseRedfishThermal(client *http.Client, url, user, pass string, t *model.DeviceTelemetry) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return
	}
	if user != "" {
		req.SetBasicAuth(user, pass)
	}
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		return
	}
	defer resp.Body.Close()

	var data struct {
		Temperatures []struct {
			Name           string   `json:"Name"`
			ReadingCelsius *float64 `json:"ReadingCelsius"`
			Status         struct {
				Health string `json:"Health"`
			} `json:"Status"`
		} `json:"Temperatures"`
	}

	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &data); err != nil {
		return
	}

	var maxTemp float64
	var foundMax bool

	for _, temp := range data.Temperatures {
		if temp.ReadingCelsius == nil {
			continue
		}
		val := *temp.ReadingCelsius
		if !foundMax || val > maxTemp {
			maxTemp = val
			foundMax = true
		}
		nameLower := strings.ToLower(temp.Name)
		if strings.Contains(nameLower, "inlet") || strings.Contains(nameLower, "ambient") {
			inletVal := val
			t.InletTempC = &inletVal
		}
	}
	if foundMax {
		t.MaxTempC = &maxTemp
		if maxTemp >= 75 {
			t.HealthStatus = "critical"
		} else if maxTemp >= 60 && t.HealthStatus != "critical" {
			t.HealthStatus = "warning"
		}
	}
}

func collectIPMIPing(dev *model.Device, cred *model.DeviceCredential, t *model.DeviceTelemetry) error {
	port := cred.BmcPort
	if port <= 0 {
		port = 623
	}
	// UDP 端口简单连通性测试 (RMCP 协议端口)
	conn, err := net.DialTimeout("udp", net.JoinHostPort(dev.BmcIP, strconv.Itoa(port)), 2*time.Second)
	if err != nil {
		t.OnlineStatus = "offline"
		t.LastError = "IPMI UDP unconnectable: " + err.Error()
		return err
	}
	_ = conn.Close()
	t.OnlineStatus = "online"
	return nil
}

func collectSSH(dev *model.Device, cred *model.DeviceCredential, secret string, t *model.DeviceTelemetry) error {
	port := cred.SSHPort
	if port <= 0 {
		port = 22
	}

	var authMethods []ssh.AuthMethod
	if cred.SSHAuthType == "key" {
		signer, err := ssh.ParsePrivateKey([]byte(secret))
		if err == nil {
			authMethods = append(authMethods, ssh.PublicKeys(signer))
		}
	}
	if len(authMethods) == 0 && secret != "" {
		authMethods = append(authMethods, ssh.Password(secret))
	}

	sshConfig := &ssh.ClientConfig{
		User:            cred.SSHUser,
		Auth:            authMethods,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         4 * time.Second,
	}

	addr := net.JoinHostPort(dev.MgmtIP, strconv.Itoa(port))
	client, err := ssh.Dial("tcp", addr, sshConfig)
	if err != nil {
		if t.OnlineStatus != "online" {
			t.OnlineStatus = "offline"
			t.LastError = "SSH dial failed: " + err.Error()
		}
		return err
	}
	defer client.Close()

	t.OnlineStatus = "online"
	if t.PowerState == "unknown" {
		t.PowerState = "on"
	}

	// 针对不同类型设备执行特征探针
	switch dev.Type {
	case model.DeviceTypeSwitch:
		// 盛科 / 华三 / 博科特征探测
		collectSwitchSSH(client, dev, t)
	default:
		// Linux 服务器：探测磁盘、CPU、操作系统
		collectLinuxSSH(client, t)
	}

	return nil
}

func collectLinuxSSH(client *ssh.Client, t *model.DeviceTelemetry) {
	// 探测磁盘数量与状态: lsblk -d -n -o NAME,TYPE | grep disk
	session, err := client.NewSession()
	if err == nil {
		out, _ := session.Output("lsblk -d -n -o NAME,TYPE 2>/dev/null | grep -c disk")
		session.Close()
		countStr := strings.TrimSpace(string(out))
		if count, err := strconv.Atoi(countStr); err == nil && count > 0 {
			t.DiskCount = count
			t.DiskHealthSummary = fmt.Sprintf("%d 块磁盘正常识别", count)
		}
	}

	// 探测 OS 信息
	session, err = client.NewSession()
	if err == nil {
		out, _ := session.Output("cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"'")
		session.Close()
		osStr := strings.TrimSpace(string(out))
		if osStr != "" {
			t.OSInfo = osStr
		}
	}

	// 探测 CPU 和内存如果 Redfish 没拿到
	if t.CPUModel == "" {
		session, err = client.NewSession()
		if err == nil {
			out, _ := session.Output("grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2")
			session.Close()
			t.CPUModel = strings.TrimSpace(string(out))
		}
	}
	if t.MemoryGB == 0 {
		session, err = client.NewSession()
		if err == nil {
			out, _ := session.Output("grep MemTotal /proc/meminfo 2>/dev/null | awk '{print int($2/1024/1024)}'")
			session.Close()
			if mem, err := strconv.Atoi(strings.TrimSpace(string(out))); err == nil && mem > 0 {
				t.MemoryGB = mem
			}
		}
	}
}

func collectSwitchSSH(client *ssh.Client, dev *model.Device, t *model.DeviceTelemetry) {
	// 执行 display version (华三) 或 show version (盛科/博科)
	cmd := "display version"
	if dev.SubBrand == "centec" || dev.SubBrand == "brocade" {
		cmd = "show version"
	}
	session, err := client.NewSession()
	if err == nil {
		out, _ := session.Output(cmd)
		session.Close()
		text := string(out)
		if len(text) > 0 {
			lines := strings.Split(text, "\n")
			if len(lines) > 0 {
				t.OSInfo = strings.TrimSpace(lines[0])
			}
		}
	}
}
