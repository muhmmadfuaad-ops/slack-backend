# import os
# import json
# import inspect
# from functools import wraps
# from http.client import IncompleteRead
# from time import time
# from datetime import datetime
# from pathlib import Path
# from typing import Any, Dict, List, Optional

# from fastapi import BackgroundTasks, FastAPI, Request, HTTPException
# from fastapi.middleware.cors import CORSMiddleware
# from pydantic import BaseModel
# from slack_sdk import WebClient
# from slack_sdk.errors import SlackApiError
# from slack_sdk.signature import SignatureVerifier


# def require_env(name: str) -> str:
#     v = os.environ.get(name)
#     if not v:
#         raise RuntimeError(f"Environment variable {name} is required")
#     return v


# ENV_FILE = Path(__file__).resolve().parent / ".env"


# def load_env_file(env_path: Path) -> None:
#     """Load key/value pairs from a .env-style file if one exists."""
#     if not env_path.is_file():
#         return

#     with env_path.open(encoding="utf-8") as handle:
#         for raw_line in handle:
#             line = raw_line.strip()
#             if not line or line.startswith("#"):
#                 continue
#             if line.startswith("export "):
#                 line = line[len("export ") :]
#             if "=" not in line:
#                 continue

#             key, value = line.split("=", 1)
#             key = key.strip()
#             value = value.strip().strip('"').strip("'")
#             os.environ.setdefault(key, value)


# load_env_file(ENV_FILE)


# # ---------- ENVIRONMENT ----------

# # RTC workspace
# SLACK_SIGNING_SECRET_RTC = require_env("SLACK_SIGNING_SECRET_RTC")
# SLACK_USER_TOKEN_RTC = require_env("SLACK_USER_TOKEN_RTC")
# TEAM_RTC = require_env("TEAM_RTC")

# # Beta workspace
# SLACK_SIGNING_SECRET_BETA = require_env("SLACK_SIGNING_SECRET_BETA")
# SLACK_BOT_TOKEN_BETA = require_env("SLACK_BOT_TOKEN_BETA")
# TEAM_BETA = require_env("TEAM_BETA")

# # Runtime toggles
# LOG_HISTORY = os.getenv("LOG_HISTORY", "false").lower() == "true"
# HISTORY_LOOKBACK_SECONDS = 12 * 60 * 60  # 12 hours

# # Event deduping
# EVENT_TTL_SECONDS = 300
# PROCESSED_EVENTS: Dict[str, float] = {}

# client_rtc = WebClient(token=SLACK_USER_TOKEN_RTC)
# client_beta = WebClient(token=SLACK_BOT_TOKEN_BETA)

# verifier_rtc = SignatureVerifier(SLACK_SIGNING_SECRET_RTC)
# verifier_beta = SignatureVerifier(SLACK_SIGNING_SECRET_BETA)

# ORGANIZATIONS_META: List[Dict[str, Any]] = [
#     {
#         "id": "rtc",
#         "team_id": TEAM_RTC,
#         "name": "RTC League",
#         "status": "Free trial in progress",
#         "initials": "RL",
#         "accent": "#8E6CF5",
#     },
#     {
#         "id": "beta",
#         "team_id": TEAM_BETA,
#         "name": "Beta Crew",
#         "status": "Active workspace",
#         "initials": "BC",
#         "accent": "#F06867",
#     },
# ]

# ORG_CLIENTS: Dict[str, WebClient] = {
#     "rtc": client_rtc,
#     "beta": client_beta,
# }


# def get_org_meta(org_id: str) -> Optional[Dict[str, Any]]:
#     for entry in ORGANIZATIONS_META:
#         if entry["id"] == org_id:
#             return entry
#     return None


# def get_client_for_org(org_id: str) -> WebClient:
#     client = ORG_CLIENTS.get(org_id)
#     if not client:
#         raise HTTPException(status_code=404, detail="Unknown organization")
#     return client


# def format_clock_time(ts: str) -> str:
#     try:
#         dt = datetime.fromtimestamp(float(ts))
#         return dt.strftime("%I:%M %p").lstrip("0")
#     except (ValueError, TypeError):
#         return ts


# def preview_text_from_message(message: Optional[Dict[str, Any]]) -> str:
#     if not message:
#         return "No messages yet"
#     text = message.get("text", "")
#     if text:
#         return text
#     files = message.get("files", [])
#     if files:
#         file_names = ", ".join(f.get("name", f.get("title", "attachment")) for f in files)
#         return f"Attachment · {file_names}"
#     return "Sent a message"


# def get_user_label(client: WebClient, user_id: Optional[str], cache: Dict[str, Dict[str, str]]) -> Dict[str, str]:
#     if not user_id:
#         return {"name": "Slack App", "initials": "S"}
#     if user_id in cache:
#         return cache[user_id]
#     info = get_user_info(client, user_id)
#     display_name = info.get("name") or info.get("display_name") or user_id
#     initial = display_name[:1].upper() if display_name else "S"
#     cache[user_id] = {"name": display_name, "initials": initial}
#     return cache[user_id]


# def build_chat_entry(
#     client: WebClient,
#     org_meta: Dict[str, Any],
#     channel: Dict[str, Any],
#     chat_type: str,
#     user_cache: Dict[str, Dict[str, str]],
# ) -> Dict[str, Any]:
#     last_message = channel.get("latest")
#     if chat_type == "dm":
#         owner_id = channel.get("user")
#         owner_label = get_user_label(client, owner_id, user_cache)
#         chat_name = owner_label["name"]
#         path_type = "Direct messages"
#     else:
#         chat_name = channel.get("name") or channel.get("topic", {}).get("value") or "Channel"
#         owner_label = {"name": chat_name}
#         path_type = "Channels"

#     return {
#         "id": channel["id"],
#         "type": chat_type,
#         "org_id": org_meta["id"],
#         "name": chat_name,
#         "path": f"{org_meta['name']} / {path_type} / {chat_name}",
#         "owner": owner_label["name"],
#         "preview": preview_text_from_message(last_message),
#         "lastMessageAt": format_clock_time(last_message["ts"]) if last_message else "",
#         "unread": channel.get("unread_count_display", 0) or channel.get("unread_count", 0),
#         "team_id": org_meta["team_id"],
#     }


# def build_message_payload(
#     client: WebClient,
#     message: Dict[str, Any],
#     chat_id: str,
#     user_cache: Dict[str, Dict[str, str]],
# ) -> Dict[str, Any]:
#     user_id = message.get("user") or message.get("bot_id")
#     user_label = get_user_label(client, user_id, user_cache)
#     text = message.get("text") or ""
#     attachments = message.get("files", [])
#     files = [file.get("name") or file.get("title") or "attachment" for file in attachments]
#     return {
#         "id": message.get("ts"),
#         "chat_id": chat_id,
#         "user": user_label["name"],
#         "avatar": user_label["initials"],
#         "text": text,
#         "time": format_clock_time(message.get("ts", "")),
#         "attachments": files,
#         "reply_count": message.get("reply_count", 0),
#         "thread_ts": message.get("thread_ts") or message.get("ts"),
#     }


# def fetch_conversations(client: WebClient, types: str) -> List[Dict[str, Any]]:
#     results: List[Dict[str, Any]] = []
#     cursor: Optional[str] = None
#     while True:
#         try:
#             response = client.conversations_list(
#                 types=types, limit=200, cursor=cursor, exclude_archived=True
#             )
#         except SlackApiError as err:
#             print(f"Error loading conversations ({types}): {err.response['error']}")
#             raise HTTPException(status_code=503, detail="Failed to load Slack conversations")
#         channels = response.get("channels", [])
#         results.extend(channels)
#         cursor = response.get("response_metadata", {}).get("next_cursor")
#         if not cursor:
#             break
#     return results


# def list_chats_for_org(org_id: str) -> List[Dict[str, Any]]:
#     org_meta = get_org_meta(org_id)
#     if not org_meta:
#         raise HTTPException(status_code=404, detail="Unknown organization")

#     client = get_client_for_org(org_id)
#     user_cache: Dict[str, Dict[str, str]] = {}

#     channels = fetch_conversations(client, "public_channel,private_channel")
#     dms = fetch_conversations(client, "im,mpim")

#     chats: List[Dict[str, Any]] = []
#     for channel in channels:
#         chats.append(
#             build_chat_entry(client, org_meta, channel, "channel", user_cache),
#         )
#     for dm in dms:
#         chats.append(
#             build_chat_entry(client, org_meta, dm, "dm", user_cache),
#         )

#     return chats


# def fetch_messages_for_chat(org_id: str, chat_id: str, limit: int = 40) -> List[Dict[str, Any]]:
#     client = get_client_for_org(org_id)
#     oldest_ts = time() - HISTORY_LOOKBACK_SECONDS
#     raw_messages = fetch_channel_history(client, chat_id, limit=limit, oldest=oldest_ts)
#     user_cache: Dict[str, Dict[str, str]] = {}
#     ordered = list(reversed(raw_messages))
#     return [
#         build_message_payload(client, message, chat_id, user_cache)
#         for message in ordered
#     ]


# def fetch_thread_replies(
#     org_id: str, chat_id: str, thread_ts: str, limit: int = 40
# ) -> Dict[str, Any]:
#     client = get_client_for_org(org_id)
#     try:
#         result = client.conversations_replies(
#             channel=chat_id, ts=thread_ts, limit=limit, inclusive=True
#         )
#     except SlackApiError as err:
#         print(f"Error loading thread replies: {err.response['error']}")
#         raise HTTPException(status_code=503, detail="Failed to load thread replies")

#     messages = result.get("messages", [])
#     if not messages:
#         return {"parent": None, "replies": []}

#     user_cache: Dict[str, Dict[str, str]] = {}
#     parent = build_message_payload(client, messages[0], chat_id, user_cache)
#     replies = [
#         build_message_payload(client, message, chat_id, user_cache)
#         for message in messages[1:]
#     ]

#     return {"parent": parent, "replies": replies}



# # ---------- HELPER FUNCTIONS ----------

# def ts_to_datetime(ts: str) -> str:
#     """Convert Slack timestamp (Unix epoch) to readable datetime"""
#     try:
#         timestamp = float(ts)
#         dt = datetime.fromtimestamp(timestamp)
#         return dt.strftime("%Y-%m-%d %H:%M:%S")
#     except (ValueError, TypeError):
#         return ts


# def get_user_info(client: WebClient, user_id: str) -> dict:
#     """Fetch user information"""
#     try:
#         result = client.users_info(user=user_id)
#         user = result["user"]
#         return {
#             "id": user.get("id"),
#             "name": user.get("real_name"),
#             "display_name": user.get("profile", {}).get("display_name"),
#             "email": user.get("profile", {}).get("email"),
#         }
#     except SlackApiError as e:
#         print(f"Error fetching user {user_id}: {e.response['error']}")
#         return {}


# def get_channel_info(client: WebClient, channel_id: str) -> dict:
#     """Fetch channel information"""
#     try:
#         result = client.conversations_info(channel=channel_id)
#         channel = result["channel"]
#         return {
#             "id": channel.get("id"),
#             "name": channel.get("name"),
#             "is_private": channel.get("is_private"),
#             "is_dm": channel.get("is_im"),
#             "topic": channel.get("topic", {}).get("value"),
#         }
#     except SlackApiError as e:
#         print(f"Error fetching channel {channel_id}: {e.response['error']}")
#         return {}


# def get_workspace_info(client: WebClient) -> dict:
#     """Fetch workspace/team information"""
#     try:
#         result = client.team_info()
#         team = result["team"]
#         return {
#             "id": team.get("id"),
#             "name": team.get("name"),
#             "domain": team.get("domain"),
#         }
#     except SlackApiError as e:
#         print(f"Error fetching team info: {e.response['error']}")
#         return {}


# def fetch_channel_history(client: WebClient, channel_id: str, limit: int = 50, oldest: float | None = None) -> list:
#     """Fetch message history from a channel or DM with basic retry."""
#     attempts = 2
#     for attempt in range(1, attempts + 1):
#         try:
#             kwargs = {"channel": channel_id, "limit": limit}
#             if oldest is not None:
#                 kwargs["oldest"] = oldest
#             result = client.conversations_history(**kwargs)
#             messages = result.get("messages", [])
#             return messages
#         except IncompleteRead as e:
#             print(f"Incomplete read fetching history for {channel_id} (attempt {attempt}/{attempts}): {e}")
#             if attempt == attempts:
#                 raise HTTPException(status_code=503, detail="Failed to load Slack history (incomplete read)")
#         except SlackApiError as e:
#             print(f"Error fetching history for {channel_id}: {e.response['error']}")
#             return []
#     return []


# # --------  ~~~-- ROUTE ERROR WRAPPER ----------

# def check_and_mark_event(event_id: Optional[str]) -> bool:
#     """Return True if event_id was seen recently; otherwise mark and return False."""
#     if not event_id:
#         return False
#     now = time()
#     expired = [eid for eid, ts in list(PROCESSED_EVENTS.items()) if now - ts > EVENT_TTL_SECONDS]
#     for eid in expired:
#         PROCESSED_EVENTS.pop(eid, None)
#     if event_id in PROCESSED_EVENTS:
#         return True
#     PROCESSED_EVENTS[event_id] = now
#     return False

# def with_route_errors(func):
#     """Wrap route handlers to return 500 on unexpected errors."""
#     if inspect.iscoroutinefunction(func):
#         @wraps(func)
#         async def async_wrapper(*args, **kwargs):
#             try:
#                 return await func(*args, **kwargs)
#             except HTTPException:
#                 raise
#             except Exception as exc:
#                 print(f"Unhandled error in {func.__name__}: {exc}")
#                 raise HTTPException(status_code=500, detail="Internal server error")

#         return async_wrapper

#     @wraps(func)
#     def sync_wrapper(*args, **kwargs):
#         try:
#             return func(*args, **kwargs)
#         except HTTPException:
#             raise
#         except Exception as exc:
#             print(f"Unhandled error in {func.__name__}: {exc}")
#             raise HTTPException(status_code=500, detail="Internal server error")

#     return sync_wrapper


# def print_user_info(client: WebClient, user_id: str, team_id: str):
#     """Print user info to terminal with timestamp"""
#     user_info = get_user_info(client, user_id)
#     workspace_info = get_workspace_info(client)
#     current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
#     print("\n" + "="*60)
#     print(f"[{current_time}] [{team_id}] USER INFORMATION")
#     print("="*60)
#     print(f"User ID: {user_info.get('id')}")
#     print(f"Name: {user_info.get('name')}")
#     print(f"Display Name: {user_info.get('display_name')}")
#     print(f"Email: {user_info.get('email')}")
#     print(f"Workspace: {workspace_info.get('name')} (ID: {workspace_info.get('id')})")
#     print("="*60 + "\n")


# def print_channel_info(client: WebClient, channel_id: str, team_id: str):
#     """Print channel info to terminal with timestamp"""
#     channel_info = get_channel_info(client, channel_id)
#     current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
#     print("\n" + "="*60)
#     print(f"[{current_time}] [{team_id}] CHANNEL INFORMATION")
#     print("="*60)
#     print(f"Channel ID: {channel_info.get('id')}")
#     print(f"Name: {channel_info.get('name')}")
#     print(f"Private: {channel_info.get('is_private')}")
#     print(f"Direct Message: {channel_info.get('is_dm')}")
#     print(f"Topic: {channel_info.get('topic')}")
#     print("="*60 + "\n")


# def print_message_history(client: WebClient, channel_id: str, team_id: str, limit: int = 50):
#     """Print message history to terminal with timestamps"""
#     messages = fetch_channel_history(client, channel_id, limit)
#     current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
#     print("\n" + "="*60)
#     print(f"[{current_time}] [{team_id}] MESSAGE HISTORY - {channel_id} (Last {len(messages)} messages)")
#     print("="*60)
    
#     for msg in reversed(messages):  # Show oldest first
#         user_id = msg.get("user", "bot")
#         text = msg.get("text", "[no text]")
#         ts = msg.get("ts")
#         msg_time = ts_to_datetime(ts)  # Convert timestamp to readable format
        
#         # Get user info for better display
#         if user_id != "bot":
#             user_info = get_user_info(client, user_id)
#             user_name = user_info.get("name", user_id)
#         else:
#             user_name = "bot"
        
#         print(f"\n[{msg_time}] {user_name} ({user_id}):")
#         print(f"  {text}")
    
#     print("\n" + "="*60 + "\n")


# # ---------- EVENT PROCESSING HELPERS ----------

# def log_message_event(team_id: str, event: Dict[str, Any], event_id: Optional[str] = None) -> None:
#     """Log message event details without delaying Slack ack."""
#     if event.get("type") != "message" or event.get("bot_id"):
#         return
#     user = event.get("user")
#     text = event.get("text")
#     channel = event.get("channel")
#     ts = event.get("ts")
#     msg_time = ts_to_datetime(ts)

#     try:
#         print(f"[{msg_time}] [IN {team_id}] user={user} channel={channel} text={text} event_id={event_id or ''}")
#         client = client_rtc if team_id == TEAM_RTC else client_beta
#         print_user_info(client, user, team_id)
#         print_channel_info(client, channel, team_id)
#         if LOG_HISTORY:
#             print_message_history(client, channel, team_id, limit=10)
#     except Exception as exc:
#         print(f"Error handling message event {event_id or ''}: {exc}")


# # ---------- FASTAPI APP ----------

# app = FastAPI()

# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=["*"],
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
# )


# @app.get("/api/organizations")
# @with_route_errors
# def get_organizations():
#     return ORGANIZATIONS_META


# @app.get("/api/orgs/{org_id}/chats")
# @with_route_errors
# def get_org_chats(org_id: str):
#     return list_chats_for_org(org_id)


# @app.get("/api/chats/{chat_id}/messages")
# @with_route_errors
# def get_chat_messages(chat_id: str, org_id: str):
#     return fetch_messages_for_chat(org_id, chat_id)


# @app.get("/api/chats/{chat_id}/thread")
# @with_route_errors
# def get_chat_thread(chat_id: str, org_id: str, thread_ts: str):
#     return fetch_thread_replies(org_id, chat_id, thread_ts)


# @app.post("/slack/events")
# @with_route_errors
# async def slack_events(request: Request, background_tasks: BackgroundTasks):
#     body = await request.body()
#     headers = request.headers

#     try:
#         payload = await request.json()
#     except (json.JSONDecodeError, UnicodeDecodeError):
#         raise HTTPException(status_code=400, detail="Invalid JSON payload")

#     # 1) URL verification
#     if payload.get("type") == "url_verification":
#         return {"challenge": payload["challenge"]}

#     team_id = payload.get("team_id")

#     # 2) Verify signatures
#     valid_rtc = verifier_rtc.is_valid_request(body, headers)
#     valid_beta = verifier_beta.is_valid_request(body, headers)

#     if team_id == TEAM_RTC and not valid_rtc:
#         raise HTTPException(status_code=403, detail="Invalid RTC signature")
#     if team_id == TEAM_BETA and not valid_beta:
#         raise HTTPException(status_code=403, detail="Invalid BETA signature")
#     if team_id not in (TEAM_RTC, TEAM_BETA):
#         raise HTTPException(status_code=400, detail="Unknown team_id")

#     event = payload.get("event", {})
#     event_id = payload.get("event_id")

#     if check_and_mark_event(event_id):
#         return {"ok": True, "duplicate": True}

#     if event.get("type") == "message" and not event.get("bot_id"):
#         background_tasks.add_task(log_message_event, team_id, event, event_id)

#     return {"ok": True}


# class ReplyPayload(BaseModel):
#     team_id: str
#     channel: str
#     text: str
#     thread_ts: str | None = None


# @app.post("/reply")
# @with_route_errors
# async def reply(payload: ReplyPayload):
#     if payload.team_id == TEAM_RTC:
#         c = client_rtc
#     elif payload.team_id == TEAM_BETA:
#         c = client_beta
#     else:
#         raise HTTPException(status_code=400, detail="Unknown team_id")

#     resp = c.chat_postMessage(
#         channel=payload.channel,
#         text=payload.text,
#         thread_ts=payload.thread_ts,
#     )
#     current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
#     print(f"[{current_time}] [OUT {payload.team_id}] channel={payload.channel} ts={resp['ts']} text={payload.text}")
#     return {"ok": True}


# # ---------- TEST ENDPOINTS (for terminal display) ----------

# @app.get("/test/user/{team_id}/{user_id}")
# @with_route_errors
# async def test_user(team_id: str, user_id: str):
#     """Test endpoint to display user info"""
#     if team_id == TEAM_RTC:
#         c = client_rtc
#     elif team_id == TEAM_BETA:
#         c = client_beta
#     else:
#         raise HTTPException(status_code=400, detail="Unknown team_id")
    
#     print_user_info(c, user_id, team_id)
#     return get_user_info(c, user_id)


# @app.get("/test/channel/{team_id}/{channel_id}")
# @with_route_errors
# async def test_channel(team_id: str, channel_id: str):
#     """Test endpoint to display channel info"""
#     if team_id == TEAM_RTC:
#         c = client_rtc
#     elif team_id == TEAM_BETA:
#         c = client_beta
#     else:
#         raise HTTPException(status_code=400, detail="Unknown team_id")
    
#     print_channel_info(c, channel_id, team_id)
#     return get_channel_info(c, channel_id)


# @app.get("/test/workspace/{team_id}")
# @with_route_errors
# async def test_workspace(team_id: str):
#     """Test endpoint to display workspace info"""
#     if team_id == TEAM_RTC:
#         c = client_rtc
#     elif team_id == TEAM_BETA:
#         c = client_beta
#     else:
#         raise HTTPException(status_code=400, detail="Unknown team_id")
    
#     workspace_info = get_workspace_info(c)
#     current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
#     print("\n" + "="*60)
#     print(f"[{current_time}] [{team_id}] WORKSPACE INFORMATION")
#     print("="*60)
#     print(f"Workspace ID: {workspace_info.get('id')}")
#     print(f"Workspace Name: {workspace_info.get('name')}")
#     print(f"Domain: {workspace_info.get('domain')}")
#     print("="*60 + "\n")
#     return workspace_info


# @app.get("/test/history/{team_id}/{channel_id}")
# @with_route_errors
# async def test_history(team_id: str, channel_id: str, limit: int = 50):
#     """Test endpoint to display message history"""
#     if team_id == TEAM_RTC:
#         c = client_rtc
#     elif team_id == TEAM_BETA:
#         c = client_beta
#     else:
#         raise HTTPException(status_code=400, detail="Unknown team_id")
    
#     print_message_history(c, channel_id, team_id, limit)
#     return {"messages": fetch_channel_history(c, channel_id, limit)}
