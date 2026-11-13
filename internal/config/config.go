package config

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
)

type Config struct {
	Port         int
	DataDir      string
	DBPath       string
	SecretKey    []byte
	JWTSecret    []byte
	PollInterval int // 秒，默认 300（5分钟）
}

func LoadConfig() (*Config, error) {
	port := 8080
	if pStr := os.Getenv("RACKOPS_PORT"); pStr != "" {
		if p, err := strconv.Atoi(pStr); err == nil && p > 0 {
			port = p
		}
	}

	dataDir := os.Getenv("RACKOPS_DATA_DIR")
	if dataDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			dataDir = "./data"
		} else {
			dataDir = filepath.Join(home, ".rackops")
		}
	}
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, err
	}

	dbPath := os.Getenv("RACKOPS_DB_PATH")
	if dbPath == "" {
		dbPath = filepath.Join(dataDir, "rackops.db")
	}

	secretKey, err := loadOrCreateSecret(filepath.Join(dataDir, "master.key"), "RACKOPS_SECRET_KEY")
	if err != nil {
		return nil, err
	}

	jwtSecret, err := loadOrCreateSecret(filepath.Join(dataDir, "jwt.key"), "RACKOPS_JWT_SECRET")
	if err != nil {
		return nil, err
	}

	pollInterval := 300
	if piStr := os.Getenv("RACKOPS_POLL_INTERVAL"); piStr != "" {
		if pi, err := strconv.Atoi(piStr); err == nil && pi >= 30 {
			pollInterval = pi
		}
	}

	return &Config{
		Port:         port,
		DataDir:      dataDir,
		DBPath:       dbPath,
		SecretKey:    secretKey,
		JWTSecret:    jwtSecret,
		PollInterval: pollInterval,
	}, nil
}

func loadOrCreateSecret(filePath string, envVar string) ([]byte, error) {
	if val := os.Getenv(envVar); val != "" {
		if raw, err := hex.DecodeString(val); err == nil && len(raw) == 32 {
			return raw, nil
		}
		if len(val) >= 32 {
			return []byte(val[:32]), nil
		}
	}

	if data, err := os.ReadFile(filePath); err == nil {
		decoded, err := hex.DecodeString(string(data))
		if err == nil && len(decoded) == 32 {
			return decoded, nil
		}
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	_ = os.WriteFile(filePath, []byte(hex.EncodeToString(key)), 0600)
	return key, nil
}
