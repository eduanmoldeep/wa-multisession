# WhatsApp Multi-Instance API - Usage Guide

**AI-Friendly API Documentation** - Complete reference for integrating with the WhatsApp Multi-Instance Manager API.

**Base URL:** `http://localhost:3000` (or your server origin)  
**Protocol:** HTTP/HTTPS (REST) and WebSocket (real-time events)  
**Content-Type:** `application/json` for all requests/responses

---

## Table of Contents

1. [Authentication](#authentication)
2. [REST API Endpoints](#rest-api-endpoints)
3. [WebSocket API](#websocket-api)
4. [Webhook Integration](#webhook-integration)
5. [Common Use Cases](#common-use-cases)
6. [Error Handling](#error-handling)
7. [Code Examples](#code-examples)

---

## Authentication

The API supports two authentication methods:

### 1. Session Authentication (Browser/Dashboard)

**Use case:** Web UI, browser-based applications

**Flow:**
1. `POST /api/login` with `{ username, password }`
2. Server sets a session cookie
3. Include cookie in subsequent requests (automatic for same-origin, use `credentials: 'include'` for CORS)

**Example:**
```bash
curl -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"username":"admin","password":"admin123"}'
```

### 2. Instance API Key Authentication (Server-to-Server)

**Use case:** Scripts, external services, automated systems

**Header options:**
- `X-API-Key: <instance-api-key>`
- `Authorization: Bearer <instance-api-key>`

**Requirements:**
- API key must belong to the instance in the URL path
- Example: `POST /api/instances/myinstance/send-message` requires the API key for `myinstance`

**Getting an API key:**
```bash
# Via session auth
GET /api/instances/:instanceId/api-key

# Response: { "apiKey": "64-char-hex-string" }
```

**Example:**
```bash
curl -X POST http://localhost:3000/api/instances/myinstance/send-message \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_INSTANCE_API_KEY" \
  -d '{"to":"919876543210","message":"Hello"}'
```

---

## REST API Endpoints

### Authentication & User Management

#### `POST /api/login`
**Auth:** None  
**Purpose:** Authenticate and create session

**Request:**
```json
{
  "username": "admin",
  "password": "admin123"
}
```

**Response (200):**
```json
{
  "success": true,
  "user": {
    "id": 1,
    "username": "admin",
    "role": "admin"
  }
}
```

**Errors:** `401` - Invalid credentials

---

#### `GET /api/check-auth`
**Auth:** None (checks session cookie)  
**Purpose:** Check if current session is valid

**Response (200):**
```json
{
  "authenticated": true,
  "user": { "id": 1, "username": "admin", "role": "admin" }
}
```
or
```json
{
  "authenticated": false
}
```

---

#### `GET /api/me`
**Auth:** Session required  
**Purpose:** Get current authenticated user

**Response (200):**
```json
{
  "id": 1,
  "username": "admin",
  "role": "admin"
}
```

**Errors:** `401` - Unauthorized

---

### Instance Management

#### `GET /api/instances`
**Auth:** Session  
**Purpose:** List instances accessible to current user

**Response (200):**
```json
[
  { "id": "client1", "status": "ready" },
  { "id": "client2", "status": "qr_ready" }
]
```

**Status values:**
- `initializing` - Instance is starting up
- `qr_ready` - QR code available for scanning
- `authenticated` - WhatsApp authenticated
- `ready` - Connected and ready to send/receive
- `disconnected` - Connection lost

**Access control:**
- Admin: sees all instances
- User: sees only assigned instances

---

#### `POST /api/instances`
**Auth:** Admin only  
**Purpose:** Create a new WhatsApp instance

**Request:**
```json
{
  "instanceId": "myinstance"
}
```

**Response (200):**
```json
{
  "success": true,
  "instanceId": "myinstance"
}
```

**Errors:**
- `400` - Instance ID required / Instance already exists
- `500` - Server error

**Next steps:** After creation, connect via WebSocket to get QR code, scan with WhatsApp, wait for `ready` status.

---

#### `DELETE /api/instances/:instanceId`
**Auth:** Admin only  
**Purpose:** Delete an instance (removes session, messages, API key)

**Response (200):**
```json
{
  "success": true
}
```

**Errors:** `404` - Instance not found

---

#### `GET /api/instances/:instanceId/api-key`
**Auth:** Session (with access) or Instance API key  
**Purpose:** Get or create API key for instance

**Response (200):**
```json
{
  "apiKey": "64-character-hexadecimal-string"
}
```

**Note:** If no API key exists, one is created and returned.

---

#### `POST /api/instances/:instanceId/api-key/regenerate`
**Auth:** Session (with access) or Instance API key  
**Purpose:** Generate a new API key (previous key stops working)

**Response (200):**
```json
{
  "apiKey": "new-64-character-hexadecimal-string"
}
```

---

### Messaging

#### `POST /api/instances/:instanceId/send-message`
**Auth:** Session (with access) or Instance API key  
**Purpose:** Send a WhatsApp text message

**Request:**
```json
{
  "to": "919876543210",
  "message": "Hello from API"
}
```

**Parameters:**
- `to` (required): Phone number with country code, digits only (e.g. `919876543210`). No `+` or spaces.
- `message` (required): Text content to send

**Response (200):**
```json
{
  "success": true,
  "messageId": "true_1234567890@c.us_3EB0XXXXX"
}
```

**Errors:**
- `400` - `to` and `message` required
- `401` - Invalid API key or access denied
- `404` - Instance not found / recipient not registered on WhatsApp
- `503` - Instance not ready (status != `ready`)
- `500` - Send failed

**Example with API key:**
```bash
curl -X POST "http://localhost:3000/api/instances/client1/send-message" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_INSTANCE_API_KEY" \
  -d '{"to": "919876543210", "message": "Hello"}'
```

---

#### `POST /api/instances/:instanceId/send-file`
**Auth:** Session (with access) or Instance API key  
**Purpose:** Send a file with optional caption

**Request:**
```json
{
  "to": "919876543210",
  "filename": "document.pdf",
  "fileBase64": "JVBERi0xLjQK...",
  "caption": "Optional caption text",
  "mimetype": "application/pdf"
}
```

**Parameters:**
- `to` (required): Phone number with country code, digits only
- `filename` (required): Original filename
- `fileBase64` (required): Base64-encoded file content. Data-URL prefix (`data:application/pdf;base64,`) is automatically stripped if present
- `caption` (optional): Text caption sent with the file
- `mimetype` (optional): MIME type. If omitted, inferred from `filename` extension

**Supported MIME types:** PDF, DOC, DOCX, XLS, XLSX, PNG, JPG, JPEG, GIF, WEBP, MP4, MP3, OGG, WAV, TXT, CSV, JSON

**Response (200):**
```json
{
  "success": true,
  "messageId": "true_1234567890@c.us_3EB0XXXXX"
}
```

**Errors:**
- `400` - Missing required fields / Invalid base64
- `401` - Invalid API key or access
- `404` - Instance not found / recipient not registered on WhatsApp
- `503` - Instance not ready
- `500` - Send failed

---

#### `GET /api/instances/:instanceId/messages`
**Auth:** Session (with access) or Instance API key  
**Purpose:** Get message history for an instance

**Query parameters:**
- `limit` (optional): Number of messages to return (default: 500, max: 2000)

**Response (200):**
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

**Fields:**
- `id`: Database record ID
- `messageId`: WhatsApp message ID
- `from`: Sender JID (e.g. `1234567890@c.us`)
- `senderDisplay`: Display name or number
- `body`: Message text content
- `timestamp`: Unix timestamp (seconds) when message was received
- `createdAt`: Unix timestamp (seconds) when stored in database

**Note:** Messages are ordered newest first.

---

### Webhook Endpoint

#### `POST /webhook/wahub/:instanceId`
**Auth:** Instance API key only (no session)  
**Purpose:** Receive incoming message events from external services (e.g. WaHub)

**Headers:**
- `X-API-Key: <instance-api-key>` or `Authorization: Bearer <instance-api-key>`
- `Content-Type: application/json`
- `X-Webhook-Signature` or `X-Wahub-Signature` (optional, if `WEBHOOK_SECRET` is set)

**Request body formats:**

**Option A - Event wrapper:**
```json
{
  "event": "message",
  "data": {
    "from": "919876543210",
    "body": "Hello",
    "id": "msg-uuid-123"
  }
}
```

**Option B - Multiple messages:**
```json
{
  "event": "messages",
  "data": [
    { "from": "919876543210", "body": "Hi", "id": "id1" },
    { "from": "919876543210", "body": "Bye", "id": "id2" }
  ]
}
```

**Option C - Flat message:**
```json
{
  "message": {
    "from": "919876543210",
    "body": "Hello"
  }
}
```

**Message object fields:**
- `from` (required): Sender phone number (digits, optional country code)
- `body` or `text` or `content` (required): Message text
- `id` or `messageId` or `key.id` (optional): Unique message ID

**Response (200):**
```json
{
  "success": true,
  "received": true
}
```

**Behavior:**
- Messages are stored in the database
- Messages are broadcast to WebSocket subscribers for that instance
- Processing happens after response (async)

**Errors:**
- `401` - Invalid API key / Missing or invalid signature
- `400` - Invalid JSON body

**See also:** [wahub_webhook.md](wahub_webhook.md) for detailed webhook documentation.

---

### User Management (Admin Only)

#### `GET /api/users`
**Auth:** Admin only  
**Purpose:** List all users

**Response (200):**
```json
[
  { "id": 1, "username": "admin", "role": "admin" },
  { "id": 2, "username": "agent1", "role": "user" }
]
```

---

#### `POST /api/users`
**Auth:** Admin only  
**Purpose:** Create a new user

**Request:**
```json
{
  "username": "agent1",
  "password": "securePassword",
  "role": "user"
}
```

**Parameters:**
- `username` (required): Unique username
- `password` (required): User password
- `role` (optional): `"admin"` or `"user"` (default: `"user"`)

**Response (201):**
```json
{
  "id": 2,
  "username": "agent1",
  "role": "user"
}
```

**Errors:**
- `400` - Username and password required / Username already exists

---

#### `DELETE /api/users/:userId`
**Auth:** Admin only  
**Purpose:** Delete a user

**Response (200):**
```json
{
  "success": true,
  "deleted": true
}
```

**Errors:**
- `400` - Cannot delete your own account / Cannot delete the last admin
- `404` - User not found

---

#### `PATCH /api/users/:userId/password`
**Auth:** Admin only  
**Purpose:** Change user password

**Request:**
```json
{
  "password": "newPassword"
}
```

**Response (200):**
```json
{
  "success": true
}
```

---

#### `GET /api/users/:userId/instances`
**Auth:** Admin only  
**Purpose:** List instances assigned to a user

**Response (200):**
```json
["client1", "client2"]
```

---

#### `POST /api/users/:userId/instances`
**Auth:** Admin only  
**Purpose:** Assign an instance to a user

**Request:**
```json
{
  "instanceId": "client1"
}
```

**Response (200):**
```json
{
  "success": true
}
```

---

#### `DELETE /api/users/:userId/instances/:instanceId`
**Auth:** Admin only  
**Purpose:** Remove instance assignment from user

**Response (200):**
```json
{
  "success": true
}
```

---

## WebSocket API

**Connection URL:** `ws://localhost:3000` (or `wss://` for HTTPS)

### Authentication Methods

#### Session-Based (Browser/Dashboard)

1. Connect WebSocket (session cookie sent automatically)
2. Send `{ "type": "auth" }` (optional)
3. Receive `{ "type": "auth_success" }`
4. Send `{ "type": "subscribe", "instanceId": "your-instance-id" }` for each instance
5. Receive events

#### API Key-Based (Scripts/External Services)

1. Connect WebSocket (no cookie needed)
2. Send `{ "type": "auth", "apiKey": "your-instance-api-key" }`
3. Receive `{ "type": "auth_success", "instanceId": "..." }` or `{ "type": "error", "message": "..." }`
4. Send `{ "type": "subscribe", "instanceId": "..." }` (must match API key's instance)
5. Receive events

### Events You Can Send

| Type | Payload | Description |
|------|---------|-------------|
| `auth` | `{ "type": "auth" }` or `{ "type": "auth", "apiKey": "..." }` | Authenticate (session or API key) |
| `subscribe` | `{ "type": "subscribe", "instanceId": "..." }` | Subscribe to instance events |

### Events You Receive

| Type | Payload | Description |
|------|---------|-------------|
| `auth_success` | `{ "type": "auth_success", "instanceId": "..." }` | Authentication successful |
| `status` | `{ "type": "status", "instanceId": "...", "status": "ready", "qr": "..." }` | Instance status after subscribe |
| `qr` | `{ "type": "qr", "instanceId": "...", "qr": "data:image/png;base64,..." }` | New QR code generated |
| `ready` | `{ "type": "ready", "instanceId": "..." }` | Instance connected and ready |
| `authenticated` | `{ "type": "authenticated", "instanceId": "..." }` | WhatsApp authenticated |
| `disconnected` | `{ "type": "disconnected", "instanceId": "...", "reason": "..." }` | Instance disconnected |
| `message` | See below | Incoming WhatsApp message |
| `error` | `{ "type": "error", "message": "..." }` | Error occurred |

### Message Event Structure

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
    "hasQuotedMsg": false,
    "senderDisplay": "John Doe"
  }
}
```

**Message fields:**
- `messageId`: Unique WhatsApp message ID
- `from`: Sender JID (e.g. `1234567890@c.us` for private, group JID for groups)
- `to`: Recipient JID (your number when someone messages you)
- `body`: Text content (empty for media-only messages)
- `timestamp`: Unix timestamp (seconds)
- `fromMe`: Always `false` (only incoming messages are broadcast)
- `hasMedia`: `true` if message contains media
- `type`: Message type (`chat`, `image`, `audio`, `document`, etc.)
- `author`: Group participant who sent (null for private chats)
- `isStatus`: `true` for status updates
- `isForwarded`: Whether message was forwarded
- `hasQuotedMsg`: Whether message is a reply
- `senderDisplay`: Display name or number

---

## Common Use Cases

### Use Case 1: Send a Message via API Key

```bash
# 1. Get API key (via session auth or dashboard)
curl -X GET "http://localhost:3000/api/instances/myinstance/api-key" \
  -H "Cookie: session=..."

# 2. Send message
curl -X POST "http://localhost:3000/api/instances/myinstance/send-message" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"to":"919876543210","message":"Hello from API"}'
```

### Use Case 2: Listen for Incoming Messages (WebSocket)

**JavaScript/Node.js:**
```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
  // Authenticate with API key
  ws.send(JSON.stringify({
    type: 'auth',
    apiKey: 'YOUR_INSTANCE_API_KEY'
  }));
});

ws.on('message', (data) => {
  const event = JSON.parse(data);
  
  if (event.type === 'auth_success') {
    // Subscribe to instance
    ws.send(JSON.stringify({
      type: 'subscribe',
      instanceId: event.instanceId
    }));
  } else if (event.type === 'message') {
    console.log('New message:', event.message.body);
    console.log('From:', event.message.from);
  }
});
```

**Python:**
```python
import websocket
import json

def on_message(ws, message):
    event = json.loads(message)
    if event['type'] == 'auth_success':
        ws.send(json.dumps({
            'type': 'subscribe',
            'instanceId': event['instanceId']
        }))
    elif event['type'] == 'message':
        print(f"New message: {event['message']['body']}")
        print(f"From: {event['message']['from']}")

def on_open(ws):
    ws.send(json.dumps({
        'type': 'auth',
        'apiKey': 'YOUR_INSTANCE_API_KEY'
    }))

ws = websocket.WebSocketApp(
    "ws://localhost:3000",
    on_message=on_message,
    on_open=on_open
)
ws.run_forever()
```

### Use Case 3: Receive Messages via Webhook

**Configure WaHub to POST to your webhook:**

```
URL: https://your-server.com/webhook/wahub/myinstance
Method: POST
Headers:
  X-API-Key: YOUR_INSTANCE_API_KEY
  Content-Type: application/json
Body: {
  "event": "message",
  "data": {
    "from": "919876543210",
    "body": "Hello",
    "id": "msg-123"
  }
}
```

**Your server receives the POST, stores the message, and broadcasts to WebSocket subscribers.**

### Use Case 4: Get Message History

```bash
curl -X GET "http://localhost:3000/api/instances/myinstance/messages?limit=100" \
  -H "X-API-Key: YOUR_API_KEY"
```

---

## Error Handling

### HTTP Status Codes

| Code | Meaning | Common Causes |
|------|---------|---------------|
| 200 | Success | Request completed successfully |
| 201 | Created | Resource created (e.g. new user) |
| 400 | Bad Request | Invalid parameters, validation failed, business rule violation |
| 401 | Unauthorized | Not logged in, invalid API key, expired session |
| 403 | Forbidden | Admin-only endpoint, no access to instance |
| 404 | Not Found | Instance/user/resource doesn't exist |
| 500 | Server Error | Internal server error, unexpected failure |
| 503 | Service Unavailable | Instance not ready (e.g. WhatsApp not connected) |

### Error Response Format

```json
{
  "error": "Error message description"
}
```

### Common Error Scenarios

**1. Instance not ready (503):**
```json
{
  "error": "Instance not ready. Wait for WhatsApp to connect."
}
```
**Solution:** Check instance status via WebSocket or `GET /api/instances`, wait for `ready` status.

**2. Invalid API key (401):**
```json
{
  "error": "Invalid API key or instance"
}
```
**Solution:** Verify API key matches the instance in the URL, regenerate if needed.

**3. Access denied (403):**
```json
{
  "error": "Access denied to this instance"
}
```
**Solution:** User doesn't have access to this instance (admin must assign it).

**4. Instance not found (404):**
```json
{
  "error": "Instance not found"
}
```
**Solution:** Verify instance ID exists, check `GET /api/instances`.

---

## Code Examples

### Complete Example: Send Message and Listen for Replies

**Node.js:**
```javascript
const WebSocket = require('ws');
const axios = require('axios');

const API_BASE = 'http://localhost:3000';
const INSTANCE_ID = 'myinstance';
const API_KEY = 'YOUR_API_KEY';

// 1. Send a message
async function sendMessage(to, message) {
  try {
    const response = await axios.post(
      `${API_BASE}/api/instances/${INSTANCE_ID}/send-message`,
      { to, message },
      { headers: { 'X-API-Key': API_KEY } }
    );
    console.log('Message sent:', response.data.messageId);
  } catch (error) {
    console.error('Send failed:', error.response?.data?.error || error.message);
  }
}

// 2. Listen for incoming messages
function listenForMessages() {
  const ws = new WebSocket('ws://localhost:3000');
  
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'auth', apiKey: API_KEY }));
  });
  
  ws.on('message', (data) => {
    const event = JSON.parse(data);
    
    if (event.type === 'auth_success') {
      ws.send(JSON.stringify({
        type: 'subscribe',
        instanceId: INSTANCE_ID
      }));
    } else if (event.type === 'message') {
      console.log(`[${event.instanceId}] ${event.message.senderDisplay}: ${event.message.body}`);
      
      // Auto-reply example
      if (event.message.body.toLowerCase().includes('hello')) {
        const fromNumber = event.message.from.replace('@c.us', '');
        sendMessage(fromNumber, 'Hi! How can I help you?');
      }
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
}

// Start listening
listenForMessages();

// Send a test message
sendMessage('919876543210', 'Hello from API');
```

**Python:**
```python
import websocket
import json
import requests
import threading

API_BASE = 'http://localhost:3000'
INSTANCE_ID = 'myinstance'
API_KEY = 'YOUR_API_KEY'

def send_message(to, message):
    url = f'{API_BASE}/api/instances/{INSTANCE_ID}/send-message'
    headers = {'X-API-Key': API_KEY, 'Content-Type': 'application/json'}
    data = {'to': to, 'message': message}
    response = requests.post(url, json=data, headers=headers)
    if response.status_code == 200:
        print(f'Message sent: {response.json()["messageId"]}')
    else:
        print(f'Send failed: {response.json().get("error")}')

def on_message(ws, message):
    event = json.loads(message)
    if event['type'] == 'auth_success':
        ws.send(json.dumps({
            'type': 'subscribe',
            'instanceId': INSTANCE_ID
        }))
    elif event['type'] == 'message':
        msg = event['message']
        print(f"[{event['instanceId']}] {msg['senderDisplay']}: {msg['body']}")
        
        # Auto-reply example
        if 'hello' in msg['body'].lower():
            from_number = msg['from'].replace('@c.us', '')
            send_message(from_number, 'Hi! How can I help you?')

def on_open(ws):
    ws.send(json.dumps({'type': 'auth', 'apiKey': API_KEY}))

ws = websocket.WebSocketApp(
    "ws://localhost:3000",
    on_message=on_message,
    on_open=on_open
)

# Start WebSocket in background thread
threading.Thread(target=ws.run_forever, daemon=True).start()

# Send a test message
send_message('919876543210', 'Hello from API')

# Keep script running
import time
time.sleep(3600)
```

---

## Best Practices

1. **API Key Security:**
   - Store API keys securely (environment variables, secrets manager)
   - Never commit API keys to version control
   - Regenerate keys if compromised

2. **Error Handling:**
   - Always check HTTP status codes
   - Handle `503` (instance not ready) with retry logic
   - Implement exponential backoff for retries

3. **WebSocket:**
   - Implement reconnection logic (exponential backoff)
   - Handle `close` events and reconnect
   - Validate event types before processing

4. **Rate Limiting:**
   - Be mindful of WhatsApp rate limits
   - Implement queuing for bulk sends
   - Monitor instance status before sending

5. **Message Formatting:**
   - Phone numbers: digits only, with country code (e.g. `919876543210`)
   - No `+` or spaces in phone numbers
   - Text messages: plain text (no HTML)

---

## Additional Resources

- **API Reference:** [API.md](API.md) - Detailed endpoint documentation
- **Webhook Guide:** [wahub_webhook.md](wahub_webhook.md) - Webhook integration details
- **UI Documentation:** [ui/README.md](ui/README.md) - Frontend implementation guide

---

**Last Updated:** 2026-02-17  
**API Version:** 1.0
