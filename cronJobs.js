const cron = require('node-cron');

function initCronJobs(pool) {
  // Generador de umbrales dinámicos idéntico al del Frontend
  const generateThresholds = () => {
    const thresholds = [0];
    for (let m = 15; m <= 240; m += 15) thresholds.push(m * 60 * 1000);
    for (let m = 270; m <= 480; m += 30) thresholds.push(m * 60 * 1000);
    for (let h = 12; h <= 24; h += 12) thresholds.push(h * 60 * 60 * 1000);
    for (let d = 2; d <= 7; d++) thresholds.push(d * 24 * 60 * 60 * 1000);
    return thresholds.sort((a, b) => b - a);
  };
  const DYNAMIC_THRESHOLDS = generateThresholds();

  // Guarda qué notificaciones (ID de tarea + umbral) ya se enviaron
  const notifiedTasks = new Set();

  console.log('⏰ Cron Job iniciado: Verificando tareas cada 15 segundos...');
  
  // =========================================================================
  // 1. Cron Job: Verificación de Vencimientos (Cada 15 segundos)
  // =========================================================================
  cron.schedule('*/15 * * * * *', async () => {
    try {
      const now = Date.now();
      
      const [tasks] = await pool.query('SELECT id, title, dueDate FROM tasks WHERE completed = 0 AND dueDate IS NOT NULL');
      if (tasks.length === 0) return;

      const [settings] = await pool.query('SELECT setting_key, setting_value FROM settings');
      const config = {};
      settings.forEach(s => config[s.setting_key] = s.setting_value);
      
      if (!config.botToken || !config.chatId) return;

      for (const task of tasks) {
        const dueTime = new Date(task.dueDate).getTime();
        const timeRemaining = dueTime - now;

        if (timeRemaining < -60000) continue;

        for (let threshold of DYNAMIC_THRESHOLDS) {
          if (timeRemaining <= threshold && timeRemaining > threshold - 30000) {
            const notificationId = `${task.id}-${threshold}`;
            
            if (!notifiedTasks.has(notificationId)) {
              notifiedTasks.add(notificationId);
              
              const isNow = threshold === 0;
              const minutesTotal = Math.round(threshold / 60000);
              const hours = Math.floor(minutesTotal / 60);
              const mins = minutesTotal % 60;
              
              let timeStr = '';
              if (hours > 0) timeStr += `${hours}h `;
              if (mins > 0 || hours === 0) timeStr += `${mins}m`;

              const telegramMessage = `🔔 *${isNow ? '¡Tiempo agotado!' : 'Tarea próxima'}*\nLa tarea "${task.title}" (ID: ${task.id}) ${isNow ? 'debe entregarse ahora mismo.' : `vence en ${timeStr.trim()}.`}`;

              try {
                await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: config.chatId,
                    text: telegramMessage,
                    parse_mode: 'Markdown'
                  })
                });
                console.log(`[Push Enviado a Telegram]: Tarea ID ${task.id}`);
              } catch (e) {
                console.error('Error contactando Telegram:', e.message);
              }
            }
            break; 
          }
        }
      }
    } catch (error) {
      console.error('Error en el Cron Job de Alertas:', error);
    }
  });

  // =========================================================================
  // 2. Cron Job: Sincronización Automática de Academic Manager (Cada 12 horas)
  // =========================================================================
  // Se ejecuta a las 00:00 y 12:00 todos los días ('0 0,12 * * *')
  cron.schedule('0 0,12 * * *', async () => {
    try {
      console.log('🔄 Iniciando Sincronización Automática Programada (12h)...');
      
      const [settings] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('academicUser', 'academicPass', 'botToken', 'chatId')");
      const config = {};
      settings.forEach(s => config[s.setting_key] = s.setting_value);

      if (!config.academicUser || !config.academicPass) {
        console.warn('  ⚠ No hay credenciales de Academic Manager guardadas. Sincronización abortada.');
        return;
      }

      const { scrapeAcademicManager } = require('./scraper');
      const academicTasks = await scrapeAcademicManager(config.academicUser, config.academicPass);
      
      let addedCount = 0;
      for (const task of academicTasks) {
        const [existing] = await pool.query('SELECT id FROM tasks WHERE title = ?', [task.title]);
        
        if (existing.length === 0) {
          if (task.category && task.category !== 'General') {
            await pool.query('INSERT IGNORE INTO categories (name) VALUES (?)', [task.category]);
          }

          await pool.query(
            "INSERT INTO tasks (title, description, dueDate, category) VALUES (?, ?, ?, ?)",
            [task.title, task.description, task.dueDate, task.category || 'General']
          );
          addedCount++;
        }
      }

      console.log(`✅ Sincronización automática terminada. Nuevas: ${addedCount}`);
      
      // 3. Notificar éxito por Telegram
      if (config.botToken && config.chatId) {
        const syncMessage = `🎓 *Sincronización Académica Completada*\nSe revisó el portal y se añadieron *${addedCount}* tareas nuevas a tu lista.`;
        try {
          await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: config.chatId, text: syncMessage, parse_mode: 'Markdown' })
          });
        } catch (e) { console.error('Error enviando reporte de sync:', e.message); }
      }
      
    } catch (error) {
      console.error('❌ Error en el Cron Job de Sincronización:', error);
    }
  });
}

module.exports = initCronJobs;
