package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"strings"

	"github.com/LanceHE6/rackops/internal/api"
	"github.com/LanceHE6/rackops/internal/audit"
	"github.com/LanceHE6/rackops/internal/collector"
	"github.com/LanceHE6/rackops/internal/config"
	"github.com/LanceHE6/rackops/internal/console"
	"github.com/LanceHE6/rackops/internal/db"
	"github.com/LanceHE6/rackops/internal/repository"
)

//go:embed web/dist/* web/dist/assets/*
var webDistFS embed.FS

var (
	buildTime = "dev"
	version   = "0.1.0"
)

func main() {
	log.Printf("[RackOps] 数据中心机房与机架管理平台 v%s (build: %s) 启动中...", version, buildTime)

	cfg, err := config.LoadConfig()
	if err != nil {
		log.Fatalf("配置加载失败: %v", err)
	}

	database, err := db.InitDB(cfg.DBPath)
	if err != nil {
		log.Fatalf("SQLite 初始化失败: %v", err)
	}
	defer database.Close()
	log.Printf("[RackOps] SQLite 数据库已就绪: %s", cfg.DBPath)

	repo := repository.NewRepository(database, cfg.SecretKey)
	auditor := audit.NewAuditor(repo)
	engine := collector.NewEngine(repo, cfg.PollInterval)
	engine.Start()
	defer engine.Stop()

	cs := console.NewConsoleService(repo, auditor)
	server := api.NewServer(repo, auditor, engine, cs, cfg.JWTSecret)

	mux := http.NewServeMux()
	server.RegisterRoutes(mux)

	// 单二进制嵌入静态资源与 SPA 路由兜底
	distSub, err := fs.Sub(webDistFS, "web/dist")
	if err != nil {
		log.Printf("[RackOps] 警告: 未找到 web/dist 内嵌资源: %v (可在开发模式下使用 npm run dev)", err)
	} else {
		fileServer := http.FileServer(http.FS(distSub))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				http.NotFound(w, r)
				return
			}
			f, err := distSub.Open(strings.TrimPrefix(r.URL.Path, "/"))
			if err == nil {
				_ = f.Close()
				fileServer.ServeHTTP(w, r)
				return
			}
			// SPA fallback
			indexBytes, err := fs.ReadFile(distSub, "index.html")
			if err == nil {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				_, _ = w.Write(indexBytes)
				return
			}
			http.NotFound(w, r)
		})
	}

	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("[RackOps] 服务已成功监听在 http://0.0.0.0%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("HTTP 服务异常退出: %v", err)
	}
}
