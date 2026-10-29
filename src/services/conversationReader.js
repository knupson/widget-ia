const fs = require('fs');
const path = require('path');
const os = require('os');
const v8 = require('v8');

/**
 * Desempaqueta bloques físicos de 32KB del Write-Ahead Log (.log) de LevelDB
 */
function unpackLevelDbWal(buf) {
  const BLOCK_SIZE = 32768;
  const records = [];
  let current = [];
  let offset = 0;
  while (offset < buf.length) {
    const blockEnd = Math.min(offset + BLOCK_SIZE, buf.length);
    let pos = offset;
    while (pos + 7 <= blockEnd) {
      const len = buf.readUInt16LE(pos + 4);
      const type = buf[pos + 6];
      if (type === 0 || type > 4 || pos + 7 + len > blockEnd) break;
      const chunk = buf.subarray(pos + 7, pos + 7 + len);
      if (type === 1) {
        records.push(chunk);
        current = [];
      } else if (type === 2) {
        current = [chunk];
      } else if (type === 3 && current.length > 0) {
        current.push(chunk);
      } else if (type === 4 && current.length > 0) {
        current.push(chunk);
        records.push(Buffer.concat(current));
        current = [];
      }
      pos += 7 + len;
    }
    offset += BLOCK_SIZE;
  }
  return records;
}

function cleanAgyUserPrompt(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  const match = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  // Si es un resumen de contexto sin USER_REQUEST explícito, extraer última solicitud si existe
  const withoutContext = rawContent.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '').trim();
  return withoutContext || rawContent.trim().slice(0, 600);
}

function summarizeToolCall(tc) {
  if (!tc || typeof tc !== 'object') return null;
  const name = tc.name || tc.ToolName || tc.tool_name || 'tool';
  let args = tc.arguments || tc.args || tc.input || {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = { raw: args };
    }
  }
  let detail = '';
  if (args.CommandLine || args.command) {
    detail = String(args.CommandLine || args.command).slice(0, 120);
  } else if (args.Path || args.file_path || args.path) {
    detail = path.basename(String(args.Path || args.file_path || args.path));
  } else if (args.query || args.Query) {
    detail = String(args.query || args.Query).slice(0, 80);
  } else if (args.toolSummary) {
    detail = String(args.toolSummary).slice(0, 80);
  }
  return { name, detail };
}

/**
 * Lee los mensajes de una conversación de Antigravity CLI (AGY)
 */
function readAgyConversation(convId, limit = 60) {
  const safeId = String(convId || '').replace(/^agy:/i, '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return [];

  const logsDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', safeId, '.system_generated', 'logs');
  const compactPath = path.join(logsDir, 'transcript.jsonl');
  const fullPath = path.join(logsDir, 'transcript_full.jsonl');

  if (!fs.existsSync(compactPath)) return [];

  let lines = [];
  let fullLines = null;
  try {
    lines = fs.readFileSync(compactPath, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }

  const messages = [];
  const startIdx = Math.max(0, lines.length - 220);

  for (let i = startIdx; i < lines.length; i++) {
    let step;
    try {
      step = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!step || typeof step !== 'object') continue;

    // Si el contenido fue truncado en transcript.jsonl, cargar la línea específica de transcript_full.jsonl
    if (
      Array.isArray(step.truncated_fields) &&
      step.truncated_fields.includes('content') &&
      fs.existsSync(fullPath)
    ) {
      try {
        if (!fullLines) {
          fullLines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/).filter(Boolean);
        }
        if (fullLines[i]) {
          const fullStep = JSON.parse(fullLines[i]);
          if (fullStep && fullStep.content) {
            step.content = fullStep.content;
          }
        }
      } catch {}
    }

    const ts = step.created_at ? Date.parse(step.created_at) || Date.now() : Date.now();

    if (step.type === 'USER_INPUT') {
      const text = cleanAgyUserPrompt(step.content);
      if (!text) continue;
      messages.push({
        id: `agy-u-${step.step_index ?? i}`,
        role: 'user',
        text,
        tools: [],
        timestamp: ts
      });
    } else if (step.type === 'PLANNER_RESPONSE') {
      const text = typeof step.content === 'string' ? step.content.trim() : '';
      const rawTools = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      const tools = [];
      let question = null;

      for (const tc of rawTools) {
        const summarized = summarizeToolCall(tc);
        if (summarized) tools.push(summarized);
        const tName = tc.name || tc.ToolName || '';
        if (tName.includes('ask_question')) {
          let args = tc.arguments || tc.args || tc.input || {};
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {}
          }
          const qItem = Array.isArray(args.questions) ? args.questions[0] : null;
          if (qItem && qItem.question) {
            question = {
              text: qItem.question,
              options: Array.isArray(qItem.options) ? qItem.options : []
            };
          }
        }
      }

      if (!text && tools.length === 0 && !question) continue;

      // Si el mensaje anterior ya era de assistant sin texto y este solo agrega herramientas, fusionar
      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'assistant' && !prev.text && !text && !question) {
        prev.tools.push(...tools);
        prev.timestamp = ts;
      } else {
        messages.push({
          id: `agy-a-${step.step_index ?? i}`,
          role: 'assistant',
          text,
          tools,
          question,
          timestamp: ts
        });
      }
    }
  }

  return messages.slice(-limit);
}

/**
 * Localiza el archivo .jsonl de una sesión de Claude Code CLI en ~/.claude/projects
 */
function findClaudeSessionJsonl(sessionId) {
  const safeId = String(sessionId || '')
    .replace(/^claude:/i, '')
    .replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;

  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsRoot)) return null;

  try {
    const folders = fs.readdirSync(projectsRoot);
    for (const folder of folders) {
      const candidate = path.join(projectsRoot, folder, `${safeId}.jsonl`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {}
  return null;
}

function extractClaudeBlocks(content) {
  let textParts = [];
  let tools = [];
  let isToolResultOnly = false;

  if (typeof content === 'string') {
    const clean = content
      .replace(/<command-message>[\s\S]*?<\/command-message>/gi, '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
      .trim();
    if (clean) textParts.push(clean);
  } else if (Array.isArray(content)) {
    let hasToolResult = false;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        const clean = block.text
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
          .trim();
        if (clean) textParts.push(clean);
      } else if (block.type === 'tool_use') {
        const summarized = summarizeToolCall({
          name: block.name,
          input: block.input
        });
        if (summarized) tools.push(summarized);
      } else if (block.type === 'tool_result') {
        hasToolResult = true;
      }
    }
    if (hasToolResult && textParts.length === 0) {
      isToolResultOnly = true;
    }
  }

  return {
    text: textParts.join('\n\n').trim(),
    tools,
    isToolResultOnly
  };
}

/**
 * Lee los mensajes de una sesión de Claude Code CLI
 */
function readClaudeCliConversation(sessionId, limit = 60) {
  const jsonlPath = findClaudeSessionJsonl(sessionId);
  if (!jsonlPath) return [];

  let lines = [];
  try {
    lines = fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }

  const messages = [];
  const startIdx = Math.max(0, lines.length - 260);

  for (let i = startIdx; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    const ts = entry.timestamp ? Date.parse(entry.timestamp) || Date.now() : Date.now();
    if (entry.type === 'user' && entry.message) {
      const { text, isToolResultOnly } = extractClaudeBlocks(entry.message.content);
      if (isToolResultOnly || !text) continue;
      messages.push({
        id: entry.uuid || `cl-u-${i}`,
        role: 'user',
        text,
        tools: [],
        timestamp: ts
      });
    } else if (entry.type === 'assistant' && entry.message) {
      const { text, tools } = extractClaudeBlocks(entry.message.content);
      if (!text && tools.length === 0) continue;

      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'assistant') {
        if (text && (!prev.text || !prev.text.includes(text))) {
          prev.text = prev.text ? `${prev.text}\n\n${text}` : text;
        }
        if (tools.length > 0) {
          prev.tools.push(...tools);
        }
        prev.timestamp = ts;
      } else {
        messages.push({
          id: entry.uuid || `cl-a-${i}`,
          role: 'assistant',
          text,
          tools,
          timestamp: ts
        });
      }
    }
  }

  return messages.slice(-limit);
}

/**
 * Lee los mensajes en vivo de una conversación de Claude Desktop App desde IndexedDB LevelDB
 */
function readClaudeDesktopConversation(uuid, limit = 60) {
  const cleanUuid = String(uuid || '')
    .replace(/^claude-app:/i, '')
    .trim();
  if (!cleanUuid) return [];

  const appDataDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude');
  const idbDir = path.join(appDataDir, 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb');
  if (!fs.existsSync(idbDir)) return [];

  const nodeV8Ver = v8.serialize(0)[1];
  const pat = Buffer.from('o"\x10conversationUuid');
  let bestMessages = [];
  let bestUpdatedAt = 0;

  try {
    const files = fs
      .readdirSync(idbDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => path.join(idbDir, f));

    for (const logPath of files) {
      const buf = fs.readFileSync(logPath);
      const records = unpackLevelDbWal(buf);
      for (const rec of records) {
        let searchFrom = 0;
        while (searchFrom < rec.length) {
          const idx = rec.indexOf(pat, searchFrom);
          if (idx === -1) break;
          searchFrom = idx + pat.length;
          try {
            const payload = Buffer.concat([Buffer.from([0xff, nodeV8Ver]), rec.subarray(idx)]);
            const val = v8.deserialize(payload);
            if (val && val.conversationUuid === cleanUuid) {
              const tree = val.tree && typeof val.tree === 'object' ? val.tree : val;
              const rawMsgs = Array.isArray(tree.chat_messages)
                ? tree.chat_messages
                : Array.isArray(val.messages)
                  ? val.messages
                  : [];
              const upd = Math.max(
                Number(val.writtenAt) || 0,
                Number(val.fetchedAt) || 0,
                rawMsgs.length
              );
              if (rawMsgs.length > 0 && upd >= bestUpdatedAt) {
                bestUpdatedAt = upd;
                bestMessages = rawMsgs;
              }
            }
          } catch {}
        }
      }
    }
  } catch {}

  const normalized = [];
  for (let i = 0; i < bestMessages.length; i++) {
    const m = bestMessages[i];
    if (!m) continue;
    let txt = '';
    if (typeof m.text === 'string' && m.text.trim()) {
      txt = m.text.trim();
    } else if (Array.isArray(m.content)) {
      txt = m.content
        .filter((b) => b && b.type === 'text' && b.text)
        .map((b) => b.text.trim())
        .join('\n\n');
    }
    if (!txt) continue;
    normalized.push({
      id: m.uuid || `clapp-${i}`,
      role: m.sender === 'human' ? 'user' : 'assistant',
      text: txt,
      tools: [],
      timestamp: m.created_at ? Date.parse(m.created_at) || Date.now() : Date.now()
    });
  }

  return normalized.slice(-limit);
}

/**
 * Obtiene el historial de mensajes normalizado de cualquier sesión (AGY, Claude CLI, Claude App o Remota)
 */
function getSessionMessages(idOrSessionId, snapshotSessions = []) {
  const raw = String(idOrSessionId || '').trim();
  if (!raw) return { ok: false, messages: [] };

  const sessionMeta = snapshotSessions.find((s) => s.id === raw || s.sessionId === raw) || null;

  let messages = [];
  if (raw.startsWith('agy:') || (sessionMeta && sessionMeta.provider === 'agy' && !sessionMeta.isRemote)) {
    const convId = sessionMeta ? sessionMeta.sessionId : raw.replace(/^agy:/i, '');
    messages = readAgyConversation(convId);
  } else if (raw.startsWith('claude-app:') || (sessionMeta && sessionMeta.surface === 'app')) {
    const uuid = sessionMeta ? sessionMeta.sessionId : raw.replace(/^claude-app:/i, '');
    messages = readClaudeDesktopConversation(uuid);
  } else if (raw.startsWith('remote:') || (sessionMeta && sessionMeta.isRemote)) {
    if (sessionMeta && sessionMeta.lastMessage) {
      messages = [
        {
          id: `${raw}-last`,
          role: 'assistant',
          text: sessionMeta.lastMessage,
          tools: sessionMeta.currentAction ? [{ name: 'status', detail: sessionMeta.currentAction }] : [],
          timestamp: sessionMeta.updatedAt || Date.now()
        }
      ];
    }
  } else {
    const sessId = sessionMeta ? sessionMeta.sessionId : raw.replace(/^claude:/i, '');
    messages = readClaudeCliConversation(sessId);
  }

  // Si por algún motivo no hubo mensajes en el archivo pero la sesión tiene lastMessage o título en memoria, incluirlo
  if (messages.length === 0 && sessionMeta) {
    const fallbackText =
      sessionMeta.lastMessage ||
      (sessionMeta.surface === 'app'
        ? `Conversación de Claude Desktop App: "${sessionMeta.title || sessionMeta.sessionId}". Podés enviar una respuesta abajo para escribir directamente en la ventana de Claude App.`
        : sessionMeta.title || '');
    if (fallbackText) {
      messages.push({
        id: `${raw}-fallback`,
        role: 'assistant',
        text: fallbackText,
        tools: sessionMeta.currentAction ? [{ name: 'action', detail: sessionMeta.currentAction }] : [],
        timestamp: sessionMeta.updatedAt || Date.now()
      });
    }
  }

  return {
    ok: true,
    session: sessionMeta
      ? {
          id: sessionMeta.id,
          sessionId: sessionMeta.sessionId,
          provider: sessionMeta.provider,
          providerLabel: sessionMeta.providerLabel,
          surface: sessionMeta.surface,
          isOpen: sessionMeta.isOpen,
          state: sessionMeta.state,
          title: sessionMeta.title,
          projectName: sessionMeta.projectName,
          workspace: sessionMeta.workspace,
          pid: sessionMeta.pid,
          currentAction: sessionMeta.currentAction
        }
      : { id: raw },
    messages
  };
}

module.exports = {
  getSessionMessages
};
