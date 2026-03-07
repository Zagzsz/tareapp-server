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
  
  // Se ejecuta cada 15 segundos ('*/15 * * * * *')
  cron.schedule('*/15 * * * * *', async () => {
    try {
      const now = Date.now();
      
      // 1. Obtener todas las tareas pendientes con fecha
      const [tasks] = await pool.query('SELECT id, title, dueDate FROM tasks WHERE completed = 0 AND dueDate IS NOT NULL');
      if (tasks.length === 0) return;

      // 2. Obtener Token y Chat de Telegram desde BD
      const [settings] = await pool.query('SELECT setting_key, setting_value FROM settings');
      const config = {};
      settings.forEach(s => config[s.setting_key] = s.setting_value);
      
      if (!config.botToken || !config.chatId) return; // Si no hay Telegram configurado, no hace nada

      // 3. Evaluar Vencimientos
      for (const task of tasks) {
        const dueTime = new Date(task.dueDate).getTime();
        const timeRemaining = dueTime - now;

        if (timeRemaining < -60000) continue; // Pasó hace mucho, ignorar

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

              const telegramMessage = `🔔 *${isNow ? '¡Tiempo agotado!' : 'Tarea próxima'}*\nLa tarea "${task.title}" ${isNow ? 'debe entregarse ahora mismo.' : `vence en ${timeStr.trim()}.`}`;

              // 4. Enviar a Telegram Servidor-A-Telegram directamente
              try {
                // Node 18+ soporta fetch nativo
                await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: config.chatId,
                    text: telegramMessage,
                    parse_mode: 'Markdown'
                  })
                });
                console.log(`[Push Enviado a Telegram]: Tarea ID ${task.id} (${timeRemaining}ms restantes)`);
              } catch (e) {
                console.error('Error contactando Telegram desde NodeJS:', e.message);
              }
            }
            break; 
          }
        }
      }
    } catch (error) {
      console.error('Error en el Cron Job:', error);
    }
  });
}

module.exports = initCronJobs;
