# NEXUS STEAM HQ — Deploy to Render

## 📁 Files in this folder
```
index.html    ← Your marketplace (don't rename this)
server.js     ← Express server (serves the HTML)
package.json  ← Node.js config
.gitignore    ← Excludes node_modules from Git
```

---

## 🚀 Step-by-Step: Deploy to Render (Free)

### Step 1 — Push to GitHub
1. Go to [github.com](https://github.com) → create a free account if needed
2. Click **"New repository"** → name it `filevault` → **Public** → **Create**
3. Upload all 4 files from this folder (`index.html`, `server.js`, `package.json`, `.gitignore`)
4. Click **"Commit changes"**

### Step 2 — Create a Render account
1. Go to [render.com](https://render.com) → **Sign up free** (use GitHub to sign in — easiest)

### Step 3 — Create a Web Service on Render
1. Click **"New +"** → **"Web Service"**
2. Click **"Connect a repository"** → select your `filevault` repo
3. Fill in the settings:

| Field | Value |
|-------|-------|
| **Name** | `filevault-marketplace` |
| **Region** | Singapore (closest to India) |
| **Branch** | `main` |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Instance Type** | `Free` |

4. Click **"Create Web Service"**

### Step 4 — Wait ~2 minutes
Render will install dependencies and start your server.

### Step 5 — Your site is live! 🎉
Your URL will be:
```
https://filevault-marketplace.onrender.com
```
(or similar — Render assigns the URL automatically)

---

## ⚠️ Free Tier Note
On Render's free plan, the server **sleeps after 15 minutes of inactivity**.  
The first visit after sleep takes ~30 seconds to wake up.  
To avoid this, upgrade to the **Starter plan ($7/mo)** or use [UptimeRobot](https://uptimerobot.com) (free) to ping your site every 10 minutes and keep it awake.

---

## 🔧 Google OAuth Setup (Optional)
To enable "Sign in with Google":
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project → Enable **Google Identity API**
3. Go to **Credentials** → **Create OAuth 2.0 Client ID**
4. Add your Render URL to **Authorized JavaScript origins**:
   ```
   https://filevault-marketplace.onrender.com
   ```
5. Copy your **Client ID**
6. On your live site → **Admin** → **Settings** → paste the Client ID
