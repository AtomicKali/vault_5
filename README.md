# FileVault — Digital File Marketplace

A full-featured digital file marketplace with admin panel, Google login, QR payments, and more.

---

## 🚀 Deploy to Render via GitHub (Step-by-Step)

### STEP 1 — Create a GitHub Repository

1. Go to **https://github.com/new**
2. Repository name: `filevault-marketplace`
3. Set to **Public** (required for Render free tier)
4. Click **"Create repository"**

---

### STEP 2 — Upload These Files to GitHub

You have two options:

#### Option A — GitHub Web Upload (easiest, no terminal needed)
1. Open your new repo on GitHub
2. Click **"uploading an existing file"** (shown on the empty repo page)
3. Drag and drop ALL these files:
   - `server.js`
   - `package.json`
   - `render.yaml`
   - `.gitignore`
   - `public/index.html`
4. Scroll down → click **"Commit changes"**

#### Option B — Git Terminal
```bash
git init
git add .
git commit -m "Initial commit — FileVault marketplace"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/filevault-marketplace.git
git push -u origin main
```

---

### STEP 3 — Connect to Render

1. Go to **https://render.com** → Sign up (free)
2. Click **"New +"** → select **"Web Service"**
3. Click **"Connect account"** → authorize GitHub
4. Find and select your `filevault-marketplace` repo → click **"Connect"**

---

### STEP 4 — Configure the Service

Fill in these exact settings:

| Field | Value |
|-------|-------|
| **Name** | `filevault-marketplace` |
| **Environment** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Plan** | `Free` |

Click **"Create Web Service"**

---

### STEP 5 — Wait for Deploy

- Render will install dependencies and start the server (takes ~2 minutes)
- You'll see build logs in real time
- When it shows **"Your service is live"** ✅ you're done!
- Your URL will be: `https://filevault-marketplace.onrender.com`

---

## 📁 Project Structure

```
filevault-marketplace/
├── server.js          ← Express server
├── package.json       ← Dependencies
├── render.yaml        ← Render config
├── .gitignore
└── public/
    └── index.html     ← The entire app
```

## 🔑 Admin Login

```
Email:    admin@filevault.io
Password: admin123
```

## ⚠️ Notes

- **Free Render plan** spins down after 15 mins of inactivity — first load after sleep takes ~30 seconds
- To keep it always awake, upgrade to Render's Starter plan ($7/mo)
- All data is in-memory (resets on restart) — for persistent data, add a database like PostgreSQL or MongoDB
