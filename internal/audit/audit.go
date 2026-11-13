package audit

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"

	"github.com/LanceHE6/rackops/internal/auth"
	"github.com/LanceHE6/rackops/internal/model"
	"github.com/LanceHE6/rackops/internal/repository"
)

type Auditor struct {
	repo *repository.Repository
}

func NewAuditor(repo *repository.Repository) *Auditor {
	return &Auditor{repo: repo}
}

func (a *Auditor) Log(r *http.Request, action, targetType string, targetID int64, targetName string, detail any, status string) {
	var userID int64 = 0
	username := "anonymous"
	role := model.RoleViewer

	if claims := auth.GetUserClaims(r); claims != nil {
		userID = claims.UserID
		username = claims.Username
		role = claims.Role
	}

	detailBytes, _ := json.Marshal(detail)
	clientIP := getClientIP(r)

	_ = a.repo.InsertAuditLog(&model.AuditLog{
		UserID:     userID,
		Username:   username,
		Role:       role,
		Action:     action,
		TargetType: targetType,
		TargetID:   targetID,
		TargetName: targetName,
		DetailJSON: string(detailBytes),
		ClientIP:   clientIP,
		Status:     status,
	})
}

func getClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[0])
	}
	if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
		return strings.TrimSpace(xrip)
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}
