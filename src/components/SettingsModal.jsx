import { useState, useEffect } from 'react';
import { API_URL } from '../config';
import './SettingsModal.css';

const TELEGRAM_CONFIG_KEY = 'app_tareas_telegram_config';

export function SettingsModal({ onClose }) {
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState('');
  const [discordRoleId, setDiscordRoleId] = useState('');
  const [discordBotToken, setDiscordBotToken] = useState('');
  const [academicUser, setAcademicUser] = useState('');
  const [academicPass, setAcademicPass] = useState('');
  const [isSaved, setIsSaved] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  useEffect(() => {
    // Intentar cargar desde el backend primero, fallback a localStorage
    const loadConfig = async () => {
      try {
        const res = await fetch(`${API_URL}/settings`);
        if (res.ok) {
          const data = await res.json();
          if (data.botToken) setBotToken(data.botToken);
          if (data.chatId) setChatId(data.chatId);
          if (data.discordWebhookUrl) setDiscordWebhookUrl(data.discordWebhookUrl);
          if (data.discordRoleId) setDiscordRoleId(data.discordRoleId);
          if (data.discordBotToken) setDiscordBotToken(data.discordBotToken);
          if (data.academicUser) setAcademicUser(data.academicUser);
          if (data.academicPass) setAcademicPass(data.academicPass);
          return;
        }
      } catch (e) {
        console.warn('Backend no disponible, cargando config local:', e);
      }
      // Fallback: localStorage
      try {
        const savedConfig = localStorage.getItem(TELEGRAM_CONFIG_KEY);
        if (savedConfig) {
          const parsed = JSON.parse(savedConfig);
          setBotToken(parsed.botToken || '');
          setChatId(parsed.chatId || '');
          setDiscordWebhookUrl(parsed.discordWebhookUrl || '');
          setDiscordRoleId(parsed.discordRoleId || '');
          setDiscordBotToken(parsed.discordBotToken || '');
          setAcademicUser(parsed.academicUser || '');
          setAcademicPass(parsed.academicPass || '');
        }
      } catch (e) {
        console.error('Error cargando config de Telegram:', e);
      }
    };
    loadConfig();
  }, []);
  const handleSaveTelegram = async (e) => {
    e.preventDefault();
    try {
      const savedConfig = localStorage.getItem(TELEGRAM_CONFIG_KEY);
      const configObj = savedConfig ? JSON.parse(savedConfig) : {};
      const newConfig = { ...configObj, botToken: botToken.trim(), chatId: chatId.trim() };
      localStorage.setItem(TELEGRAM_CONFIG_KEY, JSON.stringify(newConfig));
      
      try {
        await fetch(`${API_URL}/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botToken: botToken.trim(), chatId: chatId.trim() })
        });
      } catch (apiErr) {
        console.warn('No se pudo guardar Telegram en el servidor:', apiErr);
      }
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 1500);
      alert('Configuración de Telegram guardada.');
    } catch (error) {
      console.error('Error guardando config Telegram:', error);
      alert('Error guardando la configuración');
    }
  };

  const handleSaveDiscord = async (e) => {
    e.preventDefault();
    try {
      const trimmedToken = discordBotToken.trim();
      const trimmedWebhook = discordWebhookUrl.trim();
      const trimmedRole = discordRoleId.trim();
      
      const savedConfig = localStorage.getItem(TELEGRAM_CONFIG_KEY);
      const configObj = savedConfig ? JSON.parse(savedConfig) : {};
      const newConfig = { ...configObj, discordWebhookUrl: trimmedWebhook, discordRoleId: trimmedRole, discordBotToken: trimmedToken };
      localStorage.setItem(TELEGRAM_CONFIG_KEY, JSON.stringify(newConfig));
      
      try {
        await fetch(`${API_URL}/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ discordWebhookUrl: trimmedWebhook, discordRoleId: trimmedRole, discordBotToken: trimmedToken })
        });
      } catch (apiErr) {
        console.warn('No se pudo guardar Discord en el servidor:', apiErr);
      }
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 1500);
      alert('Configuración de Discord guardada.');
    } catch (error) {
      console.error('Error guardando config Discord:', error);
      alert('Error guardando la configuración');
    }
  };

  const handleSync = async () => {
    if (!academicUser || !academicPass) {
      alert('Por favor ingresa tu usuario y contraseña de Academic');
      return;
    }

    setIsSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch(`${API_URL}/sync-academic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ academicUser, academicPass })
      });
      const data = await res.json();
      if (res.ok) {
        setSyncResult({ success: true, added: data.added, found: data.found });
        // Recargar tareas si es posible (enviando evento o recargando página)
        setTimeout(() => window.location.reload(), 2000);
      } else {
        throw new Error(data.error || 'Error en sincronización');
      }
    } catch (error) {
      console.error(error);
      setSyncResult({ success: false, error: error.message });
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Configuración de Telegram 🚀</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        
        <div className="settings-tabs">
          <section className="settings-section">
            <h3>Notificaciones de Telegram 🚀</h3>
            <form onSubmit={handleSaveTelegram} className="settings-form">
              <div className="form-group">
                <label htmlFor="botToken">Token de Nuevo Bot (BotFather)</label>
                <input 
                  id="botToken"
                  type="text" 
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  placeholder="Ej: 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                  className="settings-input"
                />
              </div>

              <div className="form-group">
                <label htmlFor="chatId">Tu ID de Chat (O del Grupo)</label>
                <input 
                  id="chatId"
                  type="text" 
                  value={chatId}
                  onChange={(e) => setChatId(e.target.value)}
                  placeholder="Ej: 123456789"
                  className="settings-input"
                />
              </div>

              <button type="submit" className={`btn primary ${isSaved ? 'success' : ''}`}>
                {isSaved ? '¡Guardado!' : 'Guardar Telegram'}
              </button>
            </form>
          </section>

          <hr className="settings-divider" />

          <section className="settings-section">
            <h3>Notificaciones de Discord 👾</h3>
            <form onSubmit={handleSaveDiscord} className="settings-form">
              <div className="form-group">
                <label htmlFor="discordWebhookUrl">Webhook URL de Discord</label>
                <input 
                  id="discordWebhookUrl"
                  type="text" 
                  value={discordWebhookUrl}
                  onChange={(e) => setDiscordWebhookUrl(e.target.value)}
                  placeholder="Ej: https://discord.com/api/webhooks/..."
                  className="settings-input"
                />
              </div>

              <div className="form-group">
                <label htmlFor="discordRoleId">ID de Rol a Mencionar (Opcional)</label>
                <input 
                  id="discordRoleId"
                  type="text" 
                  value={discordRoleId}
                  onChange={(e) => setDiscordRoleId(e.target.value)}
                  placeholder="Ej: 123456789012345678"
                  className="settings-input"
                />
                <small style={{ color: '#888', fontSize: '0.8rem', marginTop: '4px', display: 'block' }}>
                  Pega aquí el ID del rol para arrobar a tus amigos.
                </small>
              </div>

              <div className="form-group">
                <label htmlFor="discordBotToken">Discord Bot Token (Opcional)</label>
                <input 
                  id="discordBotToken"
                  type="password" 
                  value={discordBotToken}
                  onChange={(e) => setDiscordBotToken(e.target.value)}
                  placeholder="MTQ4..."
                  className="settings-input"
                />
                <small style={{ color: '#888', fontSize: '0.8rem', marginTop: '4px', display: 'block' }}>
                  Necesario para que el comando !tareas funcione.
                </small>
              </div>

              <button type="submit" className={`btn primary ${isSaved ? 'success' : ''}`}>
                {isSaved ? '¡Guardado!' : 'Guardar Discord'}
              </button>
            </form>
          </section>

          <hr className="settings-divider" />

          <section className="settings-section">
            <h3>Sincronización Académica 🎓</h3>
            <p className="settings-desc">
              Importa tus tareas automáticamente desde Academic Manager.
            </p>
            <div className="form-group">
              <label htmlFor="academicUser">Usuario Academic</label>
              <input 
                id="academicUser"
                type="text" 
                value={academicUser}
                onChange={(e) => setAcademicUser(e.target.value)}
                placeholder="Tu usuario o correo"
                className="settings-input"
              />
            </div>
            <div className="form-group">
              <label htmlFor="academicPass">Contraseña Academic</label>
              <input 
                id="academicPass"
                type="password" 
                value={academicPass}
                onChange={(e) => setAcademicPass(e.target.value)}
                placeholder="Tu contraseña"
                className="settings-input"
              />
            </div>

            <div className="sync-actions">
              <button 
                onClick={handleSync} 
                disabled={isSyncing} 
                className={`btn secondary ${isSyncing ? 'loading' : ''}`}
              >
                {isSyncing ? 'Sincronizando...' : 'Sincronizar Ahora'}
              </button>
              
              {syncResult && (
                <p className={`sync-status ${syncResult.success ? 'success' : 'error'}`}>
                  {syncResult.success 
                    ? `¡Éxito! Encontradas ${syncResult.found}, Agregadas ${syncResult.added} nuevas.` 
                    : `Error: ${syncResult.error}`}
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
