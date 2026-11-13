import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomRow, Rack, Device } from '../types';
import { Chip } from '@heroui/react';

interface Props {
  rows: RoomRow[];
  devicesByRack: Record<number, Device[]>;
  highlightRackId?: number | null;
  onSelectRack: (rack: Rack) => void;
}

const TYPE_COLOR: Record<string, number> = {
  server: 0x38bdf8,
  switch: 0x34d399,
  storage: 0xfbbf24,
  other: 0xc084fc,
};

function makeLabelTexture(code: string, name: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 100;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(7, 12, 24, 0.88)';
  ctx.beginPath();
  ctx.roundRect(4, 4, 248, 92, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#7dd3fc';
  ctx.font = 'bold 38px Menlo, monospace';
  ctx.fillText(code, 18, 46);
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '20px sans-serif';
  const short = name.length > 12 ? name.slice(0, 12) + '…' : name;
  ctx.fillText(short, 18, 78);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

function makeFrontPanelTexture(totalU: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = Math.max(totalU * 8, 64);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#111a2c';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = 'rgba(165, 180, 205, 0.55)';
  ctx.lineWidth = 1;
  for (let u = 0; u <= totalU; u++) {
    const y = (u / totalU) * c.height;
    ctx.beginPath();
    ctx.moveTo(6, y);
    ctx.lineTo(c.width - 6, y);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(100, 116, 139, 0.5)';
  ctx.fillRect(2, 0, 4, c.height);
  ctx.fillRect(c.width - 6, 0, 4, c.height);
  return new THREE.CanvasTexture(c);
}

export function Room3DView({ rows, devicesByRack, highlightRackId, onSelectRack }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredRack, setHoveredRack] = useState<Rack | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  const viewRef = useRef<{ pos: [number, number, number]; target: [number, number, number] } | null>(null);
  const highlightRef = useRef<number | null | undefined>(null);
  highlightRef.current = highlightRackId;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 650;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      setWebglFailed(true);
      return;
    }
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070b16);
    scene.fog = new THREE.Fog(0x070b16, 40, 110);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 300);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.minDistance = 4;
    controls.maxDistance = 90;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;

    // 灯光
    scene.add(new THREE.AmbientLight(0xc8d8f0, 0.8));
    scene.add(new THREE.HemisphereLight(0xb2ccff, 0x243046, 0.85));
    const key = new THREE.DirectionalLight(0xfff0d6, 1.45);
    key.position.set(10, 18, 12);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x38bdf8, 0.95);
    rim.position.set(-12, 8, -10);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0x8899ff, 0.4);
    fill.position.set(0, 6, -16);
    scene.add(fill);

    // 布局参数：与 2D 俯视图完全一致（按 pos_x/pos_y + rel_x/rel_y 摆放）
    const rackW = 1.0;
    const rackH = 2.4;
    const rackD = 1.4;

    let minGX = Infinity, maxGX = -Infinity, minGZ = Infinity, maxGZ = -Infinity;
    rows.forEach((r) => (r.racks || []).forEach((k) => {
      minGX = Math.min(minGX, r.pos_x + k.rel_x);
      maxGX = Math.max(maxGX, r.pos_x + k.rel_x + rackW);
      minGZ = Math.min(minGZ, r.pos_y + k.rel_y);
      maxGZ = Math.max(maxGZ, r.pos_y + k.rel_y + rackD);
    }));
    if (!isFinite(minGX)) { minGX = 0; maxGX = 4; minGZ = 0; maxGZ = 3; }
    const centerGX = (minGX + maxGX) / 2;
    const centerGZ = (minGZ + maxGZ) / 2;
    const spanX = maxGX - minGX;
    const spanZ = maxGZ - minGZ;

    controls.target.set(0, 1.1, 0);
    if (viewRef.current) {
      camera.position.set(...viewRef.current.pos);
      controls.target.set(...viewRef.current.target);
    } else {
    // 按内容投影尺寸拟合视距：横向按宽度、纵向按“进深+机柜高度”估算，避免机柜房子只占画面一角
    const fovDeg = 45;
    const tanHalf = Math.tan((fovDeg * Math.PI) / 180 / 2);
    const aspect = Math.max(1.2, width / height);
    const elevRad = 30 * Math.PI / 180;
    const projH = Math.abs(spanZ * Math.sin(elevRad)) + Math.abs(rackH * Math.cos(elevRad)) + 0.8;
    const projW = Math.max(spanX, 2.4) + 0.8;
    const distH = (projH / 2) / tanHalf;
    const distW = (projW / 2) / (tanHalf * Math.min(aspect, 1.9));
    const fitDist = Math.max(distH, distW) * 1.1 + 0.8;
    const dir = new THREE.Vector3(0.42, 0.52, 0.86).normalize();
    camera.position.set(dir.x * fitDist, 1.1 + dir.y * fitDist, dir.z * fitDist);
    controls.maxDistance = Math.max(60, fitDist * 3);
    }
    controls.update();

    const disposables: Array<{ dispose: () => void }> = [{ dispose: () => controls.dispose() }];

    // 地板：超大网格，铺满视野
    const floorSize = Math.max(spanX + 40, spanZ + 40, 120);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(floorSize, floorSize),
      new THREE.MeshStandardMaterial({ color: 0x121c30, metalness: 0.4, roughness: 0.65 })
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    disposables.push(floor.geometry, floor.material as THREE.Material);
    const grid = new THREE.GridHelper(floorSize, Math.round(floorSize), 0x1d4ed8, 0x17233c);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.45;
    grid.position.y = 0.012;
    scene.add(grid);

    // 冷通道发光带（相邻机排之间）
    const rowZ = Array.from(new Set(rows.map((r) => r.pos_y))).sort((a, b) => a - b);
    for (let i = 0; i < rowZ.length - 1; i++) {
      const z = ((rowZ[i] + rowZ[i + 1]) / 2 - centerGZ);
      const strip = new THREE.Mesh(
        new THREE.PlaneGeometry(spanX + 5, 0.7),
        new THREE.MeshBasicMaterial({ color: 0x0ea5e9, transparent: true, opacity: 0.1 })
      );
      strip.rotation.x = -Math.PI / 2;
      strip.position.set(0, 0.02, z);
      scene.add(strip);
      disposables.push(strip.geometry, strip.material as THREE.Material);
    }

    const bodyGeo = new THREE.BoxGeometry(rackW, rackH, rackD);
    const frontGeo = new THREE.PlaneGeometry(rackW * 0.92, rackH * 0.96);
    const capGeo = new THREE.BoxGeometry(rackW + 0.06, 0.06, rackD + 0.06);
    const capMat = new THREE.MeshStandardMaterial({ color: 0x5b6d87, metalness: 0.6, roughness: 0.4 });
    disposables.push(bodyGeo, frontGeo, capGeo, capMat);

    interface RackEntry {
      rack: Rack;
      body: THREE.Mesh;
      mat: THREE.MeshStandardMaterial;
      group: THREE.Group;
    }
    const entries: RackEntry[] = [];

    rows.forEach((row) => {
      (row.racks || []).forEach((rk) => {
        const x = row.pos_x + rk.rel_x - centerGX + rackW / 2;
        const zBase = row.pos_y + rk.rel_y - centerGZ + rackD / 2;
        const group = new THREE.Group();
        group.position.set(x, 0, zBase);

        const mat = new THREE.MeshStandardMaterial({
          color: 0x62758c,
          metalness: 0.5,
          roughness: 0.42,
          emissive: 0x1a2740,
          emissiveIntensity: 0.14,
        });
        const body = new THREE.Mesh(bodyGeo, mat);
        body.position.y = rackH / 2;
        group.add(body);
        disposables.push(mat);

        const bottomCap = new THREE.Mesh(capGeo, capMat);
        bottomCap.position.y = 0.03;
        group.add(bottomCap);
        const topCap = new THREE.Mesh(capGeo, capMat);
        topCap.position.y = rackH + 0.03;
        group.add(topCap);

        const totalU = rk.total_u || 42;
        const frontTex = makeFrontPanelTexture(totalU);
        const frontMat = new THREE.MeshStandardMaterial({
          map: frontTex,
          metalness: 0.2,
          roughness: 0.7,
          emissive: 0x24344f,
          emissiveIntensity: 0.5,
        });
        const front = new THREE.Mesh(frontGeo, frontMat);
        front.position.set(0, rackH / 2, rackD / 2 + 0.006);
        group.add(front);
        disposables.push(frontTex, frontMat);

        const devs = devicesByRack[rk.id] || [];
        const uH = rackH / totalU;
        devs.forEach((dev) => {
          const dh = Math.max(dev.u_height * uH - 0.018, 0.02);
          const geo = new THREE.BoxGeometry(rackW * 0.84, dh, 0.045);
          const offline = dev.telemetry?.online_status === 'offline';
          const color = offline ? 0x3f4a5f : TYPE_COLOR[dev.type] ?? 0x38bdf8;
          const dmat = new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: offline ? 0.12 : 0.55,
            metalness: 0.3,
            roughness: 0.5,
          });
          const strip = new THREE.Mesh(geo, dmat);
          strip.position.set(0, (dev.start_u - 1 + dev.u_height / 2) * uH, rackD / 2 + 0.03);
          group.add(strip);
          disposables.push(geo, dmat);
        });

        const labelTex = makeLabelTexture(rk.code, rk.name);
        const labelMat = new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthWrite: false });
        const label = new THREE.Sprite(labelMat);
        label.scale.set(1.5, 0.59, 1);
        label.position.set(0, rackH + 0.55, 0);
        group.add(label);
        disposables.push(labelTex, labelMat);

        scene.add(group);
        entries.push({ rack: rk, body, mat, group });
      });
    });

    const ringGeo = new THREE.RingGeometry(0.85, 1.02, 48);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.6, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.visible = false;
    scene.add(ring);
    disposables.push(ringGeo, ringMat);

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let hovered: RackEntry | null = null;

    const pick = (e: MouseEvent): RackEntry | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(entries.map((en) => en.body));
      if (hits.length > 0) return entries.find((en) => en.body === hits[0].object) || null;
      return null;
    };

    const onMove = (e: MouseEvent) => {
      const hit = pick(e);
      if (hit !== hovered) {
        hovered = hit;
        setHoveredRack(hit ? hit.rack : null);
        renderer.domElement.style.cursor = hit ? 'pointer' : 'default';
      }
    };
    let downPos = { x: 0, y: 0 };
    const onDown = (e: MouseEvent) => { downPos = { x: e.clientX, y: e.clientY }; };
    const onClick = (e: MouseEvent) => {
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) return;
      const hit = pick(e);
      if (hit) onSelectRack(hit.rack);
    };
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('click', onClick);

    let animId = 0;
    const clock = new THREE.Clock();
    const animate = () => {
      animId = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      const hl = highlightRef.current;
      for (const en of entries) {
        if (en.rack.id === hl) {
          en.mat.emissive.setHex(0x0284c7);
          en.mat.emissiveIntensity = 0.4 + 0.25 * Math.sin(t * 4);
          ring.visible = true;
          ring.position.x = en.group.position.x;
          ring.position.z = en.group.position.z;
          ringMat.opacity = 0.4 + 0.3 * Math.sin(t * 4);
        } else if (en === hovered) {
          en.mat.emissive.setHex(0x0ea5e9);
          en.mat.emissiveIntensity = 0.22;
        } else {
          en.mat.emissive.setHex(0x1a2740);
          en.mat.emissiveIntensity = 0.14;
        }
      }
      if (!entries.some((en) => en.rack.id === hl)) ring.visible = false;
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(container);

    return () => {
      viewRef.current = {
        pos: [camera.position.x, camera.position.y, camera.position.z],
        target: [controls.target.x, controls.target.y, controls.target.z],
      };
      cancelAnimationFrame(animId);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('click', onClick);
      disposables.forEach((d) => d.dispose());
      controls.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      container.innerHTML = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, devicesByRack]);

  if (webglFailed) {
    return (
      <div className="w-full h-[650px] flex items-center justify-center bg-slate-950 rounded-xl border border-slate-800 text-sm text-slate-400">
        当前环境不支持 WebGL，请切换到 2D 平面视图查看机房布局
      </div>
    );
  }

  return (
    <div className="relative w-full h-[650px] bg-slate-950 rounded-xl overflow-hidden border border-slate-800 view-in">
      <div ref={containerRef} className="w-full h-full" />

      <div className="absolute top-4 left-4 pointer-events-none flex items-center gap-2">
        <span className="font-mono text-xs font-bold px-2.5 py-1 rounded bg-slate-900/90 border border-slate-700 text-sky-400">
          机房 3D 全景
        </span>
        <span className="text-xs text-slate-300 bg-slate-900/80 px-2.5 py-1 rounded border border-slate-800">
          拖动旋转 · 滚轮缩放 · 右键平移 · 机柜正面色条 = 设备真实 U 位
        </span>
      </div>

      <div className="absolute top-4 right-4 pointer-events-none flex items-center gap-2.5 px-3 py-1.5 rounded-lg bg-slate-900/85 border border-slate-800 text-[10px] text-slate-300">
        <span className="flex items-center gap-1"><span className="w-2.5 h-1.5 rounded-sm" style={{ background: '#38bdf8' }} />服务器</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-1.5 rounded-sm" style={{ background: '#34d399' }} />交换机</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-1.5 rounded-sm" style={{ background: '#fbbf24' }} />存储</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-1.5 rounded-sm" style={{ background: '#c084fc' }} />其他</span>
      </div>

      {hoveredRack && (
        <div className="absolute bottom-4 left-4 pointer-events-none p-3.5 rounded-lg bg-slate-900/95 border border-sky-500/50 backdrop-blur shadow-2xl">
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm font-bold text-sky-400">{hoveredRack.code}</span>
            <span className="font-bold text-slate-100 text-sm">{hoveredRack.name}</span>
          </div>
          <div className="flex items-center gap-4 mt-2 text-xs text-slate-300 font-mono">
            <span>容量 {hoveredRack.total_u || 42}U</span>
            <span>已用 {hoveredRack.used_u || 0}U</span>
            {hoveredRack.max_temp != null && <span className="text-amber-400">最高 {Math.round(hoveredRack.max_temp)}°C</span>}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Chip
              size="sm"
              variant="flat"
              color={hoveredRack.health_state === 'critical' ? 'danger' : hoveredRack.health_state === 'warning' ? 'warning' : 'success'}
              className="text-[10px] h-5"
            >
              {hoveredRack.health_state === 'critical' ? '严重告警' : hoveredRack.health_state === 'warning' ? '存在告警' : '运行正常'}
            </Chip>
            <span className="text-[11px] text-sky-300">点击进入机柜视角</span>
          </div>
        </div>
      )}
    </div>
  );
}
