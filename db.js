const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'lobane.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super','admin')),
  shop_name TEXT NOT NULL,
  phone TEXT,
  whatsapp TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS motos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  brand TEXT,
  type TEXT NOT NULL,
  price INTEGER NOT NULL,
  description TEXT,
  image TEXT,
  status TEXT NOT NULL DEFAULT 'disponible' CHECK (status IN ('disponible','vendu')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  moto_id INTEGER REFERENCES motos(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  subject TEXT,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_motos_user ON motos(user_id);
CREATE INDEX IF NOT EXISTS idx_motos_type ON motos(type);
CREATE INDEX IF NOT EXISTS idx_motos_status ON motos(status);
CREATE INDEX IF NOT EXISTS idx_inq_shop ON inquiries(shop_id, id);
`);

// ---- migrations (idempotentes : s'appliquent aussi à une base existante) ----
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
const addCol = (t, c, def) => { if (!hasCol(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('motos', 'year', 'INTEGER');
addCol('motos', 'mileage', 'INTEGER');
addCol('motos', 'color', 'TEXT');
addCol('motos', 'etat', "TEXT NOT NULL DEFAULT 'neuf'");
addCol('motos', 'negotiable', 'INTEGER NOT NULL DEFAULT 0');
addCol('motos', 'featured', 'INTEGER NOT NULL DEFAULT 0');
addCol('users', 'logo', 'TEXT');
addCol('inquiries', 'handled', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS moto_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  moto_id INTEGER NOT NULL REFERENCES motos(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mi_moto ON moto_images(moto_id, position);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  moto_id INTEGER REFERENCES motos(id) ON DELETE SET NULL,
  moto_title TEXT NOT NULL,
  price INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  place TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'nouvelle' CHECK (status IN ('nouvelle','confirmee','livree','annulee')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id, status, id);
`);
// Les photos « couverture » existantes (motos.image) entrent dans la galerie.
function syncImages() {
  db.exec(`INSERT INTO moto_images (moto_id, filename, position)
    SELECT id, image, 0 FROM motos WHERE image IS NOT NULL AND NOT EXISTS (SELECT 1 FROM moto_images WHERE moto_id = motos.id)`);
}
syncImages();

// Sauvegarde cohérente de la base (VACUUM INTO) : une copie par jour, on garde les 7 dernières.
function backup(keep = 7) {
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `lobane-${new Date().toISOString().slice(0, 10)}.db`);
  fs.rmSync(f, { force: true });
  db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
  fs.readdirSync(dir).filter((n) => /^lobane-\d{4}-\d{2}-\d{2}\.db$/.test(n)).sort().slice(0, -keep)
    .forEach((n) => fs.rmSync(path.join(dir, n), { force: true }));
  return f;
}

// Le stockage est-il durable ? Faux si DATA_DIR est sur le même disque que le système (disque Render absent).
function storageIsPersistent() {
  try { return fs.statSync(DATA_DIR).dev !== fs.statSync('/').dev; } catch { return true; }
}

const TYPES = ['Moto de ville', 'Tout-terrain', 'Sport / grosse cylindrée', 'Travail / livraison', 'Scooter', 'Pièces & pneus'];

function seed() {
  const hasSuper = db.prepare("SELECT 1 FROM users WHERE role='super'").get();
  if (hasSuper) return null;

  const email = (process.env.SUPER_EMAIL || 'superadmin@lobane.ci').toLowerCase();
  const PROD = process.env.NODE_ENV === 'production';
  const generated = !process.env.SUPER_PASSWORD && PROD;
  const password = process.env.SUPER_PASSWORD || (PROD ? crypto.randomBytes(9).toString('base64url') : 'Lobane@2026');
  const ins = db.prepare('INSERT INTO users (email,password_hash,role,shop_name,phone,whatsapp) VALUES (?,?,?,?,?,?)');
  ins.run(email, bcrypt.hashSync(password, 10), 'super', 'Lobane Motorcycle', '+2250505137178', '2250505137178');

  if (!process.env.NO_DEMO) {
    const shop = ins.run('boutique1@lobane.ci', bcrypt.hashSync('Boutique@2026', 10), 'admin', 'Lobane Koumassi', '+2250505137178', '2250505137178');
    const shop2 = ins.run('boutique2@lobane.ci', bcrypt.hashSync('Boutique@2026', 10), 'admin', 'Moto Plus Abidjan', '+2250777673369', '2250777673369');
    const demoImg = 'demo-honda-winner-r-2026.jpg';
    try {
      fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'public', 'img', 'demo', 'honda-winner-r-2026.jpg'), path.join(DATA_DIR, 'uploads', demoImg));
    } catch (e) { /* photo de démonstration facultative */ }
    const m = db.prepare('INSERT INTO motos (user_id,title,brand,type,price,description,image) VALUES (?,?,?,?,?,?,?)');
    m.run(shop.lastInsertRowid, 'Honda Winner R 2026', 'Honda', 'Sport / grosse cylindrée', 1650000, 'Modèle 2026, ligne sportive, moteur nerveux. Prix de démonstration.', demoImg);
    m.run(shop.lastInsertRowid, 'Moto de ville 125cc', 'Haojue', 'Moto de ville', 520000, 'Économique et fiable, idéale pour les déplacements quotidiens à Abidjan.', null);
    m.run(shop.lastInsertRowid, 'Tout-terrain 200cc', 'Sanya', 'Tout-terrain', 780000, 'Robuste, suspensions renforcées pour toutes les routes.', null);
    m.run(shop.lastInsertRowid, 'Scooter 110cc', 'Jincheng', 'Scooter', 450000, 'Confortable et simple à conduire.', null);
    m.run(shop2.lastInsertRowid, 'Moto de livraison 150cc', 'Apsonic', 'Travail / livraison', 610000, 'Porte-bagages renforcé, faible consommation.', null);
    m.run(shop2.lastInsertRowid, 'Sport 250cc', 'Zongshen', 'Sport / grosse cylindrée', 1450000, 'Puissance et style pour les amateurs de sensations.', null);
  }
  return { email, password, generated };
}

module.exports = { db, seed, TYPES, DATA_DIR, backup, storageIsPersistent, syncImages };
