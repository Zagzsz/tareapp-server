require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

// Configuración de Middlewares
app.use(cors());
app.use(express.json());

// Configuración de Multer para la subida de archivos pesados (Evidencias)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// Hacer pública la carpeta uploads para acceder a las fotos por URL HTTP
app.use('/uploads', express.static(uploadDir));

// Cola de conexión a la Base de Datos
const poolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tareas_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// Aiven y otros proveedores cloud requieren SSL
if (process.env.DB_SSL === 'true') {
  poolConfig.ssl = { rejectUnauthorized: true };
}

const pool = mysql.createPool(poolConfig);

// ==========================================
// ENDPOINTS API REST
// ==========================================

// --- HEALTH CHECK (Para cron-job.org y Render) ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// --- TAREAS ---
app.get('/api/tasks', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tasks');
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener las tareas' });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const { title, description, category, dueDate, completed } = req.body;
    const [result] = await pool.query(
      'INSERT INTO tasks (title, description, category, dueDate, completed) VALUES (?, ?, ?, ?, ?)',
      [title, description, category, dueDate || null, completed ? 1 : 0]
    );
    res.json({ id: result.insertId, title, description, category, dueDate, completed });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear la tarea' });
  }
});

app.put('/api/tasks/:id', async (req, res) => {
  try {
    const { title, description, category, dueDate, completed } = req.body;
    await pool.query(
      'UPDATE tasks SET title=?, description=?, category=?, dueDate=?, completed=? WHERE id=?',
      [title, description, category, dueDate || null, completed ? 1 : 0, req.params.id]
    );
    res.json({ message: 'Tarea actualizada' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar la tarea' });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id=?', [req.params.id]);
    res.json({ message: 'Tarea eliminada' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar la tarea' });
  }
});

// --- CATEGORÍAS ---
app.get('/api/categories', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT name FROM categories');
    res.json(rows.map(r => r.name));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener categorías' });
  }
});

app.post('/api/categories', async (req, res) => {
  try {
    const { name } = req.body;
    await pool.query('INSERT IGNORE INTO categories (name) VALUES (?)', [name]);
    res.json({ message: 'Categoría guardada' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear categoría' });
  }
});

app.delete('/api/categories/:name', async (req, res) => {
  try {
    await pool.query('DELETE FROM categories WHERE name=?', [req.params.name]);
    // Mover tareas huérfanas a General
    await pool.query('UPDATE tasks SET category="General" WHERE category=?', [req.params.name]);
    res.json({ message: 'Categoría eliminada' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar categoría' });
  }
});

// --- ARCHIVOS ADJUNTOS ---
app.get('/api/tasks/:taskId/attachments', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, file_path, file_type FROM attachments WHERE task_id=?', [req.params.taskId]);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener archivos' });
  }
});

app.post('/api/tasks/:taskId/attachments', upload.single('evidence'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    // Guardar solo la referencia HTTP relativa en BD
    const filePath = `/uploads/${req.file.filename}`;
    const [result] = await pool.query(
      'INSERT INTO attachments (task_id, name, file_path, file_type) VALUES (?, ?, ?, ?)',
      [req.params.taskId, req.file.originalname, filePath, req.file.mimetype]
    );
    res.json({ id: result.insertId, name: req.file.originalname, file_path: filePath, file_type: req.file.mimetype });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al guardar el archivo' });
  }
});

app.delete('/api/attachments/:id', async (req, res) => {
  try {
    // Buscar la ruta real para borrarlo del disco duro
    const [rows] = await pool.query('SELECT file_path FROM attachments WHERE id=?', [req.params.id]);
    if (rows.length > 0) {
      const dbPath = rows[0].file_path; // ej: /uploads/123-foto.jpg
      const realPath = path.join(__dirname, dbPath);
      if (fs.existsSync(realPath)) {
        fs.unlinkSync(realPath);
      }
      await pool.query('DELETE FROM attachments WHERE id=?', [req.params.id]);
    }
    res.json({ message: 'Archivo eliminado de DB y Disco' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar el archivo' });
  }
});

// --- SETTINGS (TELEGRAM) ---
app.get('/api/settings', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM settings');
    const settings = {};
    rows.forEach(r => settings[r.setting_key] = r.setting_value);
    res.json(settings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener configuraciones' });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { botToken, chatId } = req.body;
    await pool.query('REPLACE INTO settings (setting_key, setting_value) VALUES ("botToken", ?)', [botToken]);
    await pool.query('REPLACE INTO settings (setting_key, setting_value) VALUES ("chatId", ?)', [chatId]);
    res.json({ message: 'Configuraciones actualizadas' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al guardar configuraciones' });
  }
});

// --- ENDPOINT: Verificar notificaciones bajo demanda (Para cron-job.org) ---
app.get('/api/check-notifications', async (req, res) => {
  try {
    const now = Date.now();
    const [tasks] = await pool.query('SELECT id, title, dueDate FROM tasks WHERE completed = 0 AND dueDate IS NOT NULL');
    const [settings] = await pool.query('SELECT setting_key, setting_value FROM settings');
    const config = {};
    settings.forEach(s => config[s.setting_key] = s.setting_value);

    if (!config.botToken || !config.chatId || tasks.length === 0) {
      return res.json({ checked: 0, sent: 0, message: 'Sin tareas pendientes o sin Telegram configurado' });
    }

    // Definir umbrales dinámicos
    const thresholds = [0];
    for (let m = 15; m <= 240; m += 15) thresholds.push(m * 60 * 1000);
    for (let m = 270; m <= 480; m += 30) thresholds.push(m * 60 * 1000);
    thresholds.sort((a, b) => b - a);

    let sent = 0;
    for (const task of tasks) {
      const dueTime = new Date(task.dueDate).getTime();
      const timeRemaining = dueTime - now;
      if (timeRemaining < -60000) continue;

      for (let threshold of thresholds) {
        if (timeRemaining <= threshold && timeRemaining > threshold - 120000) {
          const isNow = threshold === 0;
          const minutesTotal = Math.round(threshold / 60000);
          const hours = Math.floor(minutesTotal / 60);
          const mins = minutesTotal % 60;
          let timeStr = '';
          if (hours > 0) timeStr += `${hours}h `;
          if (mins > 0 || hours === 0) timeStr += `${mins}m`;

          const text = `🔔 *${isNow ? '¡Tiempo agotado!' : 'Tarea próxima'}*\nLa tarea "${task.title}" ${isNow ? 'debe entregarse ahora mismo.' : `vence en ${timeStr.trim()}.`}`;
          try {
            await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: config.chatId, text, parse_mode: 'Markdown' })
            });
            sent++;
          } catch (e) { console.error('Telegram error:', e.message); }
          break;
        }
      }
    }
    res.json({ checked: tasks.length, sent, message: `Se revisaron ${tasks.length} tareas, se enviaron ${sent} alertas.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error verificando notificaciones' });
  }
});

// Inicio del Servidor
app.listen(PORT, () => {
  console.log(`🚀 Integración Cloud Server corriendo en el puerto ${PORT}`);
  
  // Inicializamos el Cron Job interno tambien (para cuando corre localmente)
  require('./cronJobs')(pool);
});
