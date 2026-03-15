require('dotenv').config();
process.env.TZ = 'America/Mexico_City';
console.log('--- SERVER BOOTSTRAP STARTING ---');
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { scrapeAcademicManager } = require('./scraper');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

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

// Inicialización de Tablas (Persistencia)
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sent_notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task_id INT,
        threshold BIGINT,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY task_thresh (task_id, threshold)
      )
    `);
    console.log('✅ Tabla sent_notifications lista.');
  } catch (err) {
    console.error('Error inicializando DB:', err);
  }
};
initDb();

// --- SISTEMA DE COMANDOS TELEGRAM (LONG POLLING) ---
let lastUpdateId = 0;
const startTelegramPolling = async () => {
    // Solo iniciar si hay configuración
    const [settings] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('botToken', 'chatId', 'academicUser', 'academicPass')");
    const config = {};
    settings.forEach(s => config[s.setting_key] = s.setting_value);

    if (!config.botToken || !config.chatId) {
        setTimeout(startTelegramPolling, 30000); // Reintentar en 30s
        return;
    }

    try {
        const response = await fetch(`https://api.telegram.org/bot${config.botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`);
        const data = await response.json();

        if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
                lastUpdateId = update.update_id;
                if (!update.message || !update.message.text) continue;

                const text = update.message.text.toLowerCase();
                const chatId = update.message.chat.id.toString();

                // Seguridad: Solo responder al dueño (chatId configurado)
                if (chatId !== config.chatId) continue;

                if (text === '/start' || text === '/help') {
                    const welcome = "👋 *¡Hola! Soy tu asistente de TareApp*\n\nComandos disponibles:\n/tareas - Ver lista de pendientes\n/sync - Sincronizar Academic ahora\n/completar [ID] - Marcar tarea como lista";
                    await sendTelegram(config.botToken, chatId, welcome);
                } 
                else if (text === '/tareas') {
                    const [tasks] = await pool.query('SELECT id, title, category FROM tasks WHERE completed = 0 ORDER BY dueDate ASC');
                    if (tasks.length === 0) {
                        await sendTelegram(config.botToken, chatId, "✅ No tienes tareas pendientes.");
                    } else {
                        const list = tasks.map(t => `• *${t.title}* (ID: ${t.id}) [${t.category || 'General'}]`).join('\n');
                        await sendTelegram(config.botToken, chatId, `📋 *Tareas Pendientes:*\n\n${list}`);
                    }
                }
                else if (text === '/sync') {
                    await sendTelegram(config.botToken, chatId, "⏳ Iniciando sincronización... te avisaré al terminar.");
                    if (!config.academicUser || !config.academicPass) {
                        await sendTelegram(config.botToken, chatId, "❌ No tienes credenciales guardadas. Hazlo en la app primero.");
                    } else {
                        try {
                            const academicTasks = await scrapeAcademicManager(config.academicUser, config.academicPass);
                            let added = 0;
                            for (const task of academicTasks) {
                                const [existing] = await pool.query('SELECT id FROM tasks WHERE title = ?', [task.title]);
                                if (existing.length === 0) {
                                    // Normalizar fecha para MySQL (YYYY-MM-DD HH:MM:SS)
                                    const mysqlDate = new Date(task.dueDate).toISOString().slice(0, 19).replace('T', ' ');
                                    
                                    if (task.category && task.category !== 'General') await pool.query('INSERT IGNORE INTO categories (name) VALUES (?)', [task.category]);
                                    await pool.query("INSERT INTO tasks (title, description, dueDate, category) VALUES (?, ?, ?, ?)", [task.title, task.description, mysqlDate, task.category || 'General']);
                                    added++;
                                }
                            }
                            await sendTelegram(config.botToken, chatId, `✅ Sync lista. Halladas: ${academicTasks.length}, Nuevas: ${added}`);
                        } catch (e) {
                            await sendTelegram(config.botToken, chatId, `❌ Error en sync: ${e.message}`);
                        }
                    }
                }
                else if (text.startsWith('/completar ')) {
                    const taskId = text.split(' ')[1];
                    if (!taskId || isNaN(taskId)) {
                        await sendTelegram(config.botToken, chatId, "❌ Formato: `/completar [ID]`");
                    } else {
                        const [res] = await pool.query('UPDATE tasks SET completed = 1 WHERE id = ?', [taskId]);
                        if (res.affectedRows > 0) {
                            await sendTelegram(config.botToken, chatId, `✅ Tarea ID ${taskId} marcada como completada.`);
                        } else {
                            await sendTelegram(config.botToken, chatId, `❌ No encontré la tarea con ID ${taskId}.`);
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error Polling Telegram:', err.message);
    }
    
    setTimeout(startTelegramPolling, 1000); // Siguiente ciclo
};

// --- CLIENTE DISCORD BOT ---
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
    ]
});

discordClient.on('ready', () => {
    console.log(`✅ Discord Bot conectado como: ${discordClient.user.tag}`);
});

discordClient.on('messageCreate', async (message) => {
    console.log(`💬 Mensaje recibido en Discord: "${message.content}" de ${message.author.tag}`);
    if (message.author.bot) return;

    const text = message.content.toLowerCase().trim();
    
    if (text === '!tareas' || text === '/tareas') {
        console.log('📝 Procesando comando !tareas...');
        try {
            const [tasks] = await pool.query('SELECT title, dueDate FROM tasks WHERE completed = 0 AND dueDate IS NOT NULL ORDER BY dueDate ASC');
            
            if (tasks.length === 0) {
                return message.reply('🎉 No hay tareas pendientes. ¡Buen trabajo!');
            }

            const embed = new EmbedBuilder()
                .setTitle('📋 Tareas Pendientes')
                .setColor(0x0099FF)
                .setTimestamp();

            const taskList = tasks.map((t, i) => {
                const due = new Date(t.dueDate);
                const diff = due - Date.now();
                const days = Math.floor(diff / (1000 * 60 * 60 * 24));
                const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                
                let timeStr = '';
                if (days > 0) timeStr += `${days}d `;
                if (hours > 0) timeStr += `${hours}h `;
                if (mins > 0 || (days === 0 && hours === 0)) timeStr += `${mins}m`;

                return `**${i + 1}. ${t.title}**\n📅 Vence: ${due.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}\n⏳ Falta: \`${timeStr}\``;
            }).join('\n\n');

            embed.setDescription(taskList);
            message.reply({ embeds: [embed] });
        } catch (err) {
            console.error('Error comando Discord:', err);
            message.reply('❌ Error al obtener las tareas.');
        }
    }
    else if (text === '!sync' || text === '/sync') {
        console.log('🔄 Procesando comando !sync desde Discord...');
        try {
            // Obtener credenciales desde la base de datos
            const [settings] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('academicUser', 'academicPass')");
            const config = {};
            settings.forEach(s => config[s.setting_key] = s.setting_value);

            if (!config.academicUser || !config.academicPass) {
                return message.reply("❌ No tienes credenciales configuradas en la app.");
            }

            message.reply("⏳ Iniciando sincronización... te avisaré al terminar.");

            const academicTasks = await scrapeAcademicManager(config.academicUser, config.academicPass);
            let added = 0;
            for (const task of academicTasks) {
                const [existing] = await pool.query('SELECT id FROM tasks WHERE title = ?', [task.title]);
                if (existing.length === 0) {
                    const mysqlDate = new Date(task.dueDate).toISOString().slice(0, 19).replace('T', ' ');
                    if (task.category && task.category !== 'General') await pool.query('INSERT IGNORE INTO categories (name) VALUES (?)', [task.category]);
                    await pool.query("INSERT INTO tasks (title, description, dueDate, category) VALUES (?, ?, ?, ?)", [task.title, task.description, mysqlDate, task.category || 'General']);
                    added++;
                }
            }
            message.reply(`✅ Sincronización finalizada.\n📦 Tareas encontradas: **${academicTasks.length}**\n✨ Tareas nuevas: **${added}**`);
        } catch (err) {
            console.error('Error sync Discord:', err);
            message.reply(`❌ Error al sincronizar: ${err.message}`);
        }
    }
});

const startDiscordBot = async () => {
    try {
        const [settings] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'discordBotToken'");
        if (settings.length > 0 && settings[0].setting_value) {
            console.log('🤖 Intentando conectar Discord Bot...');
            await discordClient.login(settings[0].setting_value);
        } else {
            console.log('ℹ️ No se encontró Discord Bot Token, bot desactivado.');
        }
    } catch (err) {
        console.error('❌ Error fatal al iniciar Discord Bot:', err.message);
    }
};

async function sendTelegram(token, chatId, text) {
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
        });
    } catch (e) { console.error('Error en sendTelegram:', e.message); }
}

async function sendDiscord(webhookUrl, content, roleId = null) {
    try {
        if (!webhookUrl) return;
        const body = { content };
        if (roleId) {
            body.content = `<@&${roleId}> ${content}`;
        }
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (e) { console.error('Error en sendDiscord:', e.message); }
}

// Iniciar Bots al arrancar
startTelegramPolling();
startDiscordBot();

// --- ENDPOINTS API REST ---

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
    const { botToken, chatId, academicUser, academicPass, discordWebhookUrl, discordRoleId, discordBotToken } = req.body;
    if (botToken) await pool.query("REPLACE INTO settings (setting_key, setting_value) VALUES ('botToken', ?)", [botToken]);
    if (chatId) await pool.query("REPLACE INTO settings (setting_key, setting_value) VALUES ('chatId', ?)", [chatId]);
    if (academicUser) await pool.query("REPLACE INTO settings (setting_key, setting_value) VALUES ('academicUser', ?)", [academicUser]);
    if (academicPass) await pool.query("REPLACE INTO settings (setting_key, setting_value) VALUES ('academicPass', ?)", [academicPass]);
    if (discordWebhookUrl !== undefined) await pool.query("REPLACE INTO settings (setting_key, setting_value) VALUES ('discordWebhookUrl', ?)", [discordWebhookUrl]);
    if (discordRoleId !== undefined) await pool.query("REPLACE INTO settings (setting_key, setting_value) VALUES ('discordRoleId', ?)", [discordRoleId]);
    if (discordBotToken !== undefined) {
      await pool.query("REPLACE INTO settings (setting_key, setting_value) VALUES ('discordBotToken', ?)", [discordBotToken]);
      // Reiniciar bot si el token cambió o es nuevo
      try {
          if (discordClient.isReady()) {
              await discordClient.destroy();
          }
          await discordClient.login(discordBotToken);
      } catch (err) {
          console.error('Error reiniciando Discord Bot:', err.message);
      }
    }
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

    if ((!config.botToken || !config.chatId) && !config.discordWebhookUrl) {
      return res.json({ checked: 0, sent: 0, message: 'Falta configuración de notificaciones (Telegram o Discord)' });
    }
    if (tasks.length === 0) {
      return res.json({ checked: 0, sent: 0, message: 'Sin tareas pendientes' });
    }

    // Umbrales dinámicos refinados (Hitos específicos para evitar spam)
    const thresholds = [
      0,                          // Al momento
      15 * 60 * 1000,             // 15m
      30 * 60 * 1000,             // 30m
      60 * 60 * 1000,             // 1h
      3 * 60 * 60 * 1000,         // 3h
      6 * 60 * 60 * 1000,         // 6h
      12 * 60 * 60 * 1000,        // 12h
      24 * 60 * 60 * 1000,        // 24h (1 día)
      3 * 24 * 60 * 60 * 1000,    // 3 días
      7 * 24 * 60 * 60 * 1000     // 7 días
    ];
    thresholds.sort((a, b) => b - a);

    let sent = 0;
    for (const task of tasks) {
      const dueTime = new Date(task.dueDate).getTime();
      const timeRemaining = dueTime - now;
      if (timeRemaining < -60000) continue;

      for (let threshold of thresholds) {
        // Ventana de 30 segundos (igual que cronJobs.js)
        if (timeRemaining <= threshold && timeRemaining > threshold - 30000) {
          // VERIFICAR SI YA SE ENVIÓ (persistencia)
          const [alreadySent] = await pool.query(
            'SELECT id FROM sent_notifications WHERE task_id = ? AND threshold = ?',
            [task.id, threshold]
          );

          if (alreadySent.length === 0) {
            const isNow = threshold === 0;
            const minutesTotal = Math.round(threshold / 60000);
            const hours = Math.floor(minutesTotal / 60);
            const mins = minutesTotal % 60;
            let timeStr = '';
            if (hours > 0) timeStr += `${hours}h `;
            if (mins > 0 || hours === 0) timeStr += `${mins}m`;

            const text = `🔔 *${isNow ? '¡Tiempo agotado!' : 'Tarea próxima'}*\nLa tarea "${task.title}" (ID: ${task.id}) ${isNow ? 'debe entregarse ahora mismo.' : `vence en ${timeStr.trim()}.`}`;
            try {
              if (config.botToken && config.chatId) {
                await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: config.chatId, text, parse_mode: 'Markdown' })
                });
              }

              if (config.discordWebhookUrl) {
                // Limpiar markdown de Telegram para Discord (opcional, pero Discord usa markdown similar)
                const discordText = text.replace(/\*/g, '**'); 
                await sendDiscord(config.discordWebhookUrl, discordText, config.discordRoleId);
              }

              // REGISTRAR ENVÍO EN BD
              await pool.query(
                'INSERT IGNORE INTO sent_notifications (task_id, threshold) VALUES (?, ?)',
                [task.id, threshold]
              );
              sent++;
            } catch (e) { console.error('Notification error:', e.message); }
          }
          break;
        }
      }
    }

    res.json({ checked: tasks.length, sent, message: `Se revisaron ${tasks.length} tareas, se enviaron ${sent} alertas nuevas.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error verificando notificaciones' });
  }
});

// --- ENDPOINT: Sincronizar con Academic Manager ---
app.post('/api/sync-academic', async (req, res) => {
  const { academicUser, academicPass } = req.body;

  if (!academicUser || !academicPass) {
    return res.status(400).json({ error: 'Faltan credenciales de Academic' });
  }

  try {
    console.log('Iniciando sincronización con Academic Manager...');
    
    // Auto-Guardar credenciales en la base de datos (settings) 
    // para que el Cron Job de 12h las tenga disponibles automáticamente.
    await pool.query("REPLACE INTO settings (setting_key, setting_value) VALUES ('academicUser', ?)", [academicUser]);
    await pool.query("REPLACE INTO settings (setting_key, setting_value) VALUES ('academicPass', ?)", [academicPass]);

    const academicTasks = await scrapeAcademicManager(academicUser, academicPass);
    
    let addedCount = 0;
    for (const task of academicTasks) {
      // Verificar si ya existe una tarea con el mismo título para evitar duplicados
      const [existing] = await pool.query('SELECT id FROM tasks WHERE title = ?', [task.title]);
      
        if (existing.length === 0) {
          // Normalizar fecha para MySQL (YYYY-MM-DD HH:MM:SS)
          const mysqlDate = new Date(task.dueDate).toISOString().slice(0, 19).replace('T', ' ');

          // Asegurar que la categoría exista en la tabla categories
          if (task.category && task.category !== 'General') {
            await pool.query('INSERT IGNORE INTO categories (name) VALUES (?)', [task.category]);
          }

          await pool.query(
            "INSERT INTO tasks (title, description, dueDate, category) VALUES (?, ?, ?, ?)",
            [task.title, task.description, mysqlDate, task.category || 'General']
          );
          addedCount++;
        }
    }

    res.json({ 
      message: 'Sincronización completada', 
      found: academicTasks.length,
      added: addedCount 
    });

  } catch (error) {
    console.error('Error en sincronización:', error);
    res.status(500).json({ 
      error: 'Error al conectar con la plataforma universitaria',
      details: error.message 
    });
  }
});

// Inicio del Servidor
app.listen(PORT, () => {
  console.log('================================================================');
  console.log(`🚀 TAREAPP SERVER v23 - ONLINE EN PUERTO ${PORT}`);
  console.log(`📅 FECHA: ${new Date().toLocaleString()}`);
  console.log(`🔗 API: ${Number(PORT) === 3001 ? 'http://localhost:3001' : 'Producción'}`);
  console.log('================================================================');
  
  // Inicializamos el Cron Job interno
  require('./cronJobs')(pool);
});
