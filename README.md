# 📻 Online Radio Manager

A full-featured online radio manager and streaming platform — similar to RadioKing. Built with Node.js, Express, Socket.io, and SQLite.

## ✨ Features

- **🎵 Library** – Upload and manage audio files (MP3, WAV, OGG, AAC, FLAC) across organized trays (Music, Jingles, Ads, Recordings)
- **📂 Playlists** – Create manual playlists with custom colors
- **🎙️ Programs** – Build show templates combining multiple playlists
- **📅 Planning** – Weekly visual calendar with 15-min time slots (click any cell to add a slot)
- **⏱️ Breaks** – Schedule jingles/ads at exact times with cron precision
- **🔄 Daily Generation** – Auto-generate the broadcast queue from your planning
- **📡 Live Streaming** – Real HTTP audio stream at `/stream` compatible with any media player
- **🎧 Public Player** – Beautiful listener page at `/listen`
- **📊 Dashboard** – Live stats: listeners, queue, now playing
- **📜 History** – Track broadcast history
- **🤖 Auto-Filler** – Prevents dead air when queue is empty
- **⚡ Real-time** – Socket.io live updates for now-playing, listener count

---

## 🚀 Deploy to Render

### Option 1: One-click with render.yaml

1. Push this project to a GitHub repository
2. Go to [render.com](https://render.com) → New → Blueprint
3. Connect your GitHub repo
4. Render will auto-detect `render.yaml` and configure everything
5. Click **Apply** — your radio will be live in ~2 minutes!

### Option 2: Manual Render setup

1. Go to [render.com](https://render.com) → New → Web Service
2. Connect your GitHub repo
3. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Node Version**: 18+
4. Add a **Persistent Disk**:
   - Mount Path: `/opt/render/project/src/uploads`
   - Size: 10 GB
5. Click **Create Web Service**

---

## 💻 Run Locally

```bash
# Install dependencies
npm install

# Start the server
npm start

# Or with auto-restart during development
npm run dev
```

Open http://localhost:3000

---

## 📖 Getting Started Guide

### 1. Upload Tracks
Go to **Library** → click **Upload Files** → drag and drop your MP3s.  
Name your files as `Artist - Title.mp3` for automatic metadata parsing.

### 2. Create a Playlist
Go to **Playlists** → **New Playlist** → give it a name and color.  
Then go back to Library → click the **📂** button on each track to add it.

### 3. Schedule in Planning
Go to **Planning** → click any time slot on the calendar → select your playlist → save.  
You can schedule content up to 6 months in advance.

### 4. Schedule Breaks (optional)
Go to **Breaks** → **Add Break** → set the time, select a jingle track, choose days.

### 5. Generate Daily Queue
Go to **Daily Generation** → select today → click **Generate Day** → click **Play This Day**.

### 6. Start Broadcasting
Go to **Dashboard** → click **▶ Start Radio**  
Your stream is live at: `https://your-app.onrender.com/stream`  
Public player: `https://your-app.onrender.com/listen`

---

## 🔗 API Endpoints

| Endpoint | Description |
|---|---|
| `GET /stream` | Live audio stream (MP3) |
| `GET /listen` | Public player page |
| `GET /api/status` | Radio status (JSON) |
| `GET /api/tracks` | List all tracks |
| `POST /api/tracks/upload` | Upload audio files |
| `GET /api/playlists` | List playlists |
| `POST /api/playlists` | Create playlist |
| `GET /api/planning` | Get planning slots |
| `POST /api/planning` | Add planning slot |
| `GET /api/breaks` | List breaks |
| `POST /api/breaks` | Add break |
| `POST /api/daily-queue/generate` | Generate queue for a date |
| `POST /api/player/play` | Start radio |
| `POST /api/player/stop` | Stop radio |
| `POST /api/player/skip` | Skip track |
| `GET /api/history` | Broadcast history |

---

## 🛠 Tech Stack

- **Backend**: Node.js + Express
- **Database**: SQLite (better-sqlite3)
- **Real-time**: Socket.io
- **File uploads**: Multer
- **Scheduling**: node-cron
- **Frontend**: Vanilla JS (no framework)
- **Fonts**: Space Grotesk + Space Mono

---

## 📁 Project Structure

```
├── server.js          # Main entry point
├── db.js              # SQLite schema & setup
├── audioEngine.js     # Audio streaming engine
├── scheduler.js       # Cron-based scheduler
├── routes/
│   └── api.js         # All REST API routes
├── public/
│   ├── index.html     # Radio Manager UI
│   └── player.html    # Public listener page
├── uploads/           # Audio files (persistent on Render)
├── data/              # SQLite database
├── render.yaml        # Render deployment config
└── package.json
```

---

## ⚠️ Notes

- The **free tier** on Render spins down after inactivity. Upgrade to **Starter ($7/mo)** for 24/7 uptime.
- Audio files are stored on a **Persistent Disk** — they survive server restarts.
- The stream uses HTTP chunked transfer. It works in most browsers and media players (VLC, Winamp, etc.)
- For best audio quality, upload **128–320 kbps MP3** files.

---

## 📜 License

MIT
