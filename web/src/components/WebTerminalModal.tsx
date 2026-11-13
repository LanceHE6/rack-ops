import { useEffect, useRef } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody } from '@heroui/react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getToken } from '../api/client';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  deviceId: number;
  deviceName: string;
  ip: string;
  type: 'webssh' | 'ipmisol';
}

export function WebTerminalModal({ isOpen, onClose, deviceId, deviceName, ip, type }: Props) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!isOpen || !terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: '#090d16',
        foreground: '#e2e8f0',
        cursor: '#38bdf8',
        selectionBackground: 'rgba(56, 189, 248, 0.3)',
      },
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalRef.current);
    fit.fit();

    xtermInstance.current = term;
    fitAddon.current = fit;

    const token = getToken() || '';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const endpoint = type === 'webssh' ? '/api/v1/console/webssh' : '/api/v1/console/ipmisol';
    const wsUrl = `${protocol}//${host}${endpoint}?device_id=${deviceId}&token=${token}&cols=${term.cols}&rows=${term.rows}`;

    term.writeln(`\x1b[36m[RackOps] 正在建立与 ${deviceName} (${ip}) 的 ${type === 'webssh' ? 'SSH' : 'IPMI 串口'} 终端连接...\x1b[0m\r\n`);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      term.writeln('\x1b[32m[RackOps] 远程会话已建立。\x1b[0m\r\n');
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        term.write(event.data);
      } else {
        const u8 = new Uint8Array(event.data);
        term.write(u8);
      }
    };

    ws.onerror = () => {
      term.writeln('\r\n\x1b[31m[RackOps] WebSocket 通信发生错误。\x1b[0m\r\n');
    };

    ws.onclose = () => {
      term.writeln('\r\n\x1b[33m[RackOps] 远程会话已结束或连接断开。\x1b[0m\r\n');
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    const handleResize = () => {
      if (fitAddon.current && xtermInstance.current && ws.readyState === WebSocket.OPEN) {
        fitAddon.current.fit();
        ws.send(JSON.stringify({
          type: 'resize',
          cols: xtermInstance.current.cols,
          rows: xtermInstance.current.rows,
        }));
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      term.dispose();
      xtermInstance.current = null;
      fitAddon.current = null;
    };
  }, [isOpen, deviceId, deviceName, ip, type]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="5xl" classNames={{ base: 'bg-slate-900 border border-slate-700 text-slate-100' }}>
      <ModalContent>
        <ModalHeader className="flex justify-between items-center border-b border-slate-800 pr-10">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="font-semibold text-slate-200">
              {type === 'webssh' ? 'SSH 控制台' : 'IPMI 串口终端 (SOL)'} - {deviceName} ({ip})
            </span>
          </div>
        </ModalHeader>
        <ModalBody className="p-3">
          <div ref={terminalRef} className="w-full h-[520px] rounded bg-[#090d16] p-1 overflow-hidden" />
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
