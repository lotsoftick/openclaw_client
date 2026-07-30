import { useState, useRef } from 'react';
import { Box, CircularProgress, useTheme } from '@mui/material';
import { SystemUpdateAlt } from '@mui/icons-material';
import { API_BASE_URL } from '../../../../shared/api';
import { useCheckUpdateQuery, useApplyUpdateMutation } from '../../../../entities/update';

export default function UpdateBanner() {
  const theme = useTheme();
  const { sidebar } = theme.palette;
  const [phase, setPhase] = useState<'idle' | 'updating' | 'restarting'>('idle');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data, refetch } = useCheckUpdateQuery(undefined, {
    pollingInterval: 7_200_000,
  });
  const [applyUpdate] = useApplyUpdateMutation();

  const cleanup = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const handleClick = async () => {
    if (phase !== 'idle') return;
    setPhase('updating');

    try {
      const result = await applyUpdate().unwrap();
      if (!result.ok) {
        setPhase('idle');
        return;
      }
    } catch {
      setPhase('idle');
      return;
    }

    let serverWentDown = false;

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/update/status`);
        if (!res.ok) return;

        if (serverWentDown) {
          cleanup();
          window.location.reload();
          return;
        }

        const status = await res.json();
        if (!status.available) {
          cleanup();
          window.location.reload();
        }
      } catch {
        if (!serverWentDown) {
          serverWentDown = true;
          setPhase('restarting');
        }
      }
    }, 3000);

    setTimeout(() => {
      cleanup();
      setPhase('idle');
      refetch();
    }, 900000);
  };

  if (!data?.available && phase === 'idle') return null;

  return (
    <Box
      onClick={handleClick}
      sx={{
        mx: 2,
        mb: 0.5,
        px: 1.5,
        py: 0.75,
        borderRadius: 1.5,
        bgcolor: phase === 'idle' ? 'success.main' : sidebar.hover,
        color: phase === 'idle' ? '#fff' : sidebar.text,
        fontSize: '0.7rem',
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        cursor: phase === 'idle' ? 'pointer' : 'default',
        flexShrink: 0,
        transition: 'opacity 0.2s',
        '&:hover': phase === 'idle' ? { opacity: 0.85 } : {},
      }}
    >
      {phase === 'idle' && (
        <>
          <SystemUpdateAlt sx={{ fontSize: 14 }} />v{data?.latest} available
        </>
      )}
      {phase === 'updating' && (
        <>
          <CircularProgress size={12} sx={{ color: sidebar.text }} />
          Updating...
        </>
      )}
      {phase === 'restarting' && (
        <>
          <CircularProgress size={12} sx={{ color: sidebar.text }} />
          Restarting...
        </>
      )}
    </Box>
  );
}
