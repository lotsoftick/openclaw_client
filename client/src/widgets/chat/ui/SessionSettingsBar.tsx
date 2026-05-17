import { memo, useCallback } from 'react';
import { Box } from '@mui/material';
import { useGetSessionSettingsQuery, usePatchSessionSettingsMutation } from '../../../entities/agent';
import SettingChip from './SettingChip';

const THINKING_OPTIONS = [
  'inherit',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'adaptive',
  'max',
] as const;
const FAST_OPTIONS = [
  { value: 'inherit', label: 'inherit' },
  { value: 'true', label: 'on' },
  { value: 'false', label: 'off' },
] as const;
const VERBOSE_OPTIONS = [
  { value: 'inherit', label: 'inherit' },
  { value: 'off', label: 'off (explicit)' },
  { value: 'on', label: 'on' },
  { value: 'full', label: 'full' },
] as const;
const REASONING_OPTIONS = ['inherit', 'off', 'on', 'stream'] as const;

interface SessionSettingsBarProps {
  agentId: string;
  conversationId: string;
}

const SessionSettingsBar = memo(function SessionSettingsBar({
  agentId,
  conversationId,
}: SessionSettingsBarProps) {
  const { data } = useGetSessionSettingsQuery(
    { agentId, conversationId },
    { skip: !agentId || !conversationId }
  );
  const [patchSettings] = usePatchSessionSettingsMutation();
  const settings = data?.settings;

  const handleChange = useCallback(
    (field: string, value: string) => {
      const body: Record<string, unknown> = {};
      if (field === 'fastMode') {
        body[field] = value === 'inherit' ? null : value === 'true';
      } else {
        body[field] = value;
      }
      patchSettings({ agentId, conversationId, settings: body });
    },
    [agentId, conversationId, patchSettings]
  );

  const thinking = settings?.thinkingLevel || 'inherit';
  const fast =
    settings?.fastMode === true ? 'true' : settings?.fastMode === false ? 'false' : 'inherit';
  const verbose = settings?.verboseLevel || 'inherit';
  const reasoning = settings?.reasoningLevel || 'inherit';

  return (
    <Box
      sx={{
        px: { xs: 1.5, md: 2 },
        py: 0.75,
        borderBottom: '1px solid',
        borderColor: 'divider',
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        flexWrap: 'wrap',
      }}
    >
      <SettingChip
        label="Thinking"
        value={thinking}
        options={THINKING_OPTIONS}
        onChange={(v) => handleChange('thinkingLevel', v)}
      />
      <SettingChip
        label="Fast"
        value={fast}
        options={FAST_OPTIONS}
        onChange={(v) => handleChange('fastMode', v)}
      />
      <SettingChip
        label="Verbose"
        value={verbose}
        options={VERBOSE_OPTIONS}
        onChange={(v) => handleChange('verboseLevel', v)}
      />
      <SettingChip
        label="Reasoning"
        value={reasoning}
        options={REASONING_OPTIONS}
        onChange={(v) => handleChange('reasoningLevel', v)}
      />
    </Box>
  );
});

export default SessionSettingsBar;
