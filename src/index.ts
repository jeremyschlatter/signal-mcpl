#!/usr/bin/env node
/**
 * signal-mcpl v0.5.0 — MCPL server bridging Signal via signal-cli daemon (HTTP JSON-RPC + SSE).
 * Exposes Signal DMs and group chats as MCPL channels, plus a signal_send tool.
 * DMs:    channel signal:dm:<uuid>      tags: chat:dm, chat:addressed, chat:from-human
 * Groups: channel signal:group:<gid>    tags: chat:ambient, chat:from-human
 */
import { McplConnection, method } from '@animalabs/mcpl-core';
import type { FeatureSetDeclaration, JsonRpcId } from '@animalabs/mcpl-core';
import * as fs from 'node:fs';

const ACCOUNT = process.env.SIGNAL_ACCOUNT ?? '';
const ATTACH_DIR = process.env.SIGNAL_ATTACH_DIR ?? `${process.env.HOME}/.local/share/signal-cli/attachments`;
const ATTACH_MAX = Number(process.env.SIGNAL_ATTACH_MAX_BYTES ?? 4_000_000);
const DAEMON = process.env.SIGNAL_DAEMON_URL ?? 'http://127.0.0.1:8090';
const DM_USERS = (process.env.SIGNAL_DM_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const DEBUG_LOG = process.env.SIGNAL_DEBUG_LOG ?? '';
const CONTACTS_FILE = process.env.SIGNAL_CONTACTS_FILE ?? '';

function dbg(tag: string, data?: unknown): void {
  if (!DEBUG_LOG) return;
  try { fs.appendFileSync(DEBUG_LOG, JSON.stringify({ ts: new Date().toISOString(), tag, data }) + '\n'); } catch { /* ignore */ }
}

const featureSets: FeatureSetDeclaration[] = [
  { name: 'signal.messaging', description: 'Signal private + group messaging via signal-cli daemon', uses: ['tools', 'channels'], rollback: false, hostState: false },
];

const toolDefinitions = [
  {
    name: 'signal_send',
    description: 'Send a Signal message to an arbitrary recipient: E.164 phone number (+1...), account UUID, or username (u:name.NNN). For existing conversations, prefer replying on the Signal channel directly. Markdown bold/italic/strikethrough/code renders as Signal text styles; other markdown (headers, links, lists) is sent as plain text.',
    inputSchema: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'Phone number, UUID, or u:username' },
        message: { type: 'string', description: 'Message text' },
      },
      required: ['recipient', 'message'],
    },
  },
  {
    name: 'signal_react',
    description: 'React to a Signal message with an emoji. targetTimestamp is the messageId of the message being reacted to; targetAuthor is the UUID of its author.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: "Channel the message lives in: 'signal:dm:<uuid>' or 'signal:group:<gid>'" },
        targetAuthor: { type: 'string', description: 'UUID (or number) of the author of the message being reacted to' },
        targetTimestamp: { type: 'number', description: 'Timestamp/messageId of the target message' },
        emoji: { type: 'string', description: 'Emoji to react with (e.g. \u{1F56F})' },
        remove: { type: 'boolean', description: 'Remove a previous reaction instead of adding (default false)' },
      },
      required: ['channelId', 'targetAuthor', 'targetTimestamp', 'emoji'],
    },
  },
];


/**
 * Markdown -> Signal text styles (BodyRange). Converts the subset Signal can
 * express (bold/italic/strikethrough/mono); headers/links/lists pass through
 * as literal text. Offsets are UTF-16 code units == JS string indices.
 * Returns textStyle entries in signal-cli's "start:length:STYLE" format.
 * Origin: Claude Code draft 2026-07-25 (~/signal-mcpl-markdown.patch), applied
 * semantically onto v0.3.0.
 */
function markdownToSignal(md: string): { message: string; textStyle: string[] } {
  type Range = { start: number; end: number; style: string }; // end exclusive
  let text = md;
  let ranges: Range[] = [];
  const passes: Array<{ re: RegExp; style: string; pre: (m: RegExpMatchArray) => number }> = [
    { re: /```[^\n]*\n([\s\S]*?)\n?```/g, style: 'MONOSPACE', pre: m => m[0].indexOf('\n') + 1 },
    { re: /`([^`\n]+)`/g, style: 'MONOSPACE', pre: () => 1 },
    { re: /\*\*(\S(?:[^\n]*?\S)?)\*\*/g, style: 'BOLD', pre: () => 2 },
    { re: /\*(\S(?:[^*\n]*\S)?)\*/g, style: 'ITALIC', pre: () => 1 },
    { re: /~~(\S(?:[^~\n]*\S)?)~~/g, style: 'STRIKETHROUGH', pre: () => 2 },
  ];
  for (const { re, style, pre } of passes) {
    const removals: Array<{ pos: number; len: number }> = [];
    const added: Range[] = [];
    let out = '';
    let last = 0;
    for (const m of text.matchAll(re)) {
      const idx = m.index!;
      const end = idx + m[0].length;
      if (ranges.some(r => r.style === 'MONOSPACE' && idx < r.end && end > r.start)) continue;
      const p = pre(m);
      const content = m[1];
      removals.push({ pos: idx, len: p }, { pos: idx + p + content.length, len: end - idx - p - content.length });
      out += text.slice(last, idx);
      if (content) added.push({ start: out.length, end: out.length + content.length, style });
      out += content;
      last = end;
    }
    if (!removals.length) continue;
    out += text.slice(last);
    const shift = (pos: number) => pos - removals.reduce((n, r) => n + (r.pos < pos ? r.len : 0), 0);
    ranges = [...ranges.map(r => ({ ...r, start: shift(r.start), end: shift(r.end) })), ...added];
    text = out;
  }
  return { message: text, textStyle: ranges.map(r => `${r.start}:${r.end - r.start}:${r.style}`) };
}

/** Persistent name map. Keys: '<uuid>' for DMs, 'group:<groupId>' for groups. */
function loadContacts(): Record<string, string> {
  if (!CONTACTS_FILE) return {};
  try {
    const j = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}
function saveContacts(c: Record<string, string>): void {
  if (!CONTACTS_FILE) return;
  try { fs.writeFileSync(CONTACTS_FILE, JSON.stringify(c, null, 2)); } catch { /* ignore */ }
}

class SignalMcpl {
  private conn!: McplConnection;
  private contacts: Record<string, string> = loadContacts();
  private registered = new Set<string>();
  private mcplMode = false;

  private async rpc(m: string, params: unknown): Promise<any> {
    const res = await fetch(`${DAEMON}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: m, params }),
    });
    const j: any = await res.json();
    if (j.error) throw new Error(`signal-cli ${m}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
  }

  private descriptorFor(key: string): any {
    const name = this.contacts[key] ?? key;
    return key.startsWith('group:')
      ? { id: `signal:group:${key.slice(6)}`, type: 'group', label: `Signal group: ${name}`, direction: 'bidirectional' }
      : { id: `signal:dm:${key}`, type: 'dm', label: `Signal DM: ${name}`, direction: 'bidirectional' };
  }

  private descriptors(): any[] {
    return Object.keys(this.contacts).map(k => this.descriptorFor(k));
  }

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    const first: any = await conn.nextMessage();
    const freq: any = first?.request ?? first;
    if (!first || first.type !== 'request' || freq.method !== 'initialize') throw new Error('expected initialize request first');
    this.mcplMode = freq.params?.capabilities?.experimental?.mcpl !== undefined;
    conn.sendResponse(freq.id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
        ...(this.mcplMode ? { experimental: { mcpl: { version: '0.4', pushEvents: false, channels: true, rollback: false, featureSets } } } : {}),
      },
      serverInfo: { name: 'signal-mcpl', version: '0.5.0' },
    });
    dbg('initialized', { mcplMode: this.mcplMode, known: Object.keys(this.contacts).length, whitelist: DM_USERS.length });
    if (this.mcplMode) {
      const ds = this.descriptors();
      if (ds.length) {
        conn.sendRequest(method.CHANNELS_REGISTER, { channels: ds })
          .then(() => { ds.forEach(d => this.registered.add(d.id)); dbg('channels-registered', ds.map(d => d.id)); })
          .catch(e => dbg('register-failed', String(e)));
      }
    }
    void this.startSse();
    for (;;) {
      let msg: any;
      try { msg = await conn.nextMessage(); } catch { break; }
      if (!msg) break;
      if (msg.type !== 'request') continue;
      const req: any = msg.request ?? msg;
      try { await this.handleRequest(req); } catch (e: any) { conn.sendError(req.id, -32000, String(e?.message ?? e)); }
    }
  }

  private async handleRequest(req: any): Promise<void> {
    const id: JsonRpcId = req.id;
    switch (req.method) {
      case 'tools/list': this.conn.sendResponse(id, { tools: toolDefinitions }); return;
      case 'tools/call': {
        const r = await this.handleToolCall(String(req.params?.name ?? ''), req.params?.arguments ?? {});
        this.conn.sendResponse(id, r); return;
      }
      case method.CHANNELS_LIST: this.conn.sendResponse(id, { channels: this.descriptors() }); return;
      case method.CHANNELS_OPEN:
      case method.CHANNELS_CLOSE: this.conn.sendResponse(id, {}); return;
      case method.CHANNELS_PUBLISH: {
        const r = await this.publish(req.params ?? {});
        this.conn.sendResponse(id, r); return;
      }
      default: this.conn.sendError(id, -32601, `Method not found: ${req.method}`);
    }
  }

  private async publish(p: any): Promise<any> {
    const cid: string = String(p.channelId ?? '');
    let target: any = null;
    if (cid.startsWith('signal:dm:')) target = { recipient: [cid.slice('signal:dm:'.length)] };
    else if (cid.startsWith('signal:group:')) target = { groupId: cid.slice('signal:group:'.length) };
    if (!target) { dbg('publish-unknown-channel', cid); return { delivered: false }; }
    const text = (Array.isArray(p.content) ? p.content : [])
      .filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('\n').trim();
    if (!text) return { delivered: false };
    const { message, textStyle } = markdownToSignal(text);
    const r = await this.rpc('send', { ...target, message, ...(textStyle.length ? { textStyle } : {}) });
    dbg('published', { cid, ts: r?.timestamp });
    return { delivered: true, messageId: String(r?.timestamp ?? Date.now()) };
  }

  private async handleToolCall(name: string, args: any): Promise<any> {
    const text = (t: string, isError?: boolean) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
    if (name === 'signal_send') {
      const rec = String(args.recipient ?? '').trim();
      const msg = String(args.message ?? '');
      if (!rec || !msg) return text('recipient and message are required', true);
      try {
        const conv = markdownToSignal(msg);
        const r = await this.rpc('send', { recipient: [rec], message: conv.message, ...(conv.textStyle.length ? { textStyle: conv.textStyle } : {}) });
        return text(`Sent (timestamp ${r?.timestamp}).`);
      } catch (e: any) { return text(`Send failed: ${e?.message ?? e}`, true); }
    }
    if (name === 'signal_react') {
      const cid = String(args.channelId ?? '').trim();
      const emoji = String(args.emoji ?? '');
      const ta = String(args.targetAuthor ?? '').trim();
      const ts = Number(args.targetTimestamp ?? 0);
      if (!cid || !emoji || !ta || !ts) return text('channelId, targetAuthor, targetTimestamp, emoji are required', true);
      let target: any = null;
      if (cid.startsWith('signal:dm:')) target = { recipient: [cid.slice('signal:dm:'.length)] };
      else if (cid.startsWith('signal:group:')) target = { groupId: cid.slice('signal:group:'.length) };
      else return text(`Unknown channelId form: ${cid}`, true);
      try {
        await this.rpc('sendReaction', { ...target, emoji, targetAuthor: ta, targetTimestamp: ts, remove: !!args.remove });
        return text(`Reacted ${emoji}${args.remove ? ' (removed)' : ''}.`);
      } catch (e: any) { return text(`Reaction failed: ${e?.message ?? e}`, true); }
    }
    return text(`Unknown tool: ${name}`, true);
  }

  private async startSse(): Promise<void> {
    for (;;) {
      try {
        const res = await fetch(`${DAEMON}/api/v1/events`, { headers: { Accept: 'text/event-stream' } });
        if (!res.ok || !res.body) throw new Error(`SSE http ${res.status}`);
        dbg('sse-connected');
        const reader = (res.body as any).getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            this.handleSseFrame(frame);
          }
        }
        throw new Error('SSE stream ended');
      } catch (e: any) {
        dbg('sse-error', String(e?.message ?? e));
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  private handleSseFrame(frame: string): void {
    let event = 'message';
    const datas: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) datas.push(line.slice(5).trim());
    }
    if (event !== 'receive' || datas.length === 0) return;
    try { void this.handleEnvelope(JSON.parse(datas.join('\n'))); } catch (e: any) { dbg('sse-parse-error', String(e)); }
  }

  private async handleEnvelope(ev: any): Promise<void> {
    const env = ev?.envelope;
    if (!env) return;
    const dm = env.dataMessage;
    if (!dm) return;
    const uuid: string = String(env.sourceUuid ?? env.source ?? '');
    if (!uuid) return;
    const number: string = String(env.sourceNumber ?? '');
    if (DM_USERS.length && !DM_USERS.includes(uuid) && !(number && DM_USERS.includes(number))) {
      dbg('drop-not-whitelisted', { uuid, number }); return;
    }
    const name: string = String(env.sourceName || this.contacts[uuid] || uuid.slice(0, 8));
    const gi = dm.groupInfo;
    let channelId: string;
    let tags: string[];
    if (gi?.groupId) {
      const gid = String(gi.groupId);
      await this.ensureGroup(gid);
      channelId = `signal:group:${gid}`;
      tags = ['chat:ambient', 'chat:from-human'];
    } else {
      await this.ensureKey(uuid, name);
      channelId = `signal:dm:${uuid}`;
      tags = ['chat:dm', 'chat:addressed', 'chat:from-human'];
    }
    const rx = (dm as any).reaction;
    if (rx && rx.emoji) {
      // [v0.3.0] Incoming reaction -> non-waking notice (gate rule 'signal-reaction-defer' defers chat:reaction)
      const selfUuid = process.env.SIGNAL_SELF_UUID ?? '';
      const isMe = (!!ACCOUNT && String(rx.targetAuthorNumber ?? '') === ACCOUNT) || (!!selfUuid && String(rx.targetAuthorUuid ?? '') === selfUuid);
      const loc = gi?.groupId ? `[${this.contacts['group:' + String(gi.groupId)] ?? 'Signal group'}] ` : '';
      const verb = rx.isRemove ? 'removed their reaction' : 'reacted';
      const tgt = isMe ? 'your message' : `a message from ${String(rx.targetAuthorUuid ?? rx.targetAuthor ?? '?').slice(0, 8)}`;
      const rmsg = {
        channelId,
        messageId: String(env.timestamp ?? Date.now()),
        author: { id: uuid, name },
        timestamp: new Date(Number(env.timestamp ?? Date.now())).toISOString(),
        content: [{ type: 'text', text: `${loc}[reaction] ${name} ${verb} ${rx.emoji} on ${tgt} (ts ${rx.targetSentTimestamp})` }],
        tags: ['chat:reaction', 'chat:from-human', ...(isMe ? ['chat:to-self'] : []), 'chat:ambient'],
      };
      try {
        await this.conn.sendRequest(method.CHANNELS_INCOMING, { messages: [rmsg] });
        dbg('reaction-delivered', { channelId, emoji: rx.emoji, isMe, remove: !!rx.isRemove });
      } catch (e: any) { dbg('reaction-failed', String(e?.message ?? e)); }
      return;
    }
    const body0: string = String(dm.message ?? '');
    // [v0.5.0] Bridge image attachments as base64 ImageContent blocks.
    // signal-cli saves attachments to ATTACH_DIR keyed by the envelope id.
    const atts: any[] = Array.isArray(dm.attachments) ? dm.attachments : [];
    const imageBlocks: any[] = [];
    const attNotes: string[] = [];
    for (const a of atts) {
      const ct = String(a?.contentType ?? '');
      const aid = String(a?.id ?? '');
      const size = Number(a?.size ?? 0);
      const fname = String(a?.filename ?? aid ?? 'attachment');
      if (ct.startsWith('image/') && aid && size <= ATTACH_MAX) {
        try {
          let p = `${ATTACH_DIR}/${aid}`;
          if (!fs.existsSync(p)) {
            const ext = ct.split('/')[1]?.split('+')[0];
            if (ext && fs.existsSync(`${p}.${ext}`)) p = `${p}.${ext}`;
          }
          imageBlocks.push({ type: 'image', data: fs.readFileSync(p).toString('base64'), mimeType: ct });
          attNotes.push(`[image attached: ${fname}]`);
          continue;
        } catch (e: any) { dbg('attachment-read-failed', { aid, err: String(e?.message ?? e) }); }
      }
      attNotes.push(`[attachment not bridged: ${fname} (${ct || 'unknown'}, ${size}b)]`);
    }
    const bodyRaw = body0 + (attNotes.length ? `${body0 ? '\n' : ''}${attNotes.join('\n')}` : '');
    if (!bodyRaw && !imageBlocks.length) return;
    // [2026-07-23] Author/location prefix embedded in the TEXT, mirroring
    // discord-mcpl (server.ts renderedContent): the host stores author only
    // as metadata and never renders it into the agent's context — bare text
    // arrives anonymous (the "Alice comedy", journal 2026-07-23). Groups get
    // a location block too; DMs just the name.
    const location = gi?.groupId ? `[${this.contacts['group:' + String(gi.groupId)] ?? 'Signal group'}] ` : '';
    const body = `${location}${name}: ${bodyRaw}`;
    const message = {
      channelId,
      messageId: String(env.timestamp ?? Date.now()),
      author: { id: uuid, name },
      timestamp: new Date(Number(env.timestamp ?? Date.now())).toISOString(),
      content: [{ type: 'text', text: body }, ...imageBlocks],
      tags: imageBlocks.length ? [...tags, 'chat:has-image'] : tags,
    };
    try {
      const r = await this.conn.sendRequest(method.CHANNELS_INCOMING, { messages: [message] });
      dbg('incoming-delivered', { channelId, r });
      try {
        await this.rpc('sendReceipt', { recipient: uuid, targetTimestamp: Number(env.timestamp), type: 'read' });
        dbg('read-receipt-sent', { uuid, ts: env.timestamp });
      } catch (e2: any) { dbg('read-receipt-failed', String(e2?.message ?? e2)); }
    } catch (e: any) { dbg('incoming-failed', String(e?.message ?? e)); }
  }

  private async ensureGroup(gid: string): Promise<void> {
    const key = `group:${gid}`;
    if (!(key in this.contacts)) {
      let gname = 'unnamed';
      try {
        const groups: any[] = (await this.rpc('listGroups', {})) ?? [];
        const g = groups.find((x: any) => String(x.id ?? x.groupId ?? '') === gid);
        if (g?.name) gname = String(g.name);
      } catch (e: any) { dbg('listGroups-failed', String(e?.message ?? e)); }
      this.contacts[key] = gname;
      saveContacts(this.contacts);
    }
    await this.ensureKey(key, this.contacts[key]);
  }

  private async ensureKey(key: string, name: string): Promise<void> {
    if (this.contacts[key] !== name) { this.contacts[key] = name; saveContacts(this.contacts); }
    const d = this.descriptorFor(key);
    if (this.registered.has(d.id)) return;
    try {
      await this.conn.sendRequest(method.CHANNELS_REGISTER, { channels: [d] });
      this.registered.add(d.id);
      dbg('channel-registered', d.id);
    } catch (e: any) { dbg('register-failed', String(e?.message ?? e)); }
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes('--stdio')) { console.error('usage: signal-mcpl --stdio'); process.exit(1); }
  if (!ACCOUNT) console.error('[signal-mcpl] WARNING: SIGNAL_ACCOUNT not set (informational only)');
  console.error(`[signal-mcpl] v0.5.0 starting; daemon=${DAEMON} whitelist=${DM_USERS.length ? DM_USERS.length + ' user(s)' : 'OPEN'}`);
  const conn: any = McplConnection.fromStreams(process.stdin, process.stdout);
  if (typeof conn.on === 'function') conn.on('error', (e: any) => { console.error('[signal-mcpl] connection error:', e?.message ?? e); process.exit(0); });
  const server = new SignalMcpl();
  try { await server.serve(conn); } catch (e: any) { if (String(e?.name) !== 'ConnectionClosedError') throw e; }
}

main().catch(e => { console.error('[signal-mcpl] fatal:', e); process.exit(1); });
