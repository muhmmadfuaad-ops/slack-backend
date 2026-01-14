const path = require("path");
const axios = require("axios");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { WebClient } = require("@slack/web-api");
const swaggerUi = require("swagger-ui-express");

// Load environment variables from .env if present
const ENV_PATH = path.join(__dirname, ".env");
if (fs.existsSync(ENV_PATH)) {
  dotenv.config({ path: ENV_PATH });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value;
}

// Environment
const SLACK_SIGNING_SECRET = requireEnv("SLACK_SIGNING_SECRET");

const SLACK_USER_TOKEN_RTC = requireEnv("SLACK_USER_TOKEN_RTC");
const TEAM_RTC = requireEnv("TEAM_RTC");

const SLACK_USER_TOKEN_STRATEGER = requireEnv("SLACK_USER_TOKEN_STRATEGER");
const TEAM_STRATEGER = requireEnv("TEAM_STRATEGER");


const LOG_HISTORY = (process.env.LOG_HISTORY || "false").toLowerCase() === "true";
const HISTORY_LOOKBACK_SECONDS = 12 * 60 * 60;
const EVENT_TTL_SECONDS = 300;
const PROCESSED_EVENTS = new Map();

// Slack clients
const clientRtc = new WebClient(SLACK_USER_TOKEN_RTC);
const clientStrateger = new WebClient(SLACK_USER_TOKEN_STRATEGER);

// const client = new WebClient(SLACK_USER_TOKEN_RTC);
// // const client = new WebClient(SLACK_BOT_TOKEN_BETA);

const ORGANIZATIONS_META = [
  {
    id: "rtc",
    team_id: TEAM_RTC,
    name: "RTC League",
    status: "Free trial in progress",
    initials: "RL",
    accent: "#8E6CF5",
  },
  {
    id: "strateger",
    team_id: TEAM_STRATEGER,
    name: "Strateger AI",
    status: "Active workspace",
    initials: "SA",
    accent: "#F06867",
  },
];

const ORG_CLIENTS = {
  rtc: clientRtc,
  strateger: clientStrateger,
};

// In-memory installs loaded via OAuth (team_id -> tokens/client)
const workspaceTokens = {};
const workspaceClients = {};
const TOKENS_FILE = path.join(__dirname, "workspaceTokens.json");
const CHANNEL_NAME_CACHE = {};

// Forward messages from Strateger AI (#test-channel) into RTC (#test-client)
const FORWARD_RULES = [
  {
    sourceTeam: "T08EPASQ09H", // Strateger AI team_id
    sourceChannelName: "test-channel",
    targetTeam: TEAM_RTC,
    targetChannelName: "test-client",
    sourceChannelId: null,
    targetChannelId: null,
  },
  {
    sourceTeam: TEAM_RTC,
    sourceChannelName: "test-client",
    targetTeam: "T08EPASQ09H", // Strateger AI team_id
    targetChannelName: "test-channel",
    sourceChannelId: null,
    targetChannelId: null,
  },
];

const swaggerDocument = {
  openapi: "3.0.0",
  info: {
    title: "Slack Mirror API",
    version: "1.0.0",
    description: "Node backend mirroring Slack conversations for RTC/Beta.",
  },
  servers: [{ url: "/" }],
  components: {
    schemas: {
      Organization: {
        type: "object",
        properties: {
          id: { type: "string" },
          team_id: { type: "string" },
          name: { type: "string" },
          status: { type: "string" },
          initials: { type: "string" },
          accent: { type: "string" },
        },
      },
      Chat: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          org_id: { type: "string" },
          name: { type: "string" },
          path: { type: "string" },
          owner: { type: "string" },
          preview: { type: "string" },
          lastMessageAt: { type: "string" },
          unread: { type: "integer" },
          team_id: { type: "string" },
        },
      },
      Message: {
        type: "object",
        properties: {
          id: { type: "string" },
          chat_id: { type: "string" },
          user: { type: "string" },
          avatar: { type: "string" },
          text: { type: "string" },
          time: { type: "string" },
          attachments: { type: "array", items: { type: "string" } },
          reply_count: { type: "integer" },
          thread_ts: { type: "string" },
        },
      },
      ThreadResponse: {
        type: "object",
        properties: {
          parent: { $ref: "#/components/schemas/Message" },
          replies: { type: "array", items: { $ref: "#/components/schemas/Message" } },
        },
      },
      ReplyPayload: {
        type: "object",
        required: ["team_id", "channel", "text"],
        properties: {
          team_id: { type: "string" },
          channel: { type: "string" },
          text: { type: "string" },
          thread_ts: { type: "string" },
        },
      },
    },
  },
  paths: {
    "/api/organizations": {
      get: {
        summary: "List configured workspaces",
        responses: {
          200: {
            description: "OK",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Organization" } } } },
          },
        },
      },
    },
    "/api/orgs/{org_id}/chats": {
      get: {
        summary: "List channels and DMs for an org",
        parameters: [
          { name: "org_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "OK",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Chat" } } } },
          },
        },
      },
    },
    "/api/chats/{chat_id}/messages": {
      get: {
        summary: "Message history (last 12h)",
        parameters: [
          { name: "chat_id", in: "path", required: true, schema: { type: "string" } },
          { name: "org_id", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "OK",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Message" } } } },
          },
        },
      },
    },
    "/api/chats/{chat_id}/thread": {
      get: {
        summary: "Thread parent + replies",
        parameters: [
          { name: "chat_id", in: "path", required: true, schema: { type: "string" } },
          { name: "org_id", in: "query", required: true, schema: { type: "string" } },
          { name: "thread_ts", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ThreadResponse" } } },
          },
        },
      },
    },
    "/reply": {
      post: {
        summary: "Send a message",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ReplyPayload" },
            },
          },
        },
        responses: {
          200: { description: "OK" },
        },
      },
    },
    "/slack/events": {
      post: {
        summary: "Slack Events webhook",
        responses: {
          200: { description: "Acknowledged" },
          400: { description: "Bad request" },
          403: { description: "Invalid signature" },
        },
      },
    },
    "/test/user/{team_id}/{user_id}": {
      get: {
        summary: "Show user info",
        parameters: [
          { name: "team_id", in: "path", required: true, schema: { type: "string" } },
          { name: "user_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { 200: { description: "OK" } },
      },
    },
    "/test/channel/{team_id}/{channel_id}": {
      get: {
        summary: "Show channel info",
        parameters: [
          { name: "team_id", in: "path", required: true, schema: { type: "string" } },
          { name: "channel_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { 200: { description: "OK" } },
      },
    },
    "/test/workspace/{team_id}": {
      get: {
        summary: "Show workspace info",
        parameters: [{ name: "team_id", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "OK" } },
      },
    },
    "/test/history/{team_id}/{channel_id}": {
      get: {
        summary: "Show history",
        parameters: [
          { name: "team_id", in: "path", required: true, schema: { type: "string" } },
          { name: "channel_id", in: "path", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50 } },
        ],
        responses: { 200: { description: "OK" } },
      },
    },
  },
};

const app = express();
const PORT = process.env.PORT || 8000;

// Use raw body for Slack signature verification
app.use("/slack/events", express.raw({ type: "*/*" }));
app.use(express.json());
app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`
    );
  });
  next();
});

function httpError(status, detail) {
  const err = new Error(detail);
  err.status = status;
  return err;
}

function getOrgMeta(orgId) {
  return ORGANIZATIONS_META.find((o) => o.id === orgId);
}

function getClientForTeam(teamId) {
  if (teamId === TEAM_RTC) return clientRtc;
  if (teamId === TEAM_STRATEGER) return clientStrateger;
  const dynamicClient = workspaceClients[teamId];
  if (dynamicClient) return dynamicClient;
  throw httpError(400, `Unknown team_id ${teamId}`);
}

function persistWorkspaceTokens() {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(workspaceTokens, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to persist workspace tokens:", err.message || err);
  }
}

function rememberWorkspaceInstall(teamId, botToken, userToken, shouldPersist = true) {
  const tokenToUse = userToken || botToken;
  workspaceTokens[teamId] = { botToken, userToken };
  if (tokenToUse) {
    workspaceClients[teamId] = new WebClient(tokenToUse);
  }
  if (shouldPersist) persistWorkspaceTokens();
}

function loadWorkspaceTokensFromDisk() {
  if (!fs.existsSync(TOKENS_FILE)) return;
  try {
    const raw = fs.readFileSync(TOKENS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed);
      for (const [teamId, tokens] of entries) {
        if (!tokens) continue;
        rememberWorkspaceInstall(teamId, tokens.botToken, tokens.userToken, false);
      }
      if (entries.length) {
        console.log(`Loaded workspace tokens for ${entries.length} team(s) from disk`);
      }
    }
  } catch (err) {
    console.error("Failed to load workspace tokens:", err.message || err);
  }
}

loadWorkspaceTokensFromDisk();

function cacheChannelId(teamId, channelName, channelId) {
  if (!CHANNEL_NAME_CACHE[teamId]) CHANNEL_NAME_CACHE[teamId] = {};
  CHANNEL_NAME_CACHE[teamId][channelName] = channelId;
}

function getCachedChannelId(teamId, channelName) {
  return CHANNEL_NAME_CACHE[teamId]?.[channelName];
}

async function resolveChannelIdByName(client, teamId, channelName) {
  const cached = getCachedChannelId(teamId, channelName);
  if (cached) return cached;
  const channels = await fetchConversations(client, "public_channel,private_channel");
  const match = channels.find((c) => c.name === channelName);
  if (!match) throw httpError(404, `Channel ${channelName} not found in team ${teamId}`);
  cacheChannelId(teamId, channelName, match.id);
  return match.id;
}

function getClientForOrg(orgId) {
  const client = ORG_CLIENTS[orgId];
  if (!client) {
    throw httpError(404, "Unknown organization");
  }
  return client;
}

function formatClockTime(ts) {
  const num = Number(ts);
  if (Number.isNaN(num)) return ts;
  const date = new Date(num * 1000);
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const period = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHours}:${minutes} ${period}`;
}

function previewTextFromMessage(message) {
  if (!message) return "No messages yet";
  const text = message.text || "";
  if (text) return text;
  const files = message.files || [];
  if (files.length) {
    const fileNames = files.map((f) => f.name || f.title || "attachment").join(", ");
    return `Attachment · ${fileNames}`;
  }
  return "Sent a message";
}

async function getUserInfo(client, userId) {
  try {
    const result = await client.users.info({ user: userId });
    const user = result.user || {};
    return {
      id: user.id,
      name: user.real_name,
      display_name: user.profile?.display_name,
      email: user.profile?.email,
    };
  } catch (err) {
    console.error(`Error fetching user ${userId}:`, err.data?.error || err.message);
    return {};
  }
}

async function getChannelInfo(client, channelId) {
  // console.log('client:', client);
  console.log('channelId:', channelId);
  try {
    const result = await client.conversations.info({ channel: channelId });
    // console.log('result:', result);
    const channel = result.channel || {};
    return {
      id: channel.id,
      name: channel.name,
      is_private: channel.is_private,
      is_dm: channel.is_im,
      topic: channel.topic?.value,
    };
  } catch (err) {
    console.error(`Error fetching channel ${channelId}:`, err.data?.error || err.message);
    return {};
  }
}

async function getWorkspaceInfo(client) {
  try {
    const result = await client.team.info();
    const team = result.team || {};
    return {
      id: team.id,
      name: team.name,
      domain: team.domain,
    };
  } catch (err) {
    console.error("Error fetching team info:", err.data?.error || err.message);
    return {};
  }
}

async function fetchConversations(client, types) {
  const results = [];
  let cursor = undefined;
  while (true) {
    try {
      const response = await client.conversations.list({
        types,
        limit: 200,
        cursor,
        exclude_archived: true,
      });
      const channels = response.channels || [];
      results.push(...channels);
      cursor = response.response_metadata?.next_cursor;
      if (!cursor) break;
    } catch (err) {
      console.error(`Error loading conversations (${types}):`, err.data?.error || err.message);
      throw httpError(503, "Failed to load Slack conversations");
    }
  }
  return results;
}

function getUserLabel(client, userId, cache) {
  if (!userId) return { name: "Slack App", initials: "S" };
  if (cache[userId]) return cache[userId];
  return getUserInfo(client, userId).then((info) => {
    const displayName = info.name || info.display_name || userId;
    const initial = displayName ? displayName.charAt(0).toUpperCase() : "S";
    cache[userId] = { name: displayName, initials: initial };
    return cache[userId];
  });
}

async function buildChatEntry(client, orgMeta, channel, chatType, userCache) {
  const lastMessage = channel.latest;
  let chatName;
  let ownerLabel;
  let pathType;
  if (chatType === "dm") {
    const ownerId = channel.user;
    ownerLabel = await getUserLabel(client, ownerId, userCache);
    chatName = ownerLabel.name;
    pathType = "Direct messages";
  } else {
    chatName = channel.name || channel.topic?.value || "Channel";
    ownerLabel = { name: chatName };
    pathType = "Channels";
  }

  return {
    id: channel.id,
    type: chatType,
    org_id: orgMeta.id,
    name: chatName,
    path: `${orgMeta.name} / ${pathType} / ${chatName}`,
    owner: ownerLabel.name,
    preview: previewTextFromMessage(lastMessage),
    lastMessageAt: lastMessage ? formatClockTime(lastMessage.ts) : "",
    unread: channel.unread_count_display || channel.unread_count || 0,
    team_id: orgMeta.team_id,
  };
}

async function buildMessagePayload(client, message, chatId, userCache) {
  const userId = message.user || message.bot_id;
  const userLabel = await getUserLabel(client, userId, userCache);
  const attachments = message.files || [];
  const files = attachments.map((file) => file.name || file.title || "attachment");
  return {
    id: message.ts,
    chat_id: chatId,
    user: userLabel.name,
    avatar: userLabel.initials,
    text: message.text || "",
    time: formatClockTime(message.ts || ""),
    attachments: files,
    reply_count: message.reply_count || 0,
    thread_ts: message.thread_ts || message.ts,
  };
}

async function fetchChannelHistory(client, channelId, limit = 50, oldest = undefined) {
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const params = { channel: channelId, limit };
      if (oldest !== undefined) params.oldest = oldest;
      const result = await client.conversations.history(params);
      return result.messages || [];
    } catch (err) {
      console.error(
        `Error fetching history for ${channelId} (attempt ${attempt}/${attempts}):`,
        err.data?.error || err.message
      );
      if (attempt === attempts) throw httpError(503, "Failed to load Slack history");
    }
  }
  return [];
}

async function listChatsForOrg(orgId) {
  const orgMeta = getOrgMeta(orgId);
  if (!orgMeta) throw httpError(404, "Unknown organization");

  const client = getClientForOrg(orgId);
  const userCache = {};

  const channels = await fetchConversations(client, "public_channel,private_channel");
  const dms = await fetchConversations(client, "im,mpim");

  const chats = [];
  for (const channel of channels) {
    chats.push(await buildChatEntry(client, orgMeta, channel, "channel", userCache));
  }
  for (const dm of dms) {
    chats.push(await buildChatEntry(client, orgMeta, dm, "dm", userCache));
  }

  return chats;
}

async function fetchMessagesForChat(orgId, chatId, limit = 40) {
  const client = getClientForOrg(orgId);
  const oldest = Math.floor(Date.now() / 1000) - HISTORY_LOOKBACK_SECONDS;
  const rawMessages = await fetchChannelHistory(client, chatId, limit, oldest);
  const userCache = {};
  const ordered = [...rawMessages].reverse();
  const payloads = [];
  for (const message of ordered) {
    payloads.push(await buildMessagePayload(client, message, chatId, userCache));
  }
  return payloads;
}

async function fetchThreadReplies(orgId, chatId, threadTs, limit = 40) {
  const client = getClientForOrg(orgId);
  try {
    const result = await client.conversations.replies({
      channel: chatId,
      ts: threadTs,
      limit,
      inclusive: true,
    });
    const messages = result.messages || [];
    if (!messages.length) return { parent: null, replies: [] };

    const userCache = {};
    const parent = await buildMessagePayload(client, messages[0], chatId, userCache);
    const replies = [];
    for (const message of messages.slice(1)) {
      replies.push(await buildMessagePayload(client, message, chatId, userCache));
    }
    return { parent, replies };
  } catch (err) {
    console.error("Error loading thread replies:", err.data?.error || err.message);
    throw httpError(503, "Failed to load thread replies");
  }
}

function tsToDatetime(ts) {
  const num = Number(ts);
  if (Number.isNaN(num)) return ts;
  const date = new Date(num * 1000);
  return date.toISOString().replace("T", " ").split(".")[0];
}

async function printUserInfo(client, userId, teamId) {
  const userInfo = await getUserInfo(client, userId);
  const workspaceInfo = await getWorkspaceInfo(client);
  const now = new Date().toISOString().replace("T", " ").split(".")[0];
  console.log("\n" + "=".repeat(60));
  console.log(`[${now}] [${teamId}] USER INFORMATION`);
  console.log("=".repeat(60));
  console.log(`User ID: ${userInfo.id}`);
  console.log(`Name: ${userInfo.name}`);
  console.log(`Display Name: ${userInfo.display_name}`);
  console.log(`Email: ${userInfo.email}`);
  console.log(`Workspace: ${workspaceInfo.name} (ID: ${workspaceInfo.id})`);
  console.log("=".repeat(60) + "\n");
}

async function printChannelInfo(client, channelId, teamId) {
  const channelInfo = await getChannelInfo(client, channelId);
  const now = new Date().toISOString().replace("T", " ").split(".")[0];
  console.log("\n" + "=".repeat(60));
  console.log(`[${now}] [${teamId}] CHANNEL INFORMATION`);
  console.log("=".repeat(60));
  console.log(`Channel ID: ${channelInfo.id}`);
  console.log(`Name: ${channelInfo.name}`);
  console.log(`Private: ${channelInfo.is_private}`);
  console.log(`Direct Message: ${channelInfo.is_dm}`);
  console.log(`Topic: ${channelInfo.topic}`);
  console.log("=".repeat(60) + "\n");
}

async function printMessageHistory(client, channelId, teamId, limit = 50) {
  const messages = await fetchChannelHistory(client, channelId, limit);
  const now = new Date().toISOString().replace("T", " ").split(".")[0];
  console.log("\n" + "=".repeat(60));
  console.log(`[${now}] [${teamId}] MESSAGE HISTORY - ${channelId} (Last ${messages.length} messages)`);
  console.log("=".repeat(60));
  for (const msg of [...messages].reverse()) {
    const userId = msg.user || "bot";
    const text = msg.text || "[no text]";
    const ts = msg.ts;
    const msgTime = tsToDatetime(ts);
    let userName = userId;
    if (userId !== "bot") {
      const userInfo = await getUserInfo(client, userId);
      userName = userInfo.name || userId;
    }
    console.log(`\n[${msgTime}] ${userName} (${userId}):`);
    console.log(`  ${text}`);
  }
  console.log("\n" + "=".repeat(60) + "\n");
}

function checkAndMarkEvent(eventId) {
  if (!eventId) return false;
  const now = Date.now() / 1000;
  for (const [id, ts] of [...PROCESSED_EVENTS.entries()]) {
    if (now - ts > EVENT_TTL_SECONDS) {
      PROCESSED_EVENTS.delete(id);
    }
  }
  if (PROCESSED_EVENTS.has(eventId)) return true;
  PROCESSED_EVENTS.set(eventId, now);
  return false;
}

function verifySlackSignature(secret, timestamp, rawBody, slackSig) {
  if (!slackSig || !timestamp) return false;
  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac("sha256", secret).update(baseString, "utf8").digest("hex");
  const expected = `v0=${hmac}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(slackSig, "utf8"));
  } catch {
    return false;
  }
}

async function logMessageEvent(teamId, client, event, eventId = "") {
  if (event.type !== "message" || event.bot_id) return;
  const user = event.user;
  const text = event.text;
  const channel = event.channel;
  const ts = event.ts;
  const msgTime = tsToDatetime(ts);
  try {
    console.log(`[${msgTime}] [IN ${teamId}] user=${user} channel=${channel} text=${text} event_id=${eventId}`);
    await printUserInfo(client, user, teamId);
    await printChannelInfo(client, channel, teamId);
    if (LOG_HISTORY) {
      await printMessageHistory(client, channel, teamId, 10);
    }
  } catch (err) {
    console.error(`Error handling message event ${eventId}:`, err.message || err);
  }
}

async function ensureForwardRuleChannels(rule) {
  if (!rule.sourceChannelId) {
    const sourceClient = getClientForTeam(rule.sourceTeam);
    rule.sourceChannelId = await resolveChannelIdByName(sourceClient, rule.sourceTeam, rule.sourceChannelName);
  }
  if (!rule.targetChannelId) {
    const targetClient = getClientForTeam(rule.targetTeam);
    rule.targetChannelId = await resolveChannelIdByName(targetClient, rule.targetTeam, rule.targetChannelName);
  }
}

async function maybeForwardMessage(teamId, client, event) {
  if (event.type !== "message" || event.bot_id) return;
  for (const rule of FORWARD_RULES) {
    if (rule.sourceTeam !== teamId) continue;
    try {
      await ensureForwardRuleChannels(rule);
      if (rule.sourceChannelId && event.channel === rule.sourceChannelId) {
        const targetClient = getClientForTeam(rule.targetTeam);
        // const targetClient = client;
        const userLabel = await getUserLabel(client, event.user, {});
        const text = event.text || "";
        const outbound = `[${rule.sourceChannelName}] ${userLabel.name || event.user}: ${text}`;

        // console.log('targetClient:', targetClient);
        console.log('rule.targetChannelId', rule.targetChannelId);
        console.log('outbound', outbound);
        await targetClient.chat.postMessage({
          channel: rule.targetChannelId,
          text: outbound,
        });
        const now = new Date().toISOString().replace("T", " ").split(".")[0];
        console.log(
          `[${now}] Forwarded message ${event.ts} from ${rule.sourceTeam}#${rule.sourceChannelName} to ${rule.targetTeam}#${rule.targetChannelName}`
        );
      }
    } catch (err) {
      console.error(
        `Failed to forward message from ${rule.sourceTeam}#${rule.sourceChannelName}:`,
        err.message || err
      );
    }
  }
}

// Routes
app.get("/api/organizations", async (req, res, next) => {
  try {
    res.json(ORGANIZATIONS_META);
  } catch (err) {
    next(err);
  }
});

app.get("/api/orgs/:org_id/chats", async (req, res, next) => {
  try {
    const data = await listChatsForOrg(req.params.org_id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

app.get("/api/chats/:chat_id/messages", async (req, res, next) => {
  try {
    const { chat_id } = req.params;
    const { org_id } = req.query;
    if (!org_id) throw httpError(400, "org_id is required");
    const data = await fetchMessagesForChat(org_id, chat_id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

app.get("/api/chats/:chat_id/thread", async (req, res, next) => {
  try {
    const { chat_id } = req.params;
    const { org_id, thread_ts } = req.query;
    if (!org_id || !thread_ts) throw httpError(400, "org_id and thread_ts are required");
    const data = await fetchThreadReplies(org_id, chat_id, thread_ts);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

app.post("/slack/events", async (req, res, next) => {
  try {
    const timestamp = req.headers["x-slack-request-timestamp"];
    const slackSig = req.headers["x-slack-signature"];
    const rawBody =
      req.body instanceof Buffer ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : "";
    if (!rawBody) throw httpError(400, "Empty body");

    const valid = verifySlackSignature(SLACK_SIGNING_SECRET, timestamp, rawBody, slackSig);
    // const validStrateger = verifySlackSignature(SLACK_SIGNING_SECRET_BETA, timestamp, rawBody, slackSig);
    if (!valid) throw httpError(403, "Invalid signature");

    let payload;
    try {
      payload = JSON.parse(rawBody || "{}");
    } catch {
      throw httpError(400, "Invalid JSON payload");
    }

    if (payload.type === "url_verification") {
      return res.json({ challenge: payload.challenge });
    }

    // console.log('payload:', payload);
    const teamId = payload.team_id;
    if (!teamId) throw httpError(400, "Missing team_id");

    const event = payload.event || {};
    const eventId = payload.event_id;

    if (checkAndMarkEvent(eventId)) {
      return res.json({ ok: true, duplicate: true });
    }

    let clientForTeam;
    try {
      console.log('teamId:', teamId);
      clientForTeam = getClientForTeam(teamId);
      // console.log('clientForTeam:', clientForTeam);
    } catch (err) {
      console.warn(`Received Slack event for unknown team_id=${teamId}; acknowledging to avoid retries.`);
      return res.json({ ok: true, ignored: "unknown_team" });
    }

    if (event.type === "message" && !event.bot_id) {
      setImmediate(() => logMessageEvent(teamId, clientForTeam, event, eventId));
      setImmediate(() => maybeForwardMessage(teamId, clientForTeam, event));
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post("/reply", async (req, res, next) => {
  try {
    const { team_id, channel, text, thread_ts } = req.body || {};
    if (!team_id || !channel || !text) throw httpError(400, "team_id, channel, and text are required");
    const client = getClientForTeam(team_id);
    const resp = await client.chat.postMessage({ channel, text, thread_ts });
    const now = new Date().toISOString().replace("T", " ").split(".")[0];
    console.log(`[${now}] [OUT ${team_id}] channel=${channel} ts=${resp.ts} text=${text}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Test endpoints
app.get("/test/user/:team_id/:user_id", async (req, res, next) => {
  try {
    const { team_id, user_id } = req.params;
    const client = getClientForTeam(team_id);
    await printUserInfo(client, user_id, team_id);
    res.json(await getUserInfo(client, user_id));
  } catch (err) {
    next(err);
  }
});

app.get("/test/channel/:team_id/:channel_id", async (req, res, next) => {
  try {
    const { team_id, channel_id } = req.params;
    const client = getClientForTeam(team_id);
    await printChannelInfo(client, channel_id, team_id);
    res.json(await getChannelInfo(client, channel_id));
  } catch (err) {
    next(err);
  }
});

app.get("/test/workspace/:team_id", async (req, res, next) => {
  try {
    const { team_id } = req.params;
    const client = getClientForTeam(team_id);
    const workspaceInfo = await getWorkspaceInfo(client);
    const now = new Date().toISOString().replace("T", " ").split(".")[0];
    console.log("\n" + "=".repeat(60));
    console.log(`[${now}] [${team_id}] WORKSPACE INFORMATION`);
    console.log("=".repeat(60));
    console.log(`Workspace ID: ${workspaceInfo.id}`);
    console.log(`Workspace Name: ${workspaceInfo.name}`);
    console.log(`Domain: ${workspaceInfo.domain}`);
    console.log("=".repeat(60) + "\n");
    res.json(workspaceInfo);
  } catch (err) {
    next(err);
  }
});

app.get("/test/history/:team_id/:channel_id", async (req, res, next) => {
  try {
    const { team_id, channel_id } = req.params;
    const { limit = 50 } = req.query;
    let client;
    if (team_id === TEAM_RTC) client = clientRtc;
    else if (team_id === TEAM_STRATEGER) client = clientStrateger;
    else throw httpError(400, "Unknown team_id");
    await printMessageHistory(client, channel_id, team_id, Number(limit));
    res.json({ messages: await fetchChannelHistory(client, channel_id, Number(limit)) });
  } catch (err) {
    next(err);
  }
});

app.get('/slack/oauth/callback', async (req, res, next) => {
  try {
    const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
    const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
    const REDIRECT_URI = process.env.REDIRECT_URI;

    const { code } = req.query;

    const { user, team, channel, text } = req.query;
    const displayEvent = { user, team, channel, text };
    console.log('displayEvent:', displayEvent);

    if (!code) {
      return res.status(400).json({ detail: 'Authorization code is missing' });
    }

    // Step 1: Exchange code for tokens
    const response = await axios.post(
      'https://slack.com/api/oauth.v2.access',
      null,
      {
        params: {
          client_id: SLACK_CLIENT_ID,
          client_secret: SLACK_CLIENT_SECRET,
          code: code,
          redirect_uri: REDIRECT_URI,
        },
      }
    );

    const slackResponse = response.data;
    console.log('slackResponse:', JSON.stringify(slackResponse, null, 2));

    if (!slackResponse.ok) {
      console.error('Slack OAuth error:', slackResponse.error);
      return res
        .status(400)
        .json({ detail: `OAuth failed: ${slackResponse.error}` });
    }

    // Step 2: Extract tokens and team info
    const teamId = slackResponse.team?.id;
    const botToken = slackResponse.access_token; // xoxb-...
    const userToken = slackResponse.authed_user?.access_token; // xoxp-...

    if (!teamId || (!botToken && !userToken)) {
      console.error('Invalid Slack OAuth response:', slackResponse);
      return res
        .status(500)
        .json({ detail: 'Invalid Slack OAuth response' });
    }

    // Step 3: Save token (DB recommended in production)
    rememberWorkspaceInstall(teamId, botToken, userToken);
    console.log(`✅ Installed in ${teamId}: ${userToken || botToken}`);

    // Step 4: Respond
    res.json({
      ok: true,
      message: 'App installed successfully',
      team_id: teamId,
    });
  } catch (err) {
    console.error('Error during Slack OAuth:', err.message || err);
    next(err);
  }
});

// Swagger UI docs
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument, { explorer: true }));

// Error handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const detail = err.message || "Internal server error";
  res.status(status).json({ detail });
});

app.listen(PORT, () => {
  console.log(`Node Slack backend listening on port ${PORT}`);
});
