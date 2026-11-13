import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Rack, Device } from '../types';
import { Chip } from '@heroui/react';

interface Props {
  rack: Rack;
  selectedDeviceId?: number | null;
  onSelectDevice: (device: Device) => void;
}

const CHASSIS_COLOR: Record<string, number> = {
  server: 0x4a7fe0,
  switch: 0x2bbf7d,
  storage: 0xe0a03c,
  other: 0x9d72f5,
};

const TYPE_LABEL: Record<string, string> = {
  server: '服务器',
  switch: '交换机',
  storage: '存储',
  other: '设备',
};

function makeDeviceFaceTexture(dev: Device): THREE.CanvasTexture {
  const hUnits = Math.max(dev.u_height, 1);
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = Math.max(hUnits * 56, 40);
  const ctx = c.getContext('2d')!;

  const base = CHASSIS_COLOR[dev.type] ?? 0x4a7fe0;
  const r = (base >> 16) & 255, g = (base >> 8) & 255, b = base & 255;
  const grad = ctx.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, `rgb(${Math.min(r + 30, 255)}, ${Math.min(g + 30, 255)}, ${Math.min(b + 30, 255)})`);
  grad.addColorStop(1, `rgb(${Math.max(r - 40, 0)}, ${Math.max(g - 40, 0)}, ${Math.max(b - 40, 0)})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, c.width, c.height);

  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  for (let x = 300; x < 470; x += 12) ctx.fillRect(x, c.height * 0.25, 5, c.height * 0.5);

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.min(26, c.height * 0.42)}px sans-serif`;
  const name = dev.name.length > 18 ? dev.name.slice(0, 18) + '…' : dev.name;
  ctx.fillText(name, 40, c.height / 2 + 4);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = `${Math.min(16, c.height * 0.3)}px monospace`;
  ctx.fillText(`U${dev.start_u}~U${dev.start_u + dev.u_height - 1}`, 40, c.height / 2 + Math.min(24, c.height * 0.4));

  const offline = dev.telemetry?.online_status === 'offline';
  const critical = dev.telemetry?.health_status === 'critical';
  const warning = dev.telemetry?.health_status === 'warning';
  const led = offline || critical ? '#ef4444' : warning ? '#f59e0b' : '#22c55e';
  ctx.fillStyle = led;
  ctx.beginPath();
  ctx.arc(20, c.height / 2, 7, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

function makeInteriorTexture(totalU: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = totalU * 12;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#0e1728';
  ctx.fillRect(0, 0, c.width, c.height);
  for (let u = 0; u <= totalU; u++) {
    const y = (u / totalU) * c.height;
    ctx.strokeStyle = 'rgba(140, 160, 190, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(c.width, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(165, 180, 205, 0.4)';
    ctx.fillRect(8, y + 3, 8, 5);
    ctx.fillRect(c.width - 16, y + 3, 8, 5);
  }
  return new THREE.CanvasTexture(c);
}

function makeURulerTexture(totalU: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = totalU * 12;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#111a2e';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#a8b8cc';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  for (let u = 1; u <= totalU; u++) {
    if (u % 2 !== 0 && u !== 1 && u !== totalU) continue;
    const y = c.height - (u - 0.5) * 12;
    ctx.fillText(String(u), c.width / 2, y + 4);
  }
  return new THREE.CanvasTexture(c);
}

export function Rack3DView({ rack, selectedDeviceId, onSelectDevice }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredDevice, setHoveredDevice] = useState<Device | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  // 相机位姿跨重建保留（切换选中设备不再重置视角）
  const viewRef = useRef<{ pos: [number, number, number]; target: [number, number, number] } | null>(null);
  const selectedRef = useRef<number | null | undefined>(null);
  selectedRef.current = selectedDeviceId;

  const devices = rack.devices || [];
  const deviceSig = devices
    .map((d) => `${d.id}:${d.start_u}:${d.u_height}:${d.type}:${d.telemetry?.online_status}:${d.telemetry?.health_status}`)
    .join('|');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const width = container.clientWidth || 600;
    const height = container.clientHeight || 580;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setWebglFailed(true);
      return;
    }
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080d1a);

    const totalU = rack.total_u || 42;
    const uUnit = 0.08;
    const rackW = 1.2;
    const rackD = 1.4;
    const rackH = totalU * uUnit;

    const camera = new THREE.PerspectiveCamera(40, width / height, 0.05, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.target.set(0, rackH / 2, 0);
    // 允许上下俯仰 + 右键平移，便于查看机柜顶部/底部设备
    controls.minPolarAngle = 0.03;
    controls.maxPolarAngle = Math.PI * 0.94;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.minDistance = 1.2;
    controls.maxDistance = 14;

    if (viewRef.current) {
      camera.position.set(...viewRef.current.pos);
      controls.target.set(...viewRef.current.target);
    } else {
      camera.position.set(1.7, rackH * 0.62, 4.6);
    }
    controls.update();

    // 灯光
    scene.add(new THREE.AmbientLight(0xdce7fb, 0.95));
    scene.add(new THREE.HemisphereLight(0xb8d0ff, 0x2a3a56, 0.7));
    const key = new THREE.DirectionalLight(0xfff2e0, 1.4);
    key.position.set(4, 7, 6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x38bdf8, 0.85);
    rim.position.set(-5, 4, -4);
    scene.add(rim);
    const frontPoint = new THREE.PointLight(0x99ccff, 0.7, 14);
    frontPoint.position.set(0, rackH * 0.6, 3);
    scene.add(frontPoint);

    const disposables: Array<{ dispose: () => void }> = [];

    // 框架
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x8899ad, metalness: 0.65, roughness: 0.35 });
    disposables.push(frameMat);
    const colGeo = new THREE.BoxGeometry(0.07, rackH + 0.1, 0.07);
    disposables.push(colGeo);
    const halfW = rackW / 2, halfD = rackD / 2;
    [[-halfW, -halfD], [halfW, -halfD], [-halfW, halfD], [halfW, halfD]].forEach(([x, z]) => {
      const col = new THREE.Mesh(colGeo, frameMat);
      col.position.set(x, rackH / 2, z);
      scene.add(col);
    });
    const capGeo = new THREE.BoxGeometry(rackW + 0.08, 0.08, rackD + 0.08);
    disposables.push(capGeo);
    const bottom = new THREE.Mesh(capGeo, frameMat);
    bottom.position.y = 0;
    scene.add(bottom);
    const top = new THREE.Mesh(capGeo, frameMat);
    top.position.y = rackH + 0.05;
    scene.add(top);

    const sideMat = new THREE.MeshPhysicalMaterial({
      color: 0x2a3a58, metalness: 0.2, roughness: 0.15, transparent: true, opacity: 0.16, side: THREE.DoubleSide,
    });
    const sideGeo = new THREE.PlaneGeometry(rackD - 0.1, rackH);
    disposables.push(sideMat, sideGeo);
    const left = new THREE.Mesh(sideGeo, sideMat);
    left.rotation.y = Math.PI / 2;
    left.position.set(-halfW, rackH / 2, 0);
    scene.add(left);
    const right = new THREE.Mesh(sideGeo, sideMat);
    right.rotation.y = Math.PI / 2;
    right.position.set(halfW, rackH / 2, 0);
    scene.add(right);

    // 内部 U 网格背板
    const interiorTex = makeInteriorTexture(totalU);
    const interiorMat = new THREE.MeshStandardMaterial({
      map: interiorTex, metalness: 0.2, roughness: 0.8, emissive: 0x1e2f4d, emissiveIntensity: 0.5,
    });
    const interiorGeo = new THREE.PlaneGeometry(rackW - 0.12, rackH);
    const interior = new THREE.Mesh(interiorGeo, interiorMat);
    interior.position.set(0, rackH / 2, -halfD + 0.06);
    scene.add(interior);
    disposables.push(interiorTex, interiorMat, interiorGeo);

    // 左侧 U 标尺
    const rulerTex = makeURulerTexture(totalU);
    const rulerMat = new THREE.MeshBasicMaterial({ map: rulerTex });
    const rulerGeo = new THREE.PlaneGeometry(0.14, rackH);
    const ruler = new THREE.Mesh(rulerGeo, rulerMat);
    ruler.position.set(-halfW + 0.11, rackH / 2, halfD + 0.01);
    scene.add(ruler);
    disposables.push(rulerTex, rulerMat, rulerGeo);

    const grid = new THREE.GridHelper(16, 32, 0x1d4ed8, 0x1a2740);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    grid.position.y = -0.05;
    scene.add(grid);

    // 设备
    interface DevEntry {
      device: Device;
      mesh: THREE.Mesh;
      mat: THREE.MeshStandardMaterial;
    }
    const devEntries: DevEntry[] = [];

    devices.forEach((dev) => {
      // 严格按 U 位对齐标尺：每台设备居中占满自身 U 区间，留 0.01 缝隙避免相邻设备穿插/共面
      const spanH = dev.u_height * uUnit;
      const boxH = Math.max(spanH - 0.01, 0.02);
      const devY = (dev.start_u - 1) * uUnit + spanH / 2;
      const baseColor = CHASSIS_COLOR[dev.type] ?? 0x4a7fe0;
      const offline = dev.telemetry?.online_status === 'offline';
      const boxDepth = rackD - 0.32;

      const geo = new THREE.BoxGeometry(rackW - 0.18, boxH, boxDepth);
      const mat = new THREE.MeshStandardMaterial({
        color: offline ? 0x55606f : baseColor,
        metalness: 0.5,
        roughness: 0.45,
        emissive: offline ? 0x141a24 : 0x16243a,
        emissiveIntensity: 0.22,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, devY, 0);
      scene.add(mesh);
      disposables.push(geo, mat);

      const faceTex = makeDeviceFaceTexture(dev);
      const faceMat = new THREE.MeshStandardMaterial({
        map: faceTex, metalness: 0.25, roughness: 0.6, emissive: 0xffffff, emissiveMap: faceTex, emissiveIntensity: 0.22,
      });
      const faceGeo = new THREE.PlaneGeometry(rackW - 0.2, boxH * 0.9);
      const face = new THREE.Mesh(faceGeo, faceMat);
      face.position.set(0, devY, boxDepth / 2 + 0.008);
      scene.add(face);
      disposables.push(faceTex, faceMat, faceGeo);

      devEntries.push({ device: dev, mesh, mat });
    });

    // 交互
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let hovered: DevEntry | null = null;

    const pick = (e: MouseEvent): DevEntry | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(devEntries.map((d) => d.mesh));
      if (hits.length > 0) return devEntries.find((d) => d.mesh === hits[0].object) || null;
      return null;
    };
    const onMove = (e: MouseEvent) => {
      const hit = pick(e);
      if (hit !== hovered) {
        hovered = hit;
        setHoveredDevice(hit ? hit.device : null);
        renderer.domElement.style.cursor = hit ? 'pointer' : 'default';
      }
    };
    let downPos = { x: 0, y: 0 };
    const onDown = (e: MouseEvent) => { downPos = { x: e.clientX, y: e.clientY }; };
    const onClick = (e: MouseEvent) => {
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) return;
      const hit = pick(e);
      if (hit) onSelectDevice(hit.device);
    };
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('click', onClick);

    // 渲染循环
    let animId = 0;
    const clock = new THREE.Clock();
    const animate = () => {
      animId = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      for (const en of devEntries) {
        const isSelected = en.device.id === selectedRef.current;
        const isHover = en === hovered;
        if (isSelected) {
          en.mat.emissive.setHex(0x38bdf8);
          en.mat.emissiveIntensity = 0.35 + 0.2 * Math.sin(t * 4);
        } else if (isHover) {
          en.mat.emissive.setHex(0x7dd3fc);
          en.mat.emissiveIntensity = 0.2;
        } else if (en.device.telemetry?.health_status === 'critical') {
          en.mat.emissive.setHex(0xef4444);
          en.mat.emissiveIntensity = 0.15 + 0.1 * Math.sin(t * 3);
        } else {
          en.mat.emissive.setHex(0x16243a);
          en.mat.emissiveIntensity = 0.22;
        }
      }
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
      // 保留相机位姿，重建后视角不跳变
      viewRef.current = {
        pos: [camera.position.x, camera.position.y, camera.position.z],
        target: [controls.target.x, controls.target.y, controls.target.z],
      };
      cancelAnimationFrame(animId);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('click', onClick);
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      container.innerHTML = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rack.id, deviceSig, rack.total_u]);

  if (webglFailed) {
    return (
      <div className="w-full h-[580px] flex items-center justify-center bg-slate-950 rounded-xl border border-slate-800 text-sm text-slate-400">
        当前环境不支持 WebGL，请使用 U 位视图
      </div>
    );
  }

  return (
    <div className="relative w-full h-[580px] bg-slate-950 rounded-xl overflow-hidden border border-slate-800">
      <div ref={containerRef} className="w-full h-full" />

      <div className="absolute top-3 left-4 pointer-events-none flex items-center gap-2">
        <span className="font-mono text-xs font-bold px-2 py-1 rounded bg-slate-900/90 border border-slate-700 text-sky-400">
          {rack.code} 3D 透视
        </span>
        <span className="text-[11px] text-slate-300 bg-slate-900/70 px-2 py-1 rounded border border-slate-800">
          左键旋转 · 滚轮缩放（跟随光标）· 右键/双指平移 · 点击设备联动
        </span>
      </div>

      {hoveredDevice && (
        <div className="absolute bottom-4 left-4 pointer-events-none p-3 rounded-lg bg-slate-900/95 border border-sky-500/50 backdrop-blur shadow-2xl">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-bold text-sky-400">
              U{hoveredDevice.start_u}~U{hoveredDevice.start_u + hoveredDevice.u_height - 1}
            </span>
            <span className="font-bold text-slate-100 text-sm">{hoveredDevice.name}</span>
            <span className="text-[10px] text-slate-400">{TYPE_LABEL[hoveredDevice.type]}</span>
          </div>
          <div className="text-xs text-slate-400 font-mono mt-1">
            {hoveredDevice.vendor} {hoveredDevice.model} | {hoveredDevice.mgmt_ip || '无管理IP'}
          </div>
          {hoveredDevice.telemetry && (
            <div className="flex items-center gap-2 mt-2">
              <Chip
                size="sm"
                color={hoveredDevice.telemetry.online_status === 'online' ? 'success' : 'danger'}
                className="text-[10px] h-5"
              >
                {hoveredDevice.telemetry.online_status === 'online' ? '在线' : '离线'}
              </Chip>
              {hoveredDevice.telemetry.max_temp_c != null && hoveredDevice.telemetry.max_temp_c > 0 && (
                <Chip size="sm" color="warning" className="text-[10px] h-5 font-mono">
                  {Math.round(hoveredDevice.telemetry.max_temp_c)}°C
                </Chip>
              )}
              {hoveredDevice.owner && (
                <span className="text-[10px] text-slate-400">使用人 {hoveredDevice.owner}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
