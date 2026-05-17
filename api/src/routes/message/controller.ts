import fs from 'fs';
import path from 'path';
import { RequestHandler } from 'express';
import { LessThan, IsNull, In, MoreThan, FindOptionsWhere } from 'typeorm';
import AppDataSource from '../../data-source';
import { Message, Conversation, Agent } from '../../entities';
import {
  ListByConversation,
  Create,
  Chat,
  Destroy,
  MessageFile,
  MessageResponse,
} from '../../@types/message';
import * as ocService from '../../services/openclaw';

/**
 * Resolve the public origin to use when minting URLs back to the client.
 *
 * OpenClaw Client is deployed in two patterns:
 *   1. Local-only: browser on the install host. `Host` header reads
 *      `localhost:<port>` and the API_PUBLIC_URL env (default
 *      `http://localhost:18802`) was historically hardcoded — fine.
 *   2. LAN/Tailscale/IP: browser on a different device. `Host` reads
 *      `<remote-host>:<port>`. A hardcoded localhost URL would point
 *      the remote browser at *its own machine*, breaking workspace
 *      file previews and downloads silently.
 *
 * So we prefer `req.headers.host` (already validated by Express + the
 * cors middleware) and only fall back to the env override / default
 * for non-HTTP callers. `x-forwarded-host` is honoured for users
 * running behind a reverse proxy.
 */
const apiPublicUrl = (req: {
  headers: Record<string, string | string[] | undefined>;
  protocol?: string;
}): string => {
  const envOverride = process.env.API_PUBLIC_URL;
  const xfHost = req.headers['x-forwarded-host'];
  const host = (Array.isArray(xfHost) ? xfHost[0] : xfHost) || req.headers.host;
  if (host) {
    const xfProto = req.headers['x-forwarded-proto'];
    const proto = (Array.isArray(xfProto) ? xfProto[0] : xfProto) || req.protocol || 'http';
    return `${proto}://${host}`;
  }
  return envOverride || 'http://localhost:18802';
};

function stripWrapperTags(text: string): string {
  return text
    .replace(
      /<(?:think|thinking|redacted_thinking)>[\s\S]*?<\/(?:think|thinking|redacted_thinking)>/gi,
      ''
    )
    .replace(/^<(?:final|output|think|thinking|redacted_thinking)\b[^>]*>/i, '')
    .replace(/<\/(?:final|output|think|thinking|redacted_thinking)\s*>\s*$/i, '')
    .replace(/<\/[a-z]*\s*$/i, '')
    .trim();
}

const uploadsDir = path.join(__dirname, '../../public/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const DEFAULT_PAGE_SIZE = 50;

const listByConversation: ListByConversation = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || '', 10) || DEFAULT_PAGE_SIZE, 1),
      200
    );
    const { before } = req.query;

    const msgRepo = AppDataSource.getRepository(Message);

    const where: FindOptionsWhere<Message> = { conversationId: Number(conversationId) };
    if (before) {
      where.createdAt = LessThan(new Date(before));
    }

    const items = await msgRepo.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit + 1,
    });

    const hasMore = items.length > limit;
    if (hasMore) items.pop();

    items.reverse();

    return res.json({ total: items.length, items, hasMore });
  } catch (error) {
    return next(error);
  }
};

const create: Create = async (req, res, next) => {
  try {
    const msgRepo = AppDataSource.getRepository(Message);
    const message = msgRepo.create({
      conversationId: Number(req.body.conversationId),
      text: req.body.text || '',
      role: 'user' as const,
      createdBy: req.user!._id,
      createdAt: new Date(),
    });
    const saved = await msgRepo.save(message);
    const result = Object.fromEntries(
      Object.entries(saved as object).filter(([k]) => k !== 'deletedAt')
    ) as MessageResponse;
    return res.json(result);
  } catch (error) {
    return next(error);
  }
};

const chat: Chat = async (req, res, next) => {
  try {
    const { conversationId, text } = req.body;
    const uploadedFiles = (req.files as Express.Multer.File[]) || [];

    const convRepo = AppDataSource.getRepository(Conversation);
    const agentRepo = AppDataSource.getRepository(Agent);
    const msgRepo = AppDataSource.getRepository(Message);

    const conv = await convRepo.findOneBy({ _id: Number(conversationId) });
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const agent = await agentRepo.findOneBy({ _id: conv.agentId });
    const agentIdForFiles = agent?.openclawAgentId || 'main';

    const publicUrl = apiPublicUrl(req);

    const msgCount = await msgRepo.count({ where: { conversationId: conv._id } });
    if (msgCount === 0) {
      ocService.appendBootstrapImageRule(agentIdForFiles, conv.agentId, publicUrl);
    }

    const filePaths = uploadedFiles.map((uf) =>
      ocService.copyFileToWorkspace(agentIdForFiles, uf.path, uf.originalname)
    );

    const files: MessageFile[] = uploadedFiles.map((f, i) => {
      const savedName = path.basename(filePaths[i]);
      return {
        filename: f.originalname,
        originalName: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
        url: `${publicUrl}/api/agent/${conv.agentId}/workspace/uploads/${encodeURIComponent(savedName)}`,
      };
    });

    const userMessage = msgRepo.create({
      conversationId: Number(conversationId),
      text: text || (files.length ? `[Attached ${files.length} file(s)]` : ''),
      files,
      role: 'user' as const,
      createdBy: req.user!._id,
      createdAt: new Date(),
    });
    const savedUser = await msgRepo.save(userMessage);

    const isFirstMessage = !conv.title && !!text;
    if (isFirstMessage) {
      await convRepo.update(Number(conversationId), { title: text.slice(0, 200) });
    }

    const sessionKey = conv.sessionKey || String(conv._id);

    // Set up SSE headers and stream via the service
    await ocService.runChat(agentIdForFiles, text || '', sessionKey, filePaths, res);

    // runChat will have already ended the response via SSE.
    // Post-stream work: save assistant message and link externalIds.
    // Since runChat uses event listeners and resolves when done,
    // we need a different approach. The SSE is handled by the service
    // and the response is ended there. We handle post-stream in a
    // "response finish" listener.

    // Wait for the response to finish before doing post-stream work
    await new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
    });

    if (!conv.sessionKey) {
      await convRepo.update(Number(conversationId), { sessionKey });
    }

    if (isFirstMessage) {
      ocService
        .patchSessionSettings(agentIdForFiles, sessionKey, { label: text!.slice(0, 200) })
        .catch(() => {});
    }

    // Link the user message to its JSONL externalId so the poll
    // endpoint can recognise it later and skip duplicate inserts.
    // Assistant message persistence is left entirely to the poll
    // endpoint which has robust dedup logic; saving it here as well
    // caused duplicate rows because the JSONL externalId can shift
    // between reads (gateway v4 multi-pass writes).
    try {
      const jsonlMessages = ocService.getSessionMessages(agentIdForFiles, sessionKey);
      if (jsonlMessages.length) {
        const lastUserJsonl = [...jsonlMessages].reverse().find((m) => m.role === 'user');
        if (lastUserJsonl?.externalId) {
          await msgRepo.update(savedUser._id, { externalId: lastUserJsonl.externalId });
        }
      }
    } catch {
      // Non-critical
    }
    return undefined;
  } catch (error) {
    if (!res.headersSent) return next(error);
    return undefined;
  }
};

const destroy: Destroy = async (req, res, next) => {
  try {
    const msgRepo = AppDataSource.getRepository(Message);
    const convRepo = AppDataSource.getRepository(Conversation);
    const agentRepo = AppDataSource.getRepository(Agent);
    const id = Number(req.params.id);

    const msg = await msgRepo.findOneBy({ _id: id });
    await msgRepo.softDelete(id);

    if (msg?.externalId && msg.conversationId) {
      const conv = await convRepo.findOneBy({ _id: msg.conversationId });
      if (conv?.sessionKey) {
        const agent = await agentRepo.findOneBy({ _id: conv.agentId });
        if (agent?.openclawAgentId) {
          ocService.deleteSessionMessage(agent.openclawAgentId, conv.sessionKey, msg.externalId);
        }
      }
    }

    return res.json(null);
  } catch (error) {
    return next(error);
  }
};

const poll: RequestHandler<{ conversationId: string }, unknown, never, { after?: string }> = async (
  req,
  res,
  next
) => {
  try {
    const convId = Number(req.params.conversationId);
    const { after } = req.query;

    const msgRepo = AppDataSource.getRepository(Message);
    const convRepo = AppDataSource.getRepository(Conversation);
    const agentRepo = AppDataSource.getRepository(Agent);

    const conv = await convRepo.findOneBy({ _id: convId });
    if (!conv?.sessionKey) {
      return res.json({ items: [], synced: 0, runStatus: null });
    }

    const agent = await agentRepo.findOneBy({ _id: conv.agentId });
    if (!agent?.openclawAgentId) {
      return res.json({ items: [], synced: 0, runStatus: null });
    }

    /* Run state surfaced to the UI so it can show a banner when the daemon
     * aborted the last run (model idle timeout, error, user cancel). */
    const runStatus = ocService.getSessionRunStatus(agent.openclawAgentId, conv.sessionKey);

    let synced = 0;
    const jsonlMessages = ocService
      .getSessionMessages(agent.openclawAgentId, conv.sessionKey)
      .filter((m) => m.externalId);

    if (jsonlMessages.length) {
      const existingIds = new Set(
        (
          await msgRepo.find({
            where: { conversationId: convId },
            select: ['externalId'],
          })
        )
          .map((m) => m.externalId)
          .filter(Boolean)
      );

      const candidates = jsonlMessages.filter((m) => !existingIds.has(m.externalId));

      // Backfill: earlier versions stripped the `[cron:...]` header before
      // storing user messages. Re-apply the full JSONL text for already-linked
      // messages so they render as scheduled-task events in the UI.
      const cronBackfillSource = jsonlMessages.filter(
        (m) => m.role === 'user' && /^\[cron:/i.test(m.text) && existingIds.has(m.externalId)
      );
      if (cronBackfillSource.length) {
        const linkedUserMessages = await msgRepo.find({
          where: { conversationId: convId, role: 'user' },
          select: ['_id', 'externalId', 'text'],
        });
        const byExternalId = new Map(
          linkedUserMessages.filter((m) => m.externalId).map((m) => [m.externalId!, m])
        );
        const textBackfills = cronBackfillSource
          .map((m) => {
            const row = byExternalId.get(m.externalId);
            if (!row || row.text === m.text) return null;
            return { id: row._id, text: m.text };
          })
          .filter((b): b is { id: number; text: string } => b !== null);
        if (textBackfills.length) {
          await Promise.all(textBackfills.map((b) => msgRepo.update(b.id, { text: b.text })));
        }
      }

      // Link any recent unlinked DB messages (saved by the chat handler
      // before their externalId was known) instead of inserting duplicates.
      const recentCutoff = new Date(Date.now() - 120_000);
      const unlinked = await msgRepo.find({
        where: {
          conversationId: convId,
          externalId: IsNull(),
          createdAt: MoreThan(recentCutoff),
        },
        order: { createdAt: 'ASC' },
      });

      const unlinkedByRole = new Map<string, typeof unlinked>();
      unlinked.forEach((u) => {
        const list = unlinkedByRole.get(u.role) || [];
        list.push(u);
        unlinkedByRole.set(u.role, list);
      });

      const toInsert: typeof candidates = [];
      const updates: Array<{
        id: number;
        externalId: string;
        thinking: string | null;
        toolSteps: NonNullable<(typeof candidates)[number]['toolSteps']> | null;
      }> = [];

      candidates.forEach((m) => {
        const pool = unlinkedByRole.get(m.role);
        if (pool && pool.length > 0) {
          const match = pool.shift()!;
          /* The chat handler may have saved this row pre-stream-completion,
           * before any toolResult had landed in JSONL. We carry the live
           * toolSteps + thinking through the link so the row picks up
           * whatever the JSONL has now (including populated tool outputs). */
          updates.push({
            id: match._id,
            externalId: m.externalId!,
            thinking: m.thinking || null,
            toolSteps: m.toolSteps && m.toolSteps.length > 0 ? m.toolSteps : null,
          });
        } else {
          toInsert.push(m);
        }
      });

      if (updates.length) {
        await Promise.all(
          updates.map((u) => {
            /* TypeORM's update() type widens to _QueryDeepPartialEntity,
             * which doesn't model arbitrary `Record<string, unknown>` shapes
             * inside ToolStep.input. The runtime contract is just
             * "JSON-serialisable patch", so the cast is safe. */
            const patch = {
              externalId: u.externalId,
              thinking: u.thinking,
              toolSteps: u.toolSteps,
            } as unknown as Parameters<typeof msgRepo.update>[1];
            return msgRepo.update(u.id, patch);
          })
        );
        synced += updates.length;
      }

      if (toInsert.length) {
        /* Guard against duplicate assistant rows caused by shifting
         * externalIds. Gateway v4 rewrites JSONL entries during
         * multi-tool-call turns, so the merged externalId changes
         * between polls. Before inserting an assistant candidate,
         * check whether the DB already has a recent assistant row
         * whose text is a prefix of (or equal to) the new text.
         * If so, update that row instead of inserting a duplicate. */
        const recentAssistants = toInsert.some((m) => m.role === 'assistant')
          ? await msgRepo.find({
              where: {
                conversationId: convId,
                role: 'assistant',
                createdAt: MoreThan(new Date(Date.now() - 300_000)),
              },
              order: { _id: 'DESC' },
              take: 10,
            })
          : [];

        const actualInserts: typeof toInsert = [];
        for (const m of toInsert) {
          if (m.role === 'assistant' && m.text) {
            const existing = recentAssistants.find(
              (r) =>
                (r.text && m.text.startsWith(r.text)) ||
                (r.text && r.text.startsWith(m.text)) ||
                r.text === m.text
            );
            if (existing) {
              // Update the existing row with the latest text / externalId
              const patch: Record<string, unknown> = { externalId: m.externalId };
              if (m.text.length >= (existing.text?.length || 0)) patch.text = m.text;
              if (m.thinking) patch.thinking = m.thinking;
              if (m.toolSteps && m.toolSteps.length > 0) patch.toolSteps = m.toolSteps;
              await msgRepo.update(
                existing._id,
                patch as unknown as Parameters<typeof msgRepo.update>[1]
              );
              // Update the row in recentAssistants so subsequent candidates
              // can also match against it with the new text.
              existing.text = m.text.length >= (existing.text?.length || 0) ? m.text : existing.text;
              existing.externalId = m.externalId!;
              synced++;
              continue;
            }
          }
          actualInserts.push(m);
        }

        if (actualInserts.length) {
          await msgRepo.save(
            actualInserts.map((m) =>
              msgRepo.create({
                conversationId: convId,
                externalId: m.externalId,
                text: m.text,
                thinking: m.thinking || null,
                toolSteps: m.toolSteps && m.toolSteps.length > 0 ? m.toolSteps : null,
                files: [],
                role: m.role as 'user' | 'assistant',
                createdBy: req.user!._id,
                createdAt: m.timestamp ? new Date(m.timestamp) : new Date(),
              })
            )
          );
          synced += actualInserts.length;
        }
      }

      /* Refresh already-linked assistant rows against the current JSONL.
       *
       *  - toolSteps: a long-running tool finishes AFTER its parent assistant
       *    turn was first synced; the toolResult lands in JSONL on a later
       *    poll, so without this pass `output` stays null forever.
       *  - text / thinking: OpenClaw 2026.5.12 (gateway v4) writes each
       *    assistant turn twice in JSONL; older rows stored the concatenated
       *    doubled text. Now that `parseMessagesFromJsonl` dedupes, we
       *    overwrite the stale doubled value so the UI heals on next poll.
       *
       *  We compare canonical JSON to skip no-op writes. */
      const liveAssistants = jsonlMessages.filter(
        (m) => m.role === 'assistant' && m.externalId
      );
      if (liveAssistants.length) {
        const liveIds = liveAssistants.map((m) => m.externalId!);
        const existing = await msgRepo.find({
          where: {
            conversationId: convId,
            role: 'assistant',
            externalId: In(liveIds),
          },
          select: ['_id', 'externalId', 'text', 'thinking', 'toolSteps'],
        });
        const dbByExt = new Map(existing.map((m) => [m.externalId!, m]));
        type RefreshPatch = {
          id: number;
          patch: Partial<{
            text: string;
            thinking: string | null;
            toolSteps: (typeof liveAssistants)[number]['toolSteps'];
          }>;
        };
        const refreshes: RefreshPatch[] = [];
        liveAssistants.forEach((m) => {
          const row = dbByExt.get(m.externalId!);
          if (!row) return;
          const patch: RefreshPatch['patch'] = {};
          if (m.text && m.text !== row.text) patch.text = m.text;
          if ((m.thinking ?? null) !== (row.thinking ?? null)) {
            patch.thinking = m.thinking ?? null;
          }
          const liveStepsJson = JSON.stringify(m.toolSteps ?? null);
          const dbStepsJson = JSON.stringify(row.toolSteps ?? null);
          if (liveStepsJson !== dbStepsJson) patch.toolSteps = m.toolSteps;
          if (Object.keys(patch).length > 0) {
            refreshes.push({ id: row._id, patch });
          }
        });
        if (refreshes.length) {
          await Promise.all(
            refreshes.map((r) => {
              const patch = r.patch as unknown as Parameters<typeof msgRepo.update>[1];
              return msgRepo.update(r.id, patch);
            })
          );
          synced += refreshes.length;
        }
      }
    }

    const where: FindOptionsWhere<Message> = { conversationId: convId };
    if (after) {
      where.createdAt = MoreThan(new Date(after));
    }

    const items = await msgRepo.find({
      where,
      order: { createdAt: 'ASC' },
      take: 200,
    });

    return res.json({ items, synced, runStatus });
  } catch (error) {
    return next(error);
  }
};

export { listByConversation, create, chat, destroy, poll };
