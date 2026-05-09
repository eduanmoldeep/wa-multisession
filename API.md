# WhatsApp Multi-Instance API Specification

Base URL: `http://localhost:3000` (or your server origin)

All JSON responses use `Content-Type: application/json`. On error, the body typically includes an `error` string.

---

## Authentication

### Session (dashboard / browser)

- **Login:** `POST /api/login` with `{ username, password }`. On success, a session cookie is set.
- **Other endpoints:** Send the session cookie with each request (same origin or `credentials: 'include'` for cross-origin).

### Instance API key (server-to-server / scripts)

For instance-scoped routes you can use an **instance API key** instead of a session:

- **Header:** `X-API-Key: <instance-api-key>`  
  or **Header:** `Authorization: Bearer <instance-api-key>`
- The key must belong to the instance in the URL (e.g. `POST /api/instances/myinstance/send-message`).
- Keys are per instance; get or regenerate them via the dashboard or via session-authenticated API calls.

---

## Auth & current user

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/login` | None | Log in. |
| `POST` | `/api/logout` | None | Log out (destroy session). |
| `GET` | `/api/check-auth` | None | Check if session is valid. |
| `GET` | `/api/me` | Session | Get current user. |

### POST /api/login

**Request body:**

```json
{
  "username": "string",
  "password": "string"
}
```

**Success (200):**

```json
{
  "success": true,
  "user": { "id": 1, "username": "admin", "role": "admin" }
}
```

**Errors:** `401` — Invalid credentials.

---

### GET /api/check-auth

**Success (200):**

- Authenticated: `{ "authenticated": true, "user": { "id", "username", "role" } }`
- Not authenticated: `{ "authenticated": false }`

---

### GET /api/me

**Auth:** Session required.

**Success (200):**

```json
{
  "id": 1,
  "username": "admin",
  "role": "admin"
}
```

`role` is either `"admin"` or `"user"`.

**Errors:** `401` — Unauthorized.

---

## Instances

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/instances` | Session | List instances (filtered by user/role). |
| `POST` | `/api/instances` | Admin | Create instance. |
| `DELETE` | `/api/instances/:instanceId` | Admin | Delete instance. |
| `GET` | `/api/instances/:instanceId/api-key` | Session or API key | Get instance API key. |
| `POST` | `/api/instances/:instanceId/api-key/regenerate` | Session or API key | Regenerate instance API key. |
| `POST` | `/api/instances/:instanceId/send-message` | Session or API key | Send a WhatsApp message. |
| `POST` | `/api/instances/:instanceId/send-file` | Session or API key | Send a file with optional caption (filename + base64). |
| `GET` | `/api/instances/:instanceId/messages` | Session or API key | Get message log for this instance (incoming messages stored in DB). |
| `POST` | `/webhook/wahub/:instanceId` | API key only | Receive incoming message events (e.g. from WaHub). See [wahub_webhook.md](wahub_webhook.md). |
| `GET` | `/api/instances/:instanceId/users` | Admin | List users assigned to instance. |

### GET /api/instances

**Auth:** Session. Admin sees all instances; users see only assigned instances.

**Success (200):**

```json
[
  { "id": "client1", "status": "ready" },
  { "id": "client2", "status": "qr_ready" }
]
```

`status`: `initializing` | `qr_ready` | `authenticated` | `ready` | `disconnected`

---

### POST /api/instances

**Auth:** Admin only.

**Request body:**

```json
{
  "instanceId": "string"
}
```

**Success (200):**

```json
{
  "success": true,
  "instanceId": "client1"
}
```

**Errors:** `400` — Instance ID required / Instance already exists. `500` — Server error.

---

### DELETE /api/instances/:instanceId

**Auth:** Admin only.

**Success (200):** `{ "success": true }`

**Errors:** `404` — Instance not found. `500` — Server error.

---

### GET /api/instances/:instanceId/api-key

**Auth:** Session (user must have access to this instance) or instance API key.

Returns the API key for the instance. If none exists, one is created and returned.

**Success (200):**

```json
{
  "apiKey": "64-char-hex-string"
}
```

**Errors:** `401` — Invalid API key or not allowed. `404` — Instance not found.

---

### POST /api/instances/:instanceId/api-key/regenerate

**Auth:** Session (with access) or instance API key.

Generates a new API key; the previous key stops working.

**Success (200):**

```json
{
  "apiKey": "64-char-hex-string"
}
```

---

### POST /api/instances/:instanceId/send-message

**Auth:** Session (with access to this instance) or instance API key.

**Request body:**

```json
{
  "to": "919876543210",
  "message": "Hello from API"
}
```

- **to:** Phone number with country code (digits only, e.g. `919876543210`), or full JID: `number@c.us` (user) or `groupId@g.us` (group).
- **message:** Text to send.

**Success (200):**

```json
{
  "success": true,
  "messageId": "true_1234567890@c.us_3EB0XXXXX"
}
```

**Errors:** `400` — `to` and `message` required. `401` — Invalid API key or access. `404` — Instance not found / recipient not registered on WhatsApp. `503` — Instance not ready (e.g. WhatsApp not connected). `500` — Send failed / recipient validation failed.

**Example with API key:**

```bash
curl -X POST "http://localhost:3000/api/instances/client1/send-message" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_INSTANCE_API_KEY" \
  -d '{"to": "919876543210", "message": "Hello"}'
```

---

### POST /api/instances/:instanceId/send-file

**Auth:** Session (with access to this instance) or instance API key.

Send a file with optional text caption. The file is provided as a base64 string.

**Request body:**

```json
{
  "to": "919876543210",
  "filename": "document.pdf",
  "fileBase64": "JVBERi0xLjQK...",
  "caption": "Optional caption text",
  "mimetype": "application/pdf"
}
```

- **to:** Phone number (digits only) or full JID (`number@c.us` or `groupId@g.us`).
- **filename:** Original filename (used for display and to infer mimetype if `mimetype` is omitted).
- **fileBase64:** Base64-encoded file content. Optional data-URL prefix (e.g. `data:application/pdf;base64,`) is stripped if present.
- **caption:** Optional. Text sent as the message caption with the file.
- **mimetype:** Optional. MIME type (e.g. `image/png`, `application/pdf`). If omitted, inferred from `filename` extension.

**Success (200):**

```json
{
  "success": true,
  "messageId": "true_1234567890@c.us_3EB0XXXXX"
}
```

**Errors:** `400` — `to`, `filename` and `fileBase64` required / Invalid base64. `401` — Invalid API key or access. `404` — Instance not found / recipient not registered on WhatsApp. `503` — Instance not ready. `500` — Send failed / recipient validation failed. `413` — Payload too large (request body over server limit).

**Body size limit:** The server limits JSON request body size (default 10mb, configurable via `JSON_BODY_LIMIT`). Base64 is ~1.33× file size, so keep files under ~7.5mb or increase the limit. For large images, resize or compress before sending to avoid 413.

---

### GET /api/instances/:instanceId/messages

**Auth:** Session (with access to this instance) or instance API key.

Returns the message log for the instance (incoming messages are stored in the database). Query param **limit** (default 500, max 2000) limits the number of messages returned. Messages are ordered newest first.

**Success (200):**

```json
[
  {
    "id": 1,
    "messageId": "true_1234567890@c.us_3EB0XXXXX",
    "from": "1234567890@c.us",
    "senderDisplay": "John Doe",
    "body": "Hello!",
    "timestamp": 1234567890,
    "createdAt": 1234567891
  }
]
```

- **senderDisplay:** Name or number shown for the sender (suitable for "Name/Number : message" display).

**Errors:** `401` — Invalid API key or access. `404` — Instance not found.

---

### GET /api/instances/:instanceId/users

**Auth:** Admin only.

**Success (200):** Array of users assigned to this instance:

```json
[
  { "id": 2, "username": "agent1", "role": "user" }
]
```

**Errors:** `404` — Instance not found.

---

## WebSocket: subscribing to incoming messages

You can listen for **incoming WhatsApp messages** by connecting to the WebSocket and subscribing to an instance. The same WebSocket is used for instance status (QR, ready, etc.) and for live message events.

**Connection:** `ws://localhost:3000` (or your server origin). You can use either **session** (dashboard) or **API key** (scripts / server-to-server).

**Flow (session):**

1. Connect to the WebSocket (session cookie is sent on upgrade).
2. Send `{ "type": "auth" }` (optional; server may send `{ "type": "auth_success" }`).
3. Send `{ "type": "subscribe", "instanceId": "your-instance-id" }` for each instance you want to watch. You must have access to that instance (session user or admin).
4. Receive events as JSON messages.

**Flow (API key – no session):**

1. Connect to the WebSocket (no cookie required).
2. Send `{ "type": "auth", "apiKey": "your-instance-api-key" }`. Server responds `{ "type": "auth_success", "instanceId": "…" }` or `{ "type": "error", "message": "…" }`.
3. Send `{ "type": "subscribe", "instanceId": "…" }` with the **same** instance ID that the API key belongs to. You can only subscribe to that one instance per connection.
4. Receive events as JSON messages (same `message`, `status`, etc. as above).

**Events you may receive:**

| `type`    | Description |
|-----------|-------------|
| `auth_success` | Response to `auth`. |
| `status` | Current instance status and optional QR (after subscribe). |
| `qr`     | New QR code (data URL) for scanning. |
| `ready`  | Instance is connected and ready. |
| `authenticated` | Instance authenticated. |
| `disconnected` | Instance disconnected (payload may include `reason`). |
| **`message`**  | **Incoming WhatsApp message** (see below). |
| `error`  | e.g. `{ "message": "Access denied to this instance" }`. |

**Incoming message payload (`type: "message"`):**

```json
{
  "type": "message",
  "instanceId": "client1",
  "message": {
    "messageId": "true_1234567890@c.us_3EB0XXXXX",
    "from": "1234567890@c.us",
    "to": "0987654321@c.us",
    "body": "Hello!",
    "timestamp": 1234567890,
    "fromMe": false,
    "hasMedia": false,
    "type": "chat",
    "author": null,
    "isStatus": false,
    "isForwarded": false,
    "hasQuotedMsg": false
  }
}
```

- **messageId:** Unique message ID.
- **from:** Chat ID of the sender (e.g. `1234567890@c.us` for private, or group JID).
- **to:** Recipient chat ID (your number when someone messages you).
- **body:** Text content of the message (empty for media-only).
- **timestamp:** Unix timestamp (seconds).
- **fromMe:** Always `false` for this event (we only broadcast incoming messages).
- **hasMedia:** `true` if the message has media (image, file, etc.); you can use the REST API or library to download media if needed.
- **type:** Message type (e.g. `chat`, `image`, `audio`, `document`).
- **author:** In groups, the participant who sent the message; `null` in private chats.
- **isStatus:** `true` for status updates.
- **isForwarded:** Whether the message was forwarded.
- **hasQuotedMsg:** Whether the message is a reply to another.

To **watch for incoming messages**: open a WebSocket, subscribe to the desired `instanceId`, and handle frames where `type === 'message'`.

---

## Users (admin only)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/users` | Admin | List all users. |
| `POST` | `/api/users` | Admin | Create user. |
| `DELETE` | `/api/users/:userId` | Admin | Delete user. |
| `PATCH` | `/api/users/:userId/password` | Admin | Set user password. |
| `GET` | `/api/users/:userId/instances` | Admin | List instances assigned to user. |
| `POST` | `/api/users/:userId/instances` | Admin | Assign instance to user. |
| `DELETE` | `/api/users/:userId/instances/:instanceId` | Admin | Remove instance from user. |

### GET /api/users

**Success (200):**

```json
[
  { "id": 1, "username": "admin", "role": "admin" },
  { "id": 2, "username": "agent1", "role": "user" }
]
```

---

### POST /api/users

**Request body:**

```json
{
  "username": "string",
  "password": "string",
  "role": "user"
}
```

`role` optional; `"admin"` or `"user"` (default `"user"`).

**Success (201):**

```json
{
  "id": 2,
  "username": "agent1",
  "role": "user"
}
```

**Errors:** `400` — Username and password required / Username already exists.

---

### DELETE /api/users/:userId

**Success (200):** `{ "success": true, "deleted": true }`  
If user was already missing: `{ "success": true, "deleted": false }`.

**Errors:** `400` — Cannot delete your own account / Cannot delete the last admin. `404` — User not found (when using strict behavior).

---

### PATCH /api/users/:userId/password

**Request body:**

```json
{
  "password": "newPassword"
}
```

**Success (200):** `{ "success": true }`

**Errors:** `400` — Password required. `404` — User not found.

---

### GET /api/users/:userId/instances

**Success (200):** Array of instance IDs assigned to the user:

```json
["client1", "client2"]
```

**Errors:** `404` — User not found.

---

### POST /api/users/:userId/instances

**Request body:**

```json
{
  "instanceId": "client1"
}
```

**Success (200):** `{ "success": true }`

**Errors:** `400` — Valid instanceId required. `404` — User not found.

---

### DELETE /api/users/:userId/instances/:instanceId

**Success (200):** `{ "success": true }`

Removes the instance assignment for the user.

---

## HTTP status summary

| Code | Meaning |
|------|--------|
| 200 | Success |
| 201 | Created (e.g. new user) |
| 400 | Bad request (validation, business rule) |
| 401 | Unauthorized (not logged in or invalid API key) |
| 403 | Forbidden (e.g. admin only, or no access to instance) |
| 404 | Not found (instance, user, etc.) |
| 500 | Server error |
| 503 | Service unavailable (e.g. instance not ready for send-message) |
