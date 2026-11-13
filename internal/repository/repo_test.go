package repository

import (
	"path/filepath"
	"testing"

	"github.com/LanceHE6/rackops/internal/db"
	"github.com/LanceHE6/rackops/internal/model"
)

func TestUConflictAndDeviceCRUD(t *testing.T) {
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "test.db")
	database, err := db.InitDB(dbPath)
	if err != nil {
		t.Fatalf("InitDB failed: %v", err)
	}
	defer database.Close()

	secretKey := make([]byte, 32)
	repo := NewRepository(database, secretKey)

	rows, err := repo.ListRoomRows()
	if err != nil || len(rows) == 0 || len(rows[0].Racks) == 0 {
		t.Fatalf("ListRoomRows failed or empty: %v", err)
	}
	rack := rows[0].Racks[0]

	// 1. 创建 2U 设备 (U1~U2)
	dev1 := &model.Device{
		RackID:   rack.ID,
		StartU:   1,
		UHeight:  2,
		Type:     model.DeviceTypeServer,
		SubBrand: "inspur_m5",
		Name:     "Inspur-NF5280M5-01",
		Vendor:   "Inspur",
		Model:    "NF5280M5",
		MgmtIP:   "192.168.1.10",
		BmcIP:    "192.168.2.10",
	}
	created1, err := repo.CreateDevice(dev1, nil)
	if err != nil {
		t.Fatalf("CreateDevice dev1 failed: %v", err)
	}
	if created1.ID == 0 {
		t.Fatalf("expected valid device ID")
	}

	// 2. 测试重叠冲突 (在 U2 创建 1U 设备应报错)
	devConflict := &model.Device{
		RackID:  rack.ID,
		StartU:  2,
		UHeight: 1,
		Type:    model.DeviceTypeServer,
		Name:    "Conflict-Server",
	}
	_, err = repo.CreateDevice(devConflict, nil)
	if err == nil {
		t.Fatalf("expected conflict error when placing device at U2, but got nil")
	}

	// 3. 测试越界冲突 (在 U42 创建 2U 设备，越出 42U)
	devOverflow := &model.Device{
		RackID:  rack.ID,
		StartU:  42,
		UHeight: 2,
		Type:    model.DeviceTypeServer,
		Name:    "Overflow-Server",
	}
	_, err = repo.CreateDevice(devOverflow, nil)
	if err == nil {
		t.Fatalf("expected overflow error when placing 2U device at U42, but got nil")
	}

	// 4. 合法创建 U3 的 1U 交换机
	devSwitch := &model.Device{
		RackID:   rack.ID,
		StartU:   3,
		UHeight:  1,
		Type:     model.DeviceTypeSwitch,
		SubBrand: "centec",
		Name:     "Centec-V580-01",
		Vendor:   "Centec",
		Model:    "V580",
		MgmtIP:   "192.168.1.254",
	}
	createdSwitch, err := repo.CreateDevice(devSwitch, nil)
	if err != nil {
		t.Fatalf("CreateDevice devSwitch failed: %v", err)
	}

	// 5. 校验搜索功能
	results, err := repo.SearchDevices("Centec")
	if err != nil || len(results) == 0 {
		t.Fatalf("SearchDevices failed to find Centec: %v, count: %d", err, len(results))
	}
	if results[0].ID != createdSwitch.ID {
		t.Fatalf("expected matched device ID %d, got %d", createdSwitch.ID, results[0].ID)
	}

	// 6. 校验机架设备列表查询（过滤掉演示种子数据，只统计本用例创建的设备）
	rackDevices, err := repo.ListDevicesByRackID(rack.ID)
	if err != nil {
		t.Fatalf("ListDevicesByRackID failed: %v", err)
	}
	createdCount := 0
	for _, d := range rackDevices {
		if d.Name == "Inspur-NF5280M5-01" || d.Name == "Centec-V580-01" {
			createdCount++
		}
	}
	if createdCount != 2 {
		t.Fatalf("expected 2 created devices in rack, got %d", createdCount)
	}
}

func TestLayoutPositionsAndUndoRestore(t *testing.T) {
	tempDir := t.TempDir()
	database, err := db.InitDB(tempDir + "/layout.db")
	if err != nil {
		t.Fatalf("InitDB failed: %v", err)
	}
	defer database.Close()
	repo := NewRepository(database, make([]byte, 32))

	rows, err := repo.ListRoomRows()
	if err != nil || len(rows) < 2 {
		t.Fatalf("expected seeded rows, got %d, err %v", len(rows), err)
	}
	// 默认布局：第二排在第一排下方，机柜横向按 1.2 格间距排布
	if rows[1].PosY <= rows[0].PosY {
		t.Fatalf("expected row 2 below row 1: %v vs %v", rows[1].PosY, rows[0].PosY)
	}
	racks := rows[0].Racks
	if len(racks) < 2 || racks[1].RelX <= racks[0].RelX {
		t.Fatalf("expected racks laid out left to right")
	}

	// 拖动位置更新
	if err := repo.UpdateRowPosition(rows[0].ID, 5.5, 2); err != nil {
		t.Fatalf("UpdateRowPosition: %v", err)
	}
	if err := repo.UpdateRackPosition(racks[0].ID, 0.5, 0.5); err != nil {
		t.Fatalf("UpdateRackPosition: %v", err)
	}
	rr, _ := repo.GetRowByID(rows[0].ID)
	if rr.PosX != 5.5 || rr.PosY != 2 {
		t.Fatalf("row position not persisted: %+v", rr)
	}

	// 追加机柜
	newRack, err := repo.CreateRack(rows[0].ID, 42)
	if err != nil {
		t.Fatalf("CreateRack: %v", err)
	}
	if newRack.Code == "" || newRack.RelX <= racks[len(racks)-1].RelX {
		t.Fatalf("new rack should be appended at right: %+v", newRack)
	}

	// 机柜删除 + 快照撤销（含演示设备）
	target := racks[0]
	before, _ := repo.ListDevicesByRackID(target.ID)
	snap, err := repo.SnapshotRack(target.ID)
	if err != nil {
		t.Fatalf("SnapshotRack: %v", err)
	}
	if err := repo.DeleteRack(target.ID); err != nil {
		t.Fatalf("DeleteRack: %v", err)
	}
	if _, err := repo.GetRackByID(target.ID); err == nil {
		t.Fatalf("rack should be deleted")
	}
	restored, err := repo.RestoreRack(snap)
	if err != nil {
		t.Fatalf("RestoreRack: %v", err)
	}
	after, _ := repo.ListDevicesByRackID(restored.ID)
	if len(after) != len(before) {
		t.Fatalf("restore lost devices: before %d after %d", len(before), len(after))
	}

	// 机排删除 + 撤销
	rowSnap, err := repo.SnapshotRow(rows[1].ID)
	if err != nil {
		t.Fatalf("SnapshotRow: %v", err)
	}
	if err := repo.DeleteRoomRow(rows[1].ID); err != nil {
		t.Fatalf("DeleteRoomRow: %v", err)
	}
	restoredRow, err := repo.RestoreRow(rowSnap)
	if err != nil {
		t.Fatalf("RestoreRow: %v", err)
	}
	detail, err := repo.GetRowDetail(restoredRow.ID)
	if err != nil || len(detail.Racks) != len(rowSnap.Racks) {
		t.Fatalf("row restore incomplete: %v", err)
	}
	totalDevices := 0
	for _, rk := range detail.Racks {
		totalDevices += len(rk.Devices)
	}
	if totalDevices == 0 {
		t.Fatalf("restored row should keep its demo devices")
	}
}

func TestApplyLayoutAndOwnerField(t *testing.T) {
	tempDir := t.TempDir()
	database, err := db.InitDB(tempDir + "/apply.db")
	if err != nil {
		t.Fatalf("InitDB failed: %v", err)
	}
	defer database.Close()
	repo := NewRepository(database, make([]byte, 32))

	rowsBefore, err := repo.ListRoomRows()
	if err != nil || len(rowsBefore) < 2 {
		t.Fatalf("expected seeded rows: %v", err)
	}
	rowA := rowsBefore[0]
	racksA := rowA.Racks
	if len(racksA) < 4 {
		t.Fatalf("expected at least 4 racks in row A")
	}

	// 使用人字段写入与读回
	dev := &model.Device{
		RackID: racksA[0].ID, StartU: 20, UHeight: 1,
		Type: model.DeviceTypeServer, Name: "Owner-Test", Vendor: "Inspur", Model: "NF5280M6",
		Owner: "张三",
	}
	if c, err := repo.CreateDevice(dev, nil); err != nil {
		t.Fatalf("CreateDevice with owner: %v", err)
	} else if got, err := repo.GetDeviceByID(c.ID); err != nil || got.Owner != "张三" {
		t.Fatalf("owner roundtrip failed: %+v, err %v", got, err)
	}

	// 批量布局：移动机排、移动机柜、删除 A05、新增机柜、新增机排 F（2 柜）
	apply := LayoutApply{
		RowPositions:  []LayoutRowPos{{ID: rowA.ID, PosX: 1, PosY: 4}},
		RackPositions: []LayoutRackPos{{ID: racksA[0].ID, RelX: 2, RelY: 1}},
		RackDeletes:   []int64{racksA[3].ID},
		RackCreates:   []LayoutRackCreate{{RowID: rowA.ID, TotalU: 42, RelX: 5, RelY: 0}},
		RowCreates: []LayoutRowCreate{{
			Name: "F排", Prefix: "F", Aisle: "cold", DefaultU: 42, SortOrder: 99, PosX: 0, PosY: 20,
			Racks: []LayoutRackPlace{{RelX: 0, RelY: 0}, {RelX: 1, RelY: 0}},
		}},
	}
	if err := repo.ApplyLayout(apply); err != nil {
		t.Fatalf("ApplyLayout failed: %v", err)
	}

	rowsAfter, err := repo.ListRoomRows()
	if err != nil {
		t.Fatalf("ListRoomRows after apply: %v", err)
	}
	var a, f *model.RoomRow
	for _, r := range rowsAfter {
		if r.ID == rowA.ID {
			a = r
		}
		if r.Name == "F排" {
			f = r
		}
	}
	if a == nil || a.PosX != 1 || a.PosY != 4 {
		t.Fatalf("row position not applied: %+v", a)
	}
	if len(a.Racks) != 4 {
		t.Fatalf("expected 4 racks after delete+create, got %d", len(a.Racks))
	}
	for _, rk := range a.Racks {
		if rk.ID == racksA[0].ID && (rk.RelX != 2 || rk.RelY != 1) {
			t.Fatalf("rack position not applied: %+v", rk)
		}
		if rk.ID == racksA[3].ID {
			t.Fatalf("rack deletion not applied")
		}
	}
	if f == nil || len(f.Racks) != 2 {
		t.Fatalf("new row F not created with 2 racks: %+v", f)
	}
}
