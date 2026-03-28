const cron = require('node-cron');
const { syncTaskToNotion } = require('./notionSync');

function initCronJobs(pool) {
  // Generador de umbrales dinámicos idéntico al del Frontend
  const generateThresholds = () => {
    return [
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
    ].sort((a, b) => b - a);
  };
  const DYNAMIC_THRESHOLDS = generateThresholds();

  console.log('⏰ Cron Jobs Activos: Alertas (15s) y Sync Academic (12h).');
  
  // =========================================================================
  // 1. Cron Job: Verificación de Vencimientos (Cada 15 segundos)
  // =========================================================================
  cron.schedule('*/15 * * * * *', async () => {
    try {
      const now = Date.now();
      
      const [tasks] = await pool.query('SELECT id, title, dueDate FROM tasks WHERE completed = 0 AND dueDate IS NOT NULL');
      if (tasks.length === 0) return;

      const [settings] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('botToken', 'chatId', 'discordWebhookUrl', 'discordRoleId')");
      const config = {};
      settings.forEach(s => config[s.setting_key] = s.setting_value);
      
      if (!config.botToken && !config.chatId && !config.discordWebhookUrl) return;

      for (const task of tasks) {
        const dueTime = new Date(task.dueDate).getTime();
        const timeRemaining = dueTime - now;

        if (timeRemaining < -60000) continue;

        for (let threshold of DYNAMIC_THRESHOLDS) {
          if (timeRemaining <= threshold && timeRemaining > threshold - 30000) {
            
            // VERIFICACIÓN DE PERSISTENCIA (v22): ¿Ya se envió esta alerta?
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

              const telegramMessage = `🔔 *${isNow ? '¡Tiempo agotado!' : 'Tarea próxima'}*\nLa tarea "${task.title}" (ID: ${task.id}) ${isNow ? 'debe entregarse ahora mismo.' : `vence en ${timeStr.trim()}.`}`;

              try {
                if (config.botToken && config.chatId) {
                  await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: config.chatId, text: telegramMessage, parse_mode: 'Markdown' })
                  });
                }

                if (config.discordWebhookUrl) {
                  const discordText = telegramMessage.replace(/\*/g, '**');
                  const body = { content: discordText };
                  if (config.discordRoleId) {
                    body.content = `<@&${config.discordRoleId}> ${discordText}`;
                  }
                  await fetch(config.discordWebhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                  });
                }

                // REGISTRAR ENVÍO (v22)
                await pool.query(
                    'INSERT IGNORE INTO sent_notifications (task_id, threshold) VALUES (?, ?)',
                    [task.id, threshold]
                );
                console.log(`[Persistente]: Alerta Tarea ${task.id} (Umbral ${threshold}ms) guardada en BD.`);

              } catch (e) {
                console.error('Error enviando a Telegram:', e.message);
              }
            }
            break; 
          }
        }
      }
    } catch (error) {
      console.error('Error en Cron Alertas:', error);
    }
  });

  // =========================================================================
  // 2. Cron Job: Sincronización Automática de Academic Manager (Cada 12 horas - 6am y 6pm)
  // =========================================================================
  cron.schedule('0 6,18 * * *', async () => {
    try {
      console.log('🔄 Iniciando Sincronización Automática Programada (12h)...');
      
      const [settings] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('academicUser', 'academicPass', 'botToken', 'chatId', 'discordWebhookUrl', 'discordRoleId')");
      const config = {};
      settings.forEach(s => config[s.setting_key] = s.setting_value);

      if (!config.academicUser || !config.academicPass) return;

      const { scrapeAcademicManager } = require('./scraper');
      const academicTasks = await scrapeAcademicManager(config.academicUser, config.academicPass);
      
      let addedCount = 0;
      let notionSynced = 0;
      for (const task of academicTasks) {
        const [existing] = await pool.query('SELECT id FROM tasks WHERE title = ?', [task.title]);
        const mysqlDate = task.dueDate;
        let taskId = null;
        if (existing.length === 0) {
          if (task.category && task.category !== 'General') await pool.query('INSERT IGNORE INTO categories (name) VALUES (?)', [task.category]);
          const [insertRes] = await pool.query("INSERT INTO tasks (title, description, dueDate, category) VALUES (?, ?, ?, ?)", [task.title, task.description, mysqlDate, task.category || 'General']);
          taskId = insertRes.insertId;
          addedCount++;
        } else {
          taskId = existing[0].id;
          const [updateRes] = await pool.query("UPDATE tasks SET dueDate = ? WHERE id = ?", [mysqlDate, existing[0].id]);
          if (updateRes.changedRows > 0) await pool.query("DELETE FROM sent_notifications WHERE task_id = ?", [existing[0].id]);
        }

        if (taskId) {
          const [taskRows] = await pool.query('SELECT id, title, description, category, dueDate, completed FROM tasks WHERE id = ?', [taskId]);
          if (taskRows.length > 0) {
            const notionResult = await syncTaskToNotion(pool, taskRows[0], { upsert: true });
            if (notionResult.synced) notionSynced++;
          }
        }
      }

      console.log(`✅ Sincronización automática terminada. Nuevas: ${addedCount}, Notion: ${notionSynced}`);
      
      if (config.botToken && config.chatId) {
        const syncMessage = `🎓 *Sincronización Automática Finalizada*\nSe revisó tu portal y se añadieron *${addedCount}* tareas nuevas.\n🧠 Notion sincronizadas: *${notionSynced}*.`;
        await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: config.chatId, text: syncMessage, parse_mode: 'Markdown' })
        });
      }

      if (config.discordWebhookUrl) {
        const syncMessageDiscord = `🎓 **Sincronización Automática Finalizada**\nSe revisó tu portal y se añadieron **${addedCount}** tareas nuevas.\n🧠 Notion sincronizadas: **${notionSynced}**.`;
        const body = { content: syncMessageDiscord };
        if (config.discordRoleId) {
          body.content = `<@&${config.discordRoleId}> ${syncMessageDiscord}`;
        }
        await fetch(config.discordWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      }
    } catch (error) {
      console.error('Error en Cron Sync:', error);
    }
  });
}

module.exports = initCronJobs;
