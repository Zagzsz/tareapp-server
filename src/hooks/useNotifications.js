import { useState, useEffect, useRef } from 'react';
import { API_URL } from '../config';

// Generador de umbrales dinámicos (en milisegundos)
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

export function useNotifications(tasks) {
  const [permission, setPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  );
  const notifiedTasksRef = useRef(new Set());

  const requestPermission = async () => {
    if (!('Notification' in window)) {
      alert('Tu navegador no soporta notificaciones de escritorio.');
      return false;
    }

    try {
      if (Notification.permission === 'granted') {
        setPermission('granted');
        return true;
      }

      if (Notification.permission !== 'denied') {
        const result = await Notification.requestPermission();
        setPermission(result);
        
        if (result === 'granted') {
          return true;
        } else {
          alert('Permiso de notificaciones denegado o ignorado. Para recibirlas, debes habilitarlas en los ajustes de tu navegador (icono de candado en la barra de URL).');
          return false;
        }
      } else {
        alert('Las notificaciones están bloqueadas en este sitio. Por favor, haz clic en el icono del candado junto a la URL (localhost) y permite las notificaciones manualmente.');
        return false;
      }
    } catch (error) {
      console.error('Error al solicitar permisos:', error);
      alert('Hubo un error al pedir permisos al navegador.');
      return false;
    }
  };

  // Función para probar notificaciones manualmente sin depender del timer
  const testNotification = async () => {
    // Probar Telegram / Discord Si existe config
    try {
      const savedConfig = localStorage.getItem('app_tareas_telegram_config');
      if (savedConfig) {
        const { botToken, chatId, discordWebhookUrl, discordRoleId } = JSON.parse(savedConfig);
        
        // 1. Probar Telegram
        if (botToken && chatId) {
          fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: "🧪 *Prueba de Notificación Telegram*\nSi ves esto, tu bot está bien configurado.",
              parse_mode: 'Markdown'
            })
          }).catch(err => console.error('Error probando Telegram:', err));
        }

        // 2. Probar Discord
        if (discordWebhookUrl) {
          const content = "🧪 **Prueba de Notificación Discord**\nSi ves esto, tu webhook está bien configurado.";
          const body = { content };
          if (discordRoleId) {
            body.content = `<@&${discordRoleId}> ${content}`;
          }
          fetch(discordWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          }).catch(err => console.error('Error probando Discord:', err));
        }
      }
    } catch (e) {
      console.error('Error probando notificaciones externas:', e);
    }

    if (permission === 'granted') {
      try {
        const n = new Notification('¡Prueba exitosa!', {
          body: 'Las notificaciones están funcionando correctamente en tu sistema.',
          icon: '/vite.svg'
        });
        
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch (err) {
        console.error('Error al enviar notificación:', err);
        alert('El permiso está "granted" pero falló el envío. Windows o el navegador podría estar bloqueándolas a nivel de sistema (ej. Modo No Molestar o Configuración de Notificaciones de Windows).');
      }
    } else {
      alert(`No se pueden enviar notificaciones de escritorio. Estado del permiso: ${permission}`);
    }
  };

  const sendNotification = async (title, options = {}) => {
    // 1. Enviar Notificación a Telegram / Discord (Si están configurados)
    try {
      const savedConfig = localStorage.getItem('app_tareas_telegram_config');
      if (savedConfig) {
        const { botToken, chatId, discordWebhookUrl, discordRoleId } = JSON.parse(savedConfig);
        
        // Telegram
        if (botToken && chatId) {
          const telegramMessage = `🔔 *${title}*\n${options.body || ''}`;
          fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: telegramMessage,
              parse_mode: 'Markdown'
            })
          }).catch(err => console.error('Error enviando a Telegram:', err));
        }

        // Discord
        if (discordWebhookUrl) {
          const discordText = `🔔 **${title}**\n${options.body || ''}`.replace(/\*/g, '**'); 
          const body = { content: discordText };
          if (discordRoleId) {
             body.content = `<@&${discordRoleId}> ${discordText}`;
          }
          fetch(discordWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          }).catch(err => console.error('Error enviando a Discord:', err));
        }
      }
    } catch (e) {
      console.error('Error leyendo config de notificaciones:', e);
    }

    // 2. Enviar Notificación Local de Escritorio
    if (permission === 'granted') {
      try {
        new Notification(title, {
          icon: '/vite.svg',
          ...options
        });
      } catch (err) {
        console.error('Silenced notification error:', err);
      }
    }
  };

  useEffect(() => {
    if (permission !== 'granted' || !tasks || tasks.length === 0) return;

    const checkTasksTimeout = () => {
      const now = Date.now();
      const activeTasks = tasks.filter(t => !t.completed && t.dueDate);

      activeTasks.forEach(task => {
        const dueTime = new Date(task.dueDate).getTime();
        const timeRemaining = dueTime - now;

        if (timeRemaining < -60000) return; 

        for (let threshold of DYNAMIC_THRESHOLDS) {
          // Si el tiempo restante acaba de cruzar un umbral (con margen de 30 segundos)
          if (timeRemaining <= threshold && timeRemaining > threshold - 30000) {
            const notificationId = `${task.id}-${threshold}`;
            
            if (!notifiedTasksRef.current.has(notificationId)) {
              notifiedTasksRef.current.add(notificationId);
              
              const isNow = threshold === 0;
              const minutesTotal = Math.round(threshold / 60000);
              const hours = Math.floor(minutesTotal / 60);
              const mins = minutesTotal % 60;
              
              let timeStr = '';
              if (hours > 0) timeStr += `${hours}h `;
              if (mins > 0 || hours === 0) timeStr += `${mins}m`;
              
              sendNotification(
                isNow ? `¡Tiempo agotado! ${task.title}` : `Tarea próxima: ${task.title}`,
                { 
                  body: isNow 
                    ? `La tarea "${task.title}" debe entregarse ahora mismo.`
                    : `La tarea "${task.title}" vence en ${timeStr.trim()}.`,
                  tag: task.id 
                }
              );
            }
            break; 
          }
        }
      });
    };

    const intervalId = setInterval(checkTasksTimeout, 15000);
    checkTasksTimeout();

    return () => clearInterval(intervalId);
  }, [tasks, permission]);

  return {
    permission,
    requestPermission,
    testNotification,
    sendNotification
  };
}
