require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');
const fs = require('fs');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ── DIRECTORIES ───────────────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads'); // local fallback
[DATA_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── DATABASE ──────────────────────────────────────────────────────────────
const db = low(new FileSync(path.join(DATA_DIR, 'db.json')));
db.defaults({
  folders:  {},  // { [id]: { id, name, parentId, allowedEmails[], createdAt, createdBy } }
  files:    {},  // { [id]: { id, name, key, url, folderId, size, uploadedAt, uploadedBy, allowedEmails[], storage } }
  trash:    {},  // { [id]: { ...item, type, trashedAt, trashedBy } }
  shop:     {},  // { [id]: { id, name, description, price, currency, imageUrl, category, stock, active } }
  orders:   {},  // { [id]: { id, itemId, buyerEmail, qty, price, status, createdAt } }
  users:    {},  // { [email]: { email, name, avatar, firstSeen, lastSeen, totalUploads, totalDownloads, storageUsed } }
  activity: [],  // [{ id, type, who, what, when, detail, size }]
  online:   {}   // { [email]: lastSeen } — real-time presence
}).write();

// ── CONFIG ────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD       = process.env.ADMIN_PASSWORD       || 'changeme123';
const ADMIN_EMAILS         = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const SESSION_SECRET       = process.env.SESSION_SECRET       || 'vault-dev-secret';
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BASE_URL             = process.env.BASE_URL             || `http://localhost:${PORT}`;

// Cloudflare R2 config
const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID        || '';
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID     || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME       || '';
const USE_R2               = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME);

// ── S3/R2 CLIENT ──────────────────────────────────────────────────────────
let s3Client = null;
if (USE_R2) {
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY
    }
  });
  console.log('✅ Cloudflare R2 storage enabled');
} else {
  console.log('📁 Local disk storage (set R2 env vars to enable cloud storage)');
}

// ── MULTER ────────────────────────────────────────────────────────────────
let upload;
if (USE_R2) {
  upload = multer({
    storage: multerS3({
      s3: s3Client,
      bucket: R2_BUCKET_NAME,
      key: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `uploads/${uuidv4()}${ext}`);
      }
    }),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }
  });
} else {
  const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, uuidv4() + ext);
    }
  });
  upload = multer({ storage: diskStorage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// ── PASSPORT ──────────────────────────────────────────────────────────────
if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: `${BASE_URL}/auth/google/callback`
  }, (at, rt, profile, done) => {
    const email = profile.emails[0].value.toLowerCase();
    const user = { id: profile.id, uid: profile.id, email, name: profile.displayName, avatar: profile.photos[0]?.value || '' };
    const now = new Date().toISOString();
    const existing = db.get(`users.${email}`).value() || {};
    db.set(`users.${email}`, {
      ...user,
      firstSeen:      existing.firstSeen || now,
      lastSeen:       now,
      totalUploads:   existing.totalUploads   || 0,
      totalDownloads: existing.totalDownloads || 0,
      storageUsed:    existing.storageUsed    || 0
    }).write();
    return done(null, user);
  }));
}

passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((u, d) => d(null, u));

// ── HELPERS ───────────────────────────────────────────────────────────────
const isAdmin = req => !!(req.session?.adminAuth || (req.user && ADMIN_EMAILS.includes(req.user.email)));
const requireAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Admin required' });
const requireUser  = (req, res, next) => req.user  ? next() : res.status(401).json({ error: 'Sign in required' });

function logActivity(type, who, what, detail = '', size = 0) {
  const log = db.get('activity').value();
  log.unshift({ id: uuidv4(), type, who, what, when: new Date().toISOString(), detail, size });
  if (log.length > 1000) log.splice(1000);
  db.set('activity', log).write();
  // Broadcast to admin sockets
  io.to('admins').emit('activity', { type, who, what, detail, when: new Date().toISOString() });
}

function canAccessFolder(folderId, userEmail, admin) {
  if (admin) return true;
  const f = db.get(`folders.${folderId}`).value();
  return f && (f.allowedEmails || []).includes(userEmail);
}

function canAccessFile(fileId, userEmail, admin) {
  if (admin) return true;
  const f = db.get(`files.${fileId}`).value();
  if (!f) return false;
  if ((f.allowedEmails || []).includes(userEmail)) return true;
  if (f.folderId) return canAccessFolder(f.folderId, userEmail, false);
  return false;
}

async function getDownloadUrl(file) {
  if (USE_R2 && file.key) {
    const cmd = new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: file.key });
    return getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
  }
  return `${BASE_URL}/download/${file.id}`;
}

// ── REAL-TIME (SOCKET.IO) ─────────────────────────────────────────────────
const onlineUsers = new Map(); // socketId -> { email, name }

io.on('connection', (socket) => {
  socket.on('auth', ({ email, name, isAdmin: admin }) => {
    if (!email) return;
    onlineUsers.set(socket.id, { email, name });
    if (admin) socket.join('admins');
    // Update presence
    db.set(`online.${email}`, new Date().toISOString()).write();
    io.to('admins').emit('presence', { email, name, online: true });
  });

  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      onlineUsers.delete(socket.id);
      io.to('admins').emit('presence', { email: user.email, name: user.name, online: false });
    }
  });

  // Real-time file notifications
  socket.on('join-folder', (folderId) => socket.join(`folder:${folderId}`));
  socket.on('leave-folder', (folderId) => socket.leave(`folder:${folderId}`));
});

// ── AUTH ROUTES ───────────────────────────────────────────────────────────
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => { const r = req.session.returnTo || '/'; delete req.session.returnTo; res.redirect(r); }
);
app.post('/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.post('/auth/admin-password', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.adminAuth = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});
app.get('/api/me', (req, res) => res.json({ user: req.user || null, isAdmin: isAdmin(req) }));

// ── FOLDERS ───────────────────────────────────────────────────────────────
app.post('/api/folders', requireAdmin, (req, res) => {
  const { name, parentId = null } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  const folder = { id, name: name.trim(), parentId, allowedEmails: [], createdAt: new Date().toISOString(), createdBy: req.user?.email || 'admin' };
  db.set(`folders.${id}`, folder).write();
  logActivity('folder_create', req.user?.email || 'admin', name.trim(), 'Folder created');
  io.emit('folder:created', folder);
  res.json(folder);
});

app.get('/api/folders', requireUser, (req, res) => {
  const admin = isAdmin(req);
  const email = req.user.email;
  const all = Object.values(db.get('folders').value() || {});
  res.json(admin ? all : all.filter(f => canAccessFolder(f.id, email, false)));
});

app.put('/api/folders/:id', requireAdmin, (req, res) => {
  const folder = db.get(`folders.${req.params.id}`).value();
  if (!folder) return res.status(404).json({ error: 'Not found' });
  const updates = {};
  if (req.body.name) updates.name = req.body.name.trim();
  if (req.body.allowedEmails !== undefined) {
    updates.allowedEmails = req.body.allowedEmails.map(e => e.trim().toLowerCase()).filter(e => e.includes('@'));
  }
  const updated = { ...folder, ...updates };
  db.set(`folders.${req.params.id}`, updated).write();
  logActivity('folder_update', req.user?.email || 'admin', folder.name, 'Updated');
  io.emit('folder:updated', updated);
  res.json(updated);
});

app.delete('/api/folders/:id', requireAdmin, (req, res) => {
  const folder = db.get(`folders.${req.params.id}`).value();
  if (!folder) return res.status(404).json({ error: 'Not found' });
  db.set(`trash.${folder.id}`, { ...folder, type: 'folder', trashedAt: new Date().toISOString(), trashedBy: req.user?.email || 'admin' }).write();
  db.unset(`folders.${folder.id}`).write();
  logActivity('folder_trash', req.user?.email || 'admin', folder.name, 'Moved to trash');
  io.emit('folder:deleted', { id: folder.id });
  res.json({ success: true });
});

// ── FILES ─────────────────────────────────────────────────────────────────
app.post('/api/files', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const folderId = req.body.folderId || null;
  const id = uuidv4();

  // Handle R2 vs local storage
  const isR2 = USE_R2 && req.file.key;
  const fileEntry = {
    id,
    name:       req.file.originalname.replace(/[^a-zA-Z0-9._\-\s]/g, '_'),
    key:        isR2 ? req.file.key : null,
    diskName:   isR2 ? null : req.file.filename,
    url:        isR2 ? req.file.location : null,
    storage:    isR2 ? 'r2' : 'local',
    folderId,
    size:       req.file.size,
    mimetype:   req.file.mimetype,
    uploadedAt: new Date().toISOString(),
    uploadedBy: req.user?.email || 'admin',
    allowedEmails: []
  };

  db.set(`files.${id}`, fileEntry).write();

  // Update user stats
  const uploader = req.user?.email;
  if (uploader) {
    const u = db.get(`users.${uploader}`).value() || {};
    db.set(`users.${uploader}.totalUploads`,  (u.totalUploads  || 0) + 1).write();
    db.set(`users.${uploader}.storageUsed`,   (u.storageUsed   || 0) + req.file.size).write();
  }

  logActivity('upload', req.user?.email || 'admin', fileEntry.name, `Uploaded to ${folderId ? 'folder' : 'root'}`, req.file.size);

  // Notify folder viewers in real-time
  io.to(folderId ? `folder:${folderId}` : 'folder:root').emit('file:created', fileEntry);
  if (folderId) io.to('folder:root').emit('file:created', fileEntry);

  res.json(fileEntry);
});

app.get('/api/files', requireUser, (req, res) => {
  const admin  = isAdmin(req);
  const email  = req.user.email;
  const folderId = req.query.folderId || null;
  const all    = Object.values(db.get('files').value() || {}).filter(f => f.folderId === folderId);
  const result = admin ? all : all.map(f => ({ ...f, locked: !canAccessFile(f.id, email, false) }));
  res.json(result.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)));
});

app.patch('/api/files/:id', requireAdmin, (req, res) => {
  const file = db.get(`files.${req.params.id}`).value();
  if (!file) return res.status(404).json({ error: 'Not found' });
  if (req.body.name !== undefined)     db.set(`files.${req.params.id}.name`,     req.body.name.trim()).write();
  if (req.body.folderId !== undefined) db.set(`files.${req.params.id}.folderId`, req.body.folderId).write();
  const updated = db.get(`files.${req.params.id}`).value();
  logActivity('rename', req.user?.email || 'admin', file.name, req.body.name ? `Renamed to ${req.body.name}` : 'Moved');
  io.emit('file:updated', updated);
  res.json(updated);
});

app.put('/api/files/:id/permissions', requireAdmin, (req, res) => {
  const file = db.get(`files.${req.params.id}`).value();
  if (!file) return res.status(404).json({ error: 'Not found' });
  const emails = (req.body.emails || []).map(e => e.trim().toLowerCase()).filter(e => e.includes('@'));
  db.set(`files.${req.params.id}.allowedEmails`, emails).write();
  io.emit('file:updated', { ...file, allowedEmails: emails });
  res.json({ success: true, allowedEmails: emails });
});

app.get('/download/:id', requireUser, async (req, res) => {
  const file = db.get(`files.${req.params.id}`).value();
  if (!file) return res.status(404).send('Not found');
  if (!canAccessFile(file.id, req.user.email, isAdmin(req))) return res.status(403).send('Access denied');

  // Track download
  const email = req.user.email;
  const u = db.get(`users.${email}`).value() || {};
  db.set(`users.${email}.totalDownloads`, (u.totalDownloads || 0) + 1).write();
  logActivity('download', email, file.name, 'Downloaded', file.size);

  if (USE_R2 && file.key) {
    // Redirect to signed R2 URL
    const url = await getDownloadUrl(file);
    return res.redirect(url);
  }

  // Local file
  const fp = path.join(UPLOADS_DIR, file.diskName);
  if (!fs.existsSync(fp)) return res.status(404).send('File missing');
  res.download(fp, file.name);
});

app.delete('/api/files/:id', requireAdmin, async (req, res) => {
  const file = db.get(`files.${req.params.id}`).value();
  if (!file) return res.status(404).json({ error: 'Not found' });
  db.set(`trash.${file.id}`, { ...file, type: 'file', trashedAt: new Date().toISOString(), trashedBy: req.user?.email || 'admin' }).write();
  db.unset(`files.${file.id}`).write();
  logActivity('trash', req.user?.email || 'admin', file.name, 'Moved to trash');
  io.emit('file:deleted', { id: file.id });
  res.json({ success: true });
});

// ── TRASH ─────────────────────────────────────────────────────────────────
app.get('/api/trash', requireAdmin, (req, res) => {
  res.json(Object.values(db.get('trash').value() || {}).sort((a, b) => new Date(b.trashedAt) - new Date(a.trashedAt)));
});

app.post('/api/trash/:id/restore', requireAdmin, (req, res) => {
  const item = db.get(`trash.${req.params.id}`).value();
  if (!item) return res.status(404).json({ error: 'Not in trash' });
  const { type, trashedAt, trashedBy, ...original } = item;
  if (type === 'file') db.set(`files.${item.id}`, original).write();
  else db.set(`folders.${item.id}`, original).write();
  db.unset(`trash.${item.id}`).write();
  logActivity('restore', req.user?.email || 'admin', item.name, 'Restored');
  res.json({ success: true });
});

app.delete('/api/trash/:id', requireAdmin, async (req, res) => {
  const item = db.get(`trash.${req.params.id}`).value();
  if (!item) return res.status(404).json({ error: 'Not found' });
  // Delete from R2 if needed
  if (USE_R2 && item.key && s3Client) {
    try { await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: item.key })); } catch(e) {}
  } else if (item.diskName) {
    const fp = path.join(UPLOADS_DIR, item.diskName);
    if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch(e) {}
  }
  db.unset(`trash.${item.id}`).write();
  logActivity('delete', req.user?.email || 'admin', item.name, 'Permanently deleted');
  res.json({ success: true });
});

app.delete('/api/trash', requireAdmin, async (req, res) => {
  const items = Object.values(db.get('trash').value() || {});
  for (const item of items) {
    if (USE_R2 && item.key && s3Client) {
      try { await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: item.key })); } catch(e) {}
    } else if (item.diskName) {
      const fp = path.join(UPLOADS_DIR, item.diskName);
      if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch(e) {}
    }
  }
  db.set('trash', {}).write();
  logActivity('empty_trash', req.user?.email || 'admin', 'Trash', `Emptied (${items.length} items)`);
  res.json({ success: true });
});

// ── ADMIN: USERS ──────────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  const users = Object.values(db.get('users').value() || {});
  const onlineEmails = new Set([...onlineUsers.values()].map(u => u.email));
  res.json(users.map(u => ({ ...u, online: onlineEmails.has(u.email) }))
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen)));
});

// ── ADMIN: ACTIVITY ───────────────────────────────────────────────────────
app.get('/api/activity', requireAdmin, (req, res) => {
  res.json(db.get('activity').value().slice(0, parseInt(req.query.limit) || 100));
});

// ── ADMIN: ANALYTICS ──────────────────────────────────────────────────────
app.get('/api/analytics', requireAdmin, (req, res) => {
  const files    = Object.values(db.get('files').value()   || {});
  const folders  = Object.values(db.get('folders').value() || {});
  const users    = Object.values(db.get('users').value()   || {});
  const trash    = Object.values(db.get('trash').value()   || {});
  const activity = db.get('activity').value();

  const totalStorage  = files.reduce((s, f) => s + (f.size || 0), 0);
  const downloads     = activity.filter(a => a.type === 'download').length;
  const uploads       = activity.filter(a => a.type === 'upload').length;
  const onlineCount   = onlineUsers.size;

  // Activity by day (last 7 days)
  const now = Date.now();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now - i * 86400000);
    const label = d.toLocaleDateString('en-US', { weekday: 'short' });
    const dateStr = d.toISOString().slice(0, 10);
    const dayActivity = activity.filter(a => a.when.startsWith(dateStr));
    return {
      label,
      uploads:   dayActivity.filter(a => a.type === 'upload').length,
      downloads: dayActivity.filter(a => a.type === 'download').length
    };
  }).reverse();

  // Top uploaders
  const topUploaders = users
    .sort((a, b) => (b.totalUploads || 0) - (a.totalUploads || 0))
    .slice(0, 5)
    .map(u => ({ email: u.email, name: u.name, uploads: u.totalUploads || 0, storage: u.storageUsed || 0 }));

  // File type breakdown
  const typeMap = {};
  files.forEach(f => {
    const ext = (f.name.split('.').pop() || 'other').toLowerCase();
    typeMap[ext] = (typeMap[ext] || 0) + 1;
  });
  const fileTypes = Object.entries(typeMap).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([ext, count]) => ({ ext, count }));

  res.json({
    totals: { files: files.length, folders: folders.length, users: users.length, trash: trash.length, totalStorage, downloads, uploads, onlineCount },
    days,
    topUploaders,
    fileTypes,
    storage: { used: totalStorage, provider: USE_R2 ? 'Cloudflare R2' : 'Local Disk' }
  });
});

// ── STATS (public for sidebar) ────────────────────────────────────────────
app.get('/api/stats', requireAdmin, (req, res) => {
  const files  = Object.values(db.get('files').value()  || {});
  const users  = Object.values(db.get('users').value()  || {});
  res.json({
    files: files.length,
    totalStorage: files.reduce((s, f) => s + (f.size || 0), 0),
    users: users.length,
    storageProvider: USE_R2 ? 'r2' : 'local'
  });
});

// ── SHOP ──────────────────────────────────────────────────────────────────
app.get('/api/shop', (req, res) => {
  const items = Object.values(db.get('shop').value() || {})
    .filter(i => !i.deleted)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  res.json(items);
});

app.post('/api/shop', requireAdmin, (req, res) => {
  const { name, description, price, currency, imageUrl, category, stock, active } = req.body;
  if (!name?.trim() || price === undefined) return res.status(400).json({ error: 'Name and price required' });
  const id = uuidv4();
  const item = {
    id, name: name.trim(), description: description || '',
    price: parseFloat(price), currency: currency || 'USD',
    imageUrl: imageUrl || '', category: category || 'General',
    stock: stock !== undefined ? parseInt(stock) : -1,
    active: active !== false,
    createdAt: new Date().toISOString(),
    order: Object.keys(db.get('shop').value() || {}).length
  };
  db.set(`shop.${id}`, item).write();
  res.json(item);
});

app.put('/api/shop/:id', requireAdmin, (req, res) => {
  const item = db.get(`shop.${req.params.id}`).value();
  if (!item) return res.status(404).json({ error: 'Not found' });
  const updates = {};
  ['name','description','price','currency','imageUrl','category','stock','active','order'].forEach(k => {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  });
  if (updates.price !== undefined) updates.price = parseFloat(updates.price);
  if (updates.stock !== undefined) updates.stock = parseInt(updates.stock);
  const updated = { ...item, ...updates };
  db.set(`shop.${req.params.id}`, updated).write();
  res.json(updated);
});

app.delete('/api/shop/:id', requireAdmin, (req, res) => {
  const item = db.get(`shop.${req.params.id}`).value();
  if (!item) return res.status(404).json({ error: 'Not found' });
  db.set(`shop.${req.params.id}.deleted`, true).write();
  res.json({ success: true });
});

// ── ORDERS ────────────────────────────────────────────────────────────────
app.get('/api/orders', requireAdmin, (req, res) => {
  const orders = Object.values(db.get('orders').value() || {})
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(orders);
});

app.post('/api/orders', requireUser, (req, res) => {
  const { itemId, qty = 1, paymentRef } = req.body;
  const item = db.get(`shop.${itemId}`).value();
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const id = uuidv4();
  const order = {
    id, itemId, itemName: item.name,
    qty: parseInt(qty),
    price: item.price * parseInt(qty),
    currency: item.currency,
    buyerEmail: req.user.email,
    buyerName: req.user.name,
    paymentRef: paymentRef || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  db.set(`orders.${id}`, order).write();
  logActivity('purchase', req.user.email, item.name, `Order #${id.slice(0,8)} — ${item.currency} ${order.price}`);
  res.json(order);
});

app.put('/api/orders/:id', requireAdmin, (req, res) => {
  const order = db.get(`orders.${req.params.id}`).value();
  if (!order) return res.status(404).json({ error: 'Not found' });
  const updated = { ...order, ...req.body };
  db.set(`orders.${req.params.id}`, updated).write();
  res.json(updated);
});

// ── PING (UptimeRobot) ────────────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ status: 'ok', ts: Date.now(), storage: USE_R2 ? 'r2' : 'local' }));

// ── SPA ───────────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

httpServer.listen(PORT, () => {
  console.log(`\n🔐 Private Digital Vault v4`);
  console.log(`   URL:     http://localhost:${PORT}`);
  console.log(`   Storage: ${USE_R2 ? `Cloudflare R2 (${R2_BUCKET_NAME})` : 'Local disk'}`);
  console.log(`   Admins:  ${ADMIN_EMAILS.join(', ') || '(password only)'}\n`);
});
