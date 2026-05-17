import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  FormControlLabel,
  InputAdornment,
  InputLabel,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { Search } from '@mui/icons-material';
import {
  useGetAgentSubagentsQuery,
  useUpdateAgentSubagentsMutation,
  type AgentSubagentsPatch,
} from '../../../../entities/agent';

const THINKING_OPTIONS: { value: string; label: string }[] = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
  { value: 'adaptive', label: 'Adaptive' },
  { value: 'max', label: 'Max' },
];

interface AgentSubagentsProps {
  agentId: string;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s1 = [...a].sort();
  const s2 = [...b].sort();
  return s1.every((x, i) => x === s2[i]);
}

export default function AgentSubagents({ agentId }: AgentSubagentsProps) {
  const { data, isLoading, isError, refetch } = useGetAgentSubagentsQuery(agentId, {
    skip: !agentId,
  });
  const [update, { isLoading: saving, error: saveError }] = useUpdateAgentSubagentsMutation();

  const [restrict, setRestrict] = useState(false);
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [thinking, setThinking] = useState<string>('inherit');
  const [requireAgentId, setRequireAgentId] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');

  const [prevData, setPrevData] = useState(data);
  if (data !== prevData) {
    setPrevData(data);
    if (data) {
      if (data.config.allowAgents === null) {
        setRestrict(false);
        setAllowed(new Set());
      } else {
        setRestrict(true);
        setAllowed(new Set(data.config.allowAgents));
      }
      setThinking(data.config.thinking ?? 'inherit');
      setRequireAgentId(data.config.requireAgentId);
    }
  }

  const filteredAgents = useMemo(() => {
    const list = data?.availableAgents ?? [];
    if (!query.trim()) return list;
    const q = query.trim().toLowerCase();
    return list.filter(
      (a) => a.id.toLowerCase().includes(q) || (a.name ? a.name.toLowerCase().includes(q) : false)
    );
  }, [data, query]);

  const patch = useMemo<AgentSubagentsPatch>(() => {
    if (!data) return {};
    const result: AgentSubagentsPatch = {};

    const currentAllow = data.config.allowAgents;
    const nextAllow = restrict ? [...allowed] : null;
    const changedAllow =
      currentAllow === null
        ? nextAllow !== null
        : nextAllow === null || !sameSet(currentAllow, nextAllow);
    if (changedAllow) result.allowAgents = nextAllow;

    const currentThinking = data.config.thinking;
    const nextThinking = thinking === 'inherit' ? null : thinking;
    if ((currentThinking ?? null) !== (nextThinking ?? null)) result.thinking = nextThinking;

    const currentRequire = data.config.requireAgentId;
    if ((currentRequire ?? null) !== (requireAgentId ?? null))
      result.requireAgentId = requireAgentId;

    return result;
  }, [data, restrict, allowed, thinking, requireAgentId]);

  const dirty = Object.keys(patch).length > 0;

  function toggleAgent(id: string, on: boolean) {
    setAllowed((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function enableAll() {
    setAllowed(new Set((data?.availableAgents ?? []).map((a) => a.id)));
  }

  function disableAll() {
    setAllowed(new Set());
  }

  async function handleSave() {
    try {
      await update({ agentId, patch }).unwrap();
    } catch (err) {
      console.error('Save subagents failed:', err);
    }
  }

  function handleReset() {
    if (!data) return;
    if (data.config.allowAgents === null) {
      setRestrict(false);
      setAllowed(new Set());
    } else {
      setRestrict(true);
      setAllowed(new Set(data.config.allowAgents));
    }
    setThinking(data.config.thinking ?? 'inherit');
    setRequireAgentId(data.config.requireAgentId);
  }

  if (isLoading && !data) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  if (isError || !data) {
    return (
      <Alert
        severity="error"
        action={
          <Button size="small" onClick={() => refetch()}>
            Retry
          </Button>
        }
      >
        Could not load subagent configuration.
      </Alert>
    );
  }

  const rpcError =
    saveError && typeof saveError === 'object' && 'data' in saveError
      ? ((saveError as { data?: { error?: string } }).data?.error ?? 'Failed to save.')
      : null;

  const listDisabled = !restrict || !data.known || saving;
  const activeCount = allowed.size;
  const totalCount = data.availableAgents.length;

  return (
    <Box sx={{ width: '100%', minWidth: 0 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        justifyContent="space-between"
        spacing={1}
        sx={{ mb: 1 }}
      >
        <Box>
          <Typography variant="subtitle2" fontWeight={700}>
            Subagents
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Controls which child agents this one may spawn and what defaults those spawns use.
          </Typography>
        </Box>
        {!data.known && (
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            label="Agent missing from openclaw config"
          />
        )}
      </Stack>

      {rpcError && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {rpcError}
        </Alert>
      )}

      <Stack spacing={1.25}>
        <Box
          sx={{
            borderRadius: 1,
            bgcolor: 'background.paper',
            overflow: 'hidden',
          }}
        >
          <Box sx={{ p: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
            <FormControlLabel
              control={
                <Switch
                  checked={restrict}
                  onChange={(_, v) => setRestrict(v)}
                  disabled={!data.known || saving}
                />
              }
              label={
                <Box>
                  <Typography variant="body2" fontWeight={600}>
                    Restrict to specific child agents
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    When off, this agent can spawn any configured agent.
                  </Typography>
                </Box>
              }
              sx={{ alignItems: 'flex-start', m: 0 }}
            />
          </Box>

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            alignItems={{ xs: 'stretch', sm: 'center' }}
            sx={{ p: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}
          >
            <TextField
              size="small"
              placeholder="Search agents…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              fullWidth
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <Search fontSize="small" />
                  </InputAdornment>
                ),
              }}
            />
            <Typography
              variant="caption"
              sx={{
                color: 'text.secondary',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: '0.7rem',
                whiteSpace: 'nowrap',
                px: { xs: 0, sm: 1 },
              }}
            >
              {restrict ? `${activeCount} / ${totalCount} on` : 'unrestricted'}
            </Typography>
            <Stack direction="row" spacing={0.5}>
              <Button size="small" onClick={enableAll} disabled={listDisabled}>
                All
              </Button>
              <Button size="small" onClick={disableAll} disabled={listDisabled}>
                None
              </Button>
            </Stack>
          </Stack>

          <List dense disablePadding sx={{ maxHeight: 420, overflow: 'auto' }}>
            {filteredAgents.length === 0 && (
              <ListItem>
                <ListItemText
                  primary={
                    <Typography variant="body2" color="text.secondary">
                      {totalCount === 0
                        ? 'No other agents are configured in openclaw.json.'
                        : 'No agents match.'}
                    </Typography>
                  }
                />
              </ListItem>
            )}
            {filteredAgents.map((a) => {
              const on = allowed.has(a.id);
              return (
                <ListItem
                  key={a.id}
                  divider
                  sx={{
                    alignItems: 'flex-start',
                    py: 1,
                    opacity: listDisabled ? 0.55 : 1,
                  }}
                  secondaryAction={
                    <Switch
                      edge="end"
                      size="small"
                      checked={on}
                      onChange={(_, v) => toggleAgent(a.id, v)}
                      disabled={listDisabled}
                      inputProps={{ 'aria-label': `Toggle ${a.id}` }}
                    />
                  }
                >
                  <ListItemText
                    primary={
                      <Typography variant="body2" fontWeight={600}>
                        {a.name ?? a.id}
                      </Typography>
                    }
                    secondary={
                      a.name ? (
                        <Typography
                          variant="caption"
                          sx={{
                            color: 'text.secondary',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontSize: '0.68rem',
                          }}
                        >
                          {a.id}
                        </Typography>
                      ) : null
                    }
                    sx={{ my: 0, pr: 4 }}
                  />
                </ListItem>
              );
            })}
          </List>
        </Box>

        <Box
          sx={{
            borderRadius: 1,
            p: 1.5,
            bgcolor: 'background.paper',
          }}
        >
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} sx={{ mb: 0.5 }}>
            <FormControl fullWidth size="small" disabled={!data.known || saving}>
              <InputLabel id="subagent-thinking-label">Thinking level</InputLabel>
              <Select
                labelId="subagent-thinking-label"
                label="Thinking level"
                value={thinking}
                onChange={(e) => setThinking(String(e.target.value))}
              >
                {THINKING_OPTIONS.map((o) => (
                  <MenuItem key={o.value} value={o.value}>
                    {o.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          <FormControlLabel
            control={
              <Switch
                checked={requireAgentId === true}
                onChange={(_, v) => setRequireAgentId(v ? true : null)}
                disabled={!data.known || saving}
              />
            }
            label={
              <Box>
                <Typography variant="body2" fontWeight={600}>
                  Require explicit agent id
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  When on, subagent calls must specify a target agent rather than auto-resolving.
                </Typography>
              </Box>
            }
            sx={{ alignItems: 'flex-start', m: 0, mt: 0.5 }}
          />
        </Box>
      </Stack>

      <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 1.5 }}>
        <Button size="small" onClick={handleReset} disabled={!dirty || saving}>
          Reset
        </Button>
        <Button
          size="small"
          variant="contained"
          onClick={handleSave}
          disabled={!dirty || saving || !data.known}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </Stack>
    </Box>
  );
}
