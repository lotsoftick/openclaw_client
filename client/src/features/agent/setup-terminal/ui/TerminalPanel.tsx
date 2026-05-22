import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Box,
  Drawer,
  SwipeableDrawer,
  Typography,
  IconButton,
  useTheme,
  useMediaQuery,
} from '@mui/material';
import { Close, CheckCircle } from '@mui/icons-material';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { API_BASE_URL } from '../../../../shared/api';
import { useSyncAgentsMutation, useDeleteAgentMutation } from '../../../../entities/agent';

interface TerminalPanelProps {
  agentName: string;
  agentDbId: string;
  open: boolean;
  onClose: () => void;
  onDeleting?: (id: string | null) => void;
}

async function fetchPtyTicket(): Promise<string> {
  const token = localStorage.getItem('token') || '';
  const res = await fetch(`${API_BASE_URL}/auth/ws-ticket`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`ws-ticket request failed (${res.status})`);
  const body = (await res.json()) as { ticket?: string };
  if (!body.ticket) throw new Error('ws-ticket response missing ticket');
  return body.ticket;
}

/**
 * Resolve the websocket origin (`wss://host[:port]`) for /ws/pty.
 *
 * `API_BASE_URL` is either:
 *   - an absolute URL ("http://1.2.3.4:18802/api") — use its scheme + host
 *   - a relative path ("/api") — `new URL(...)` would throw, so we fall
 *     back to `window.location` (the page origin), which is what nginx
 *     is fronting in the `USE_RELATIVE_API_URL=1` deployment.
 */
function wsOrigin(): string {
  try {
    const u = new URL(API_BASE_URL);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${u.host}`;
  } catch {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }
}

function buildWsUrl(agentName: string, ticket: string): string {
  return `${wsOrigin()}/ws/pty?agent=${encodeURIComponent(agentName)}&ticket=${encodeURIComponent(ticket)}`;
}

const AUTO_CLOSE_MS = 2500;

export default function TerminalPanel({
  agentName,
  agentDbId,
  open,
  onClose,
  onDeleting,
}: TerminalPanelProps) {
  const theme = useTheme();
  const isCompact = useMediaQuery(theme.breakpoints.down('md'));
  const { sidebar } = theme.palette;
  const bg = sidebar.background;
  const headerBg = sidebar.hover;
  const border = sidebar.border;
  const textColor = sidebar.text;
  const accentColor = sidebar.selectedBorder;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [syncAgents] = useSyncAgentsMutation();
  const [deleteAgent] = useDeleteAgentMutation();
  const [done, setDone] = useState(false);
  const doneRef = useRef(false);
  const [ready, setReady] = useState(false);

  const handleClose = useCallback(async () => {
    onClose();
    if (!doneRef.current) {
      onDeleting?.(agentDbId);
      await deleteAgent(agentDbId);
      onDeleting?.(null);
    }
    syncAgents();
  }, [agentDbId, deleteAgent, syncAgents, onClose, onDeleting]);

  const cleanup = useCallback(() => {
    if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current);
    autoCloseTimer.current = null;
    observerRef.current?.disconnect();
    observerRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    termRef.current?.dispose();
    termRef.current = null;
    fitRef.current = null;
  }, []);

  const containerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node) setReady(true);
  }, []);

  useEffect(() => {
    if (!ready || !open || !containerRef.current) return;
    if (termRef.current) return;

    const container = containerRef.current;

    const narrow = typeof window !== 'undefined' && window.matchMedia('(max-width:899px)').matches;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: narrow ? 12 : 13,
      fontFamily: '"Fira Code", "Cascadia Code", Menlo, Monaco, monospace',
      theme: {
        background: bg,
        foreground: theme.palette.text.primary,
        cursor: accentColor,
        selectionBackground: sidebar.hover,
      },
      convertEol: true,
      scrollback: 1000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    requestAnimationFrame(() => {
      fit.fit();
      void initWebSocket(term);
      term.focus();
    });

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (fitRef.current) {
          fitRef.current.fit();
          if (wsRef.current?.readyState === WebSocket.OPEN && termRef.current) {
            const { cols, rows } = termRef.current;
            wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
          }
        }
      });
    });
    observer.observe(container);
    observerRef.current = observer;

    async function initWebSocket(t: Terminal) {
      let ticket: string;
      try {
        ticket = await fetchPtyTicket();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        t.write(`\r\n\x1b[31mFailed to authorize terminal: ${msg}\x1b[0m\r\n`);
        return;
      }
      const url = buildWsUrl(agentName, ticket);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        const { cols, rows } = t;
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      };

      ws.onmessage = (event) => {
        const data = event.data as string;
        if (data.startsWith('{"type":')) {
          try {
            const msg = JSON.parse(data);
            if (msg.type === 'exit') {
              setDone(true);
              doneRef.current = true;
              t.write('\r\n\x1b[32m--- Setup complete ---\x1b[0m\r\n');
              syncAgents();
              autoCloseTimer.current = setTimeout(handleClose, AUTO_CLOSE_MS);
            } else if (msg.type === 'error') {
              t.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
            }
          } catch {
            t.write(data);
          }
        } else {
          t.write(data);
        }
      };

      ws.onerror = () => {
        t.write('\r\n\x1b[31mConnection error\x1b[0m\r\n');
      };

      ws.onclose = () => {
        if (!done) {
          t.write('\r\n\x1b[33mDisconnected\x1b[0m\r\n');
        }
      };

      t.onData((d) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(d);
        }
      });
    }

    return () => {
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, open, agentName]);

  useEffect(() => {
    if (!open) {
      cleanup();
      setReady(false);
      setDone(false);
      doneRef.current = false;
    }
  }, [open, cleanup]);

  const paperSx = {
    width: { xs: '100%', md: 'min(720px, 50vw)' },
    minWidth: { xs: 0, md: 480 },
    maxWidth: { xs: '100%', md: 720 },
    height: { xs: '100%', md: '100%' },
    maxHeight: { xs: '100dvh', md: '100vh' },
    bgcolor: bg,
    borderRight: { xs: 'none', md: `1px solid ${border}` },
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    pt: 'env(safe-area-inset-top)',
    pb: 'env(safe-area-inset-bottom)',
    pl: 'env(safe-area-inset-left)',
  } as const;

  const header = (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        px: { xs: 1.5, sm: 2 },
        py: { xs: 1.25, sm: 1 },
        minHeight: { xs: 48, sm: 'auto' },
        bgcolor: headerBg,
        borderBottom: `1px solid ${border}`,
        flexShrink: 0,
      }}
    >
      <Box
        sx={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          bgcolor: done ? 'success.main' : accentColor,
          mr: 1.5,
          flexShrink: 0,
          animation: done ? 'none' : 'pulse 1.5s ease-in-out infinite',
          '@keyframes pulse': {
            '0%, 100%': { opacity: 1 },
            '50%': { opacity: 0.4 },
          },
        }}
      />
      <Typography
        sx={{
          color: sidebar.selectedText,
          fontSize: { xs: '0.8rem', sm: '0.85rem' },
          fontWeight: 600,
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        Setting up: {agentName}
      </Typography>
      {done && (
        <CheckCircle
          sx={{ color: 'success.main', fontSize: { xs: 18, sm: 16 }, mr: 1, flexShrink: 0 }}
        />
      )}
      <IconButton
        size={isCompact ? 'medium' : 'small'}
        onClick={handleClose}
        sx={{ color: textColor, flexShrink: 0 }}
        aria-label="Close"
      >
        <Close sx={{ fontSize: { xs: 22, sm: 16 } }} />
      </IconButton>
    </Box>
  );

  const focusTerminal = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const terminalBox = (
    <Box
      ref={containerCallbackRef}
      sx={{
        flex: 1,
        minHeight: 0,
        p: { xs: 0.75, sm: 1 },
        overflow: 'hidden',
        '& .xterm': { height: '100%' },
        '& .xterm-viewport': { overflow: 'hidden !important' },
      }}
    />
  );

  if (isCompact) {
    return (
      <SwipeableDrawer
        anchor="left"
        open={open}
        onClose={handleClose}
        onOpen={() => {}}
        disableSwipeToOpen
        ModalProps={{
          keepMounted: true,
        }}
        slotProps={{
          transition: { onEntered: focusTerminal },
        }}
        sx={{
          '& .MuiDrawer-paper': paperSx,
        }}
      >
        {header}
        {terminalBox}
      </SwipeableDrawer>
    );
  }

  return (
    <Drawer
      anchor="left"
      open={open}
      onClose={handleClose}
      slotProps={{
        transition: { onEntered: focusTerminal },
      }}
      sx={{ '& .MuiDrawer-paper': paperSx }}
    >
      {header}
      {terminalBox}
    </Drawer>
  );
}
