# WhatsApp Multi-Instance Manager

A Node.js application for managing multiple WhatsApp Web instances with authentication, real-time QR code updates via WebSockets, and a clean UI.

**Disclaimer:** This is an **unofficial**, **educational** project—not affiliated with WhatsApp or Meta. Misuse (spam, Terms violations, abusive automation) can get your number **blocked or limited**; you are responsible for lawful, policy-compliant use. Software is provided as-is, without warranty.

---

## Features

- 🔐 **Session-based authentication** - Secure login system
- 📱 **Multiple WhatsApp instances** - Manage multiple WhatsApp connections simultaneously
- 🔄 **Real-time QR code updates** - WebSocket-powered live QR code refresh
- 💻 **Clean UI** - Svelte app (see [ui/README.md](ui/README.md)) with dashboard, instance cards, message log, API key management
- 🚀 **Easy to extend** - Built on Express.js with modular architecture

## Prerequisites

- Node.js 16+ (required for ES modules)
- npm or yarn

## Installation

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

3. Open your browser and navigate to:
```
http://localhost:3000
```

## Default Credentials

- **Username:** admin
- **Password:** admin123

⚠️ **Important:** Change these credentials in production! Edit the `users` object in `server.js`.

## Usage

### Creating a WhatsApp Instance

1. Log in with your credentials
2. Enter an instance ID (e.g., "client1", "sales-bot", etc.)
3. Click "Create Instance"
4. A QR code will appear - scan it with WhatsApp on your phone
5. Once connected, the instance status will change to "ready"

### Managing Multiple Instances

- Each instance runs independently with its own session
- Sessions are stored locally using `LocalAuth` from whatsapp-web.js
- You can have as many instances as your system resources allow

### Message listener

Each WhatsApp instance registers an **incoming message listener** (`client.on('message')`). When someone sends a message to that instance:

1. **Filter** – Messages from yourself (`fromMe`) are ignored.
2. **Persist** – The message is stored in the **`instance_messages`** table (see [Database](#database)), so the log survives server restarts.
3. **Broadcast** – Subscribed WebSocket clients receive a `message` event with the full payload (from, body, timestamp, hasMedia, senderDisplay, etc.).

You can:

- **View live** – Subscribe to the instance over WebSocket and handle `type: 'message'` to show messages in real time.
- **View history** – Call `GET /api/instances/:instanceId/messages?limit=500` to load the persisted log (see **API.md**).

The UI uses both: it fetches the message log on load and listens for new messages over WebSocket to update the log.

### WebSocket events

Connect to the WebSocket (same origin, with session cookie), send `{ "type": "subscribe", "instanceId": "your-instance-id" }`, and you'll receive:

- `qr` – New QR code generated
- `ready` – Instance is connected and ready
- `authenticated` – WhatsApp authentication successful
- `disconnected` – Instance disconnected
- **`message`** – Incoming WhatsApp message (see [Message listener](#message-listener) above). Payload: `instanceId` and `message` (messageId, from, to, body, timestamp, hasMedia, type, senderDisplay, etc.). Full shape in **API.md**.

## Project Structure

```
wa-multisession/
├── server.js           # Main server (Express + WebSocket + WhatsApp logic)
├── db.js               # SQLite (users, instance_api_keys, instance_messages, etc.)
├── public/             # Legacy/fallback static files
├── ui/                 # Svelte front end (Vite)
│   ├── src/            # App.svelte, components, lib/api.js
│   ├── dist/           # Production build (served by server when present)
│   └── README.md       # UI docs (structure, scripts, components)
├── package.json
├── readme.md           # This file
├── API.md              # REST & WebSocket API
└── wahub_webhook.md    # Webhook endpoint (WaHub)
```

## Database

User and message data are stored in **`data.db`** (SQLite) in the project root. Tables include:

- **users** – login, roles
- **user_instances** – which users can access which instances
- **instance_api_keys** – API key per instance
- **instance_messages** – message log (persists across boots)

SQLite runs in **WAL mode**. To inspect the DB with an external tool (e.g. DB Browser, `sqlite3`), either:

1. **Stop the server**, then open `data.db`, or  
2. Use a tool that supports WAL (it will use `data.db` + `data.db-wal`).

To list tables from the shell (with server stopped):

```bash
sqlite3 data.db ".tables"
```

You should see `instance_messages` (and others). The server runs a checkpoint on startup so the main file stays up to date.

## API Endpoints

postman link 
https://sj-dev-team.postman.co/workspace/SF_Practice~23d7639c-eba6-482b-871c-758a97782e4b/collection/27547824-0b9df179-bc04-47c3-9a07-79f6a6653810?action=share&creator=27547824

### Authentication
- `POST /api/login` - Login with username/password
- `POST /api/logout` - Logout current session
- `GET /api/check-auth` - Check authentication status

### Instance Management
- `GET /api/instances` - List all instances
- `POST /api/instances` - Create new instance
- `DELETE /api/instances/:instanceId` - Delete instance

## Security Considerations

### For Production:

1. **Change the session secret** in `server.js`:
   ```javascript
   secret: 'your-secret-key-change-this'
   ```

2. **Use a proper database** for user storage instead of in-memory object

3. **Enable HTTPS** and set secure cookies:
   ```javascript
   cookie: { secure: true, httpOnly: true, sameSite: 'strict' }
   ```

4. **Add rate limiting** to prevent brute force attacks

5. **Use environment variables** for sensitive configuration

6. **Implement proper password policies** and user management

## Extending the Application

### Sending Messages

Add endpoints to send messages through WhatsApp instances:
 
```javascript
app.post('/api/instances/:instanceId/send', requireAuth, async (req, res) => {
  const { instanceId } = req.params;
  const { number, message } = req.body;
  
  const instance = whatsappInstances.get(instanceId);
  if (!instance || instance.status !== 'ready') {
    return res.status(400).json({ error: 'Instance not ready' });
  }
  
  try {
    await instance.client.sendMessage(`${number}@c.us`, message);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### Adding Webhooks

Implement webhook endpoints to receive WhatsApp messages and forward them to your backend:

```javascript
client.on('message', async (msg) => {
  // Forward to your webhook URL
  await fetch('https://your-webhook.com/whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instanceId: instanceId,
      from: msg.from,
      body: msg.body,
      timestamp: msg.timestamp
    })
  });
});
```

## Troubleshooting

### QR Code Not Appearing

- Check browser console for WebSocket connection errors
- Ensure the instance is in "qr_ready" status
- Try refreshing the page

### Instance Stuck in "Initializing"

- Check server logs for errors
- Ensure Chromium dependencies are installed (required by Puppeteer)
- On Linux, you may need: `apt-get install -y chromium-browser`

### WebSocket Connection Failed

- Verify the WebSocket URL matches your deployment (ws:// for HTTP, wss:// for HTTPS)
- Check firewall settings

## License

MIT License - feel free to use this for your projects!

## Contributing

Pull requests welcome! For major changes, please open an issue first to discuss what you would like to change.