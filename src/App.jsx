import { useEffect, useState } from 'react';
import { useTasks } from './hooks/useTasks';
import { useNotifications } from './hooks/useNotifications';
import { TaskForm } from './components/TaskForm';
import { TaskList } from './components/TaskList';
import { SettingsModal } from './components/SettingsModal';
import './index.css';

function App() {
  const [showSettings, setShowSettings] = useState(false);
  const { 
    tasks, categories, 
    addTask, updateTask, toggleTaskCompletion, deleteTask,
    addCategory, deleteCategory, addAttachmentToTask, deleteAttachmentFromTask
  } = useTasks();
  
  const { permission, requestPermission, testNotification } = useNotifications(tasks);
  const [showNotificationPrompt, setShowNotificationPrompt] = useState(false);

  useEffect(() => {
    // Si no hemos preguntado por permisos y las notificaciones están soportadas
    if (permission === 'default' && 'Notification' in window) {
      // Damos un pequeño delay para no abrumar al usuario apenas carga
      const timer = setTimeout(() => {
        setShowNotificationPrompt(true);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [permission]);

  const handleEnableNotifications = async () => {
    const granted = await requestPermission();
    setShowNotificationPrompt(false);
    
    if (granted) {
      // Pequeña notificación de prueba
      new Notification('¡Notificaciones activadas!', {
        body: 'Te avisaremos cuando tus tareas estén por vencer.',
        icon: '/vite.svg'
      });
    }
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-top">
          <div>
            <h1>TareApp</h1>
            <p className="subtitle">Gestiona tu tiempo eficientemente</p>
          </div>
          <div className="header-actions" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {permission === 'granted' && (
              <button 
                className="btn outline test-btn" 
                onClick={testNotification}
                title="Probar notificaciones"
              >
                🔔 Probar Notificación
              </button>
            )}
            <button 
              className="btn outline settings-btn" 
              onClick={() => setShowSettings(true)}
              title="Configurar Notificaciones Móviles de Telegram"
              style={{ fontSize: '1.2rem', padding: '0.3rem 0.6rem' }}
            >
              ⚙️
            </button>
          </div>
        </div>
      </header>

      {showNotificationPrompt && (
        <div className="notification-prompt glass-panel">
          <div className="prompt-content">
            <span className="prompt-icon">🔔</span>
            <div className="prompt-text">
              <h3>Activar Notificaciones</h3>
              <p>Te avisaremos cuando tus tareas estén a punto de vencer.</p>
            </div>
          </div>
          <div className="prompt-actions">
            <button 
              className="btn outline" 
              onClick={() => setShowNotificationPrompt(false)}
            >
              Más tarde
            </button>
            <button 
              className="btn primary" 
              onClick={handleEnableNotifications}
            >
              Activar
            </button>
          </div>
        </div>
      )}

      <main className="app-main">
        <TaskForm 
          onAddTask={addTask} 
          categories={categories}
          onAddCategory={addCategory}
          onDeleteCategory={deleteCategory}
        />
        
        <TaskList 
          tasks={tasks} 
          categories={categories}
          onToggle={toggleTaskCompletion} 
          onDelete={deleteTask}
          onAddAttachment={addAttachmentToTask}
          onDeleteAttachment={deleteAttachmentFromTask}
        />
      </main>

      {permission === 'denied' && (
        <footer className="app-footer">
          <p className="warning-text">
            ⚠️ Las notificaciones están bloqueadas en tu navegador. 
            Habilítalas en los ajustes del sitio para recibir alertas de tus tareas.
          </p>
        </footer>
      )}

      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

export default App;
