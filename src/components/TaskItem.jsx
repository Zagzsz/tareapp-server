import { useEffect, useState, useRef } from 'react';
import { formatDistanceToNow, isPast } from 'date-fns';
import { es } from 'date-fns/locale';
import { API_BASE_URL } from '../config';
import './TaskItem.css';

export function TaskItem({ task, onToggle, onDelete, onAddAttachment, onDeleteAttachment }) {
  const [timeLeftStr, setTimeLeftStr] = useState('');
  const [urgencyClass, setUrgencyClass] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const fileInputRef = useRef();

  useEffect(() => {
    if (!task.dueDate || task.completed) return;

    const updateTimeLeft = () => {
      const due = new Date(task.dueDate);
      const past = isPast(due);
      
      if (past) {
        setTimeLeftStr('¡Atrasada!');
        setUrgencyClass('urgent-past');
        return;
      }

      const distance = formatDistanceToNow(due, { locale: es, addSuffix: true });
      setTimeLeftStr(`Vence ${distance}`);

      const msRestantes = due.getTime() - Date.now();
      if (msRestantes <= 30 * 60 * 1000) {
        setUrgencyClass('urgent-critical');
      } else if (msRestantes <= 2 * 60 * 60 * 1000) {
        setUrgencyClass('urgent-warning');
      } else {
        setUrgencyClass('');
      }
    };

    updateTimeLeft();
    const interval = setInterval(updateTimeLeft, 60000);
    return () => clearInterval(interval);
  }, [task.dueDate, task.completed]);

  const hasExtraContent = task.description || (task.attachments && task.attachments.length > 0);

  // Helper para abrir/descargar adjunto
  const handleAttachmentClick = (att) => {
    try {
      const url = `${API_BASE_URL}${att.file_path}`;
      const newTab = window.open(url, '_blank');
      if (!newTab) {
        // Fallback: descargar el archivo
        const link = document.createElement('a');
        link.href = url;
        link.download = att.name;
        link.click();
      }
    } catch (e) {
      console.error("Error al abrir archivo", e);
      alert("No se pudo abrir el archivo de forma automática.");
    }
  };

  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    for (let file of files) {
      // Ya no hay límite estricto de 2MB porque va hacia NodeJS, pero podemos dejar una alerta de cortesía
      if (file.size > 15 * 1024 * 1024) {
        alert(`El archivo ${file.name} es demasiado grande. Máximo recomendado: 15MB.`);
        continue;
      }
      try {
        await onAddAttachment(task.id, file); // onAddAttachment se encarga del POST FormData
      } catch (err) {
        console.error('Error enviando archivo al API', err);
      }
    }
  };

  return (
    <div className={`task-item ${task.completed ? 'completed' : ''} ${urgencyClass} ${isExpanded ? 'expanded' : ''}`}>
      <div className="task-main-row">
        <label className="checkbox-container">
          <input 
            type="checkbox" 
            checked={task.completed}
            onChange={() => onToggle(task.id)}
          />
          <span className="checkmark"></span>
        </label>
        
        <div 
          className="task-text" 
          onClick={() => hasExtraContent && setIsExpanded(!isExpanded)}
          style={{ cursor: hasExtraContent ? 'pointer' : 'default' }}
        >
          <div className="task-header-info">
            <span className="task-category">{task.category || 'General'}</span>
            <h3 className="task-title">
              {task.title}
              {hasExtraContent && <span className="expand-indicator">{isExpanded ? ' ▲' : ' ▼'}</span>}
            </h3>
          </div>
          
          {task.dueDate && (
            <div className={`task-due ${task.completed ? 'hidden' : ''}`}>
              <span className="due-icon">⏱</span>
              <span className="due-text">{timeLeftStr}</span>
            </div>
          )}
        </div>

        <button 
          className="delete-btn" 
          onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
          aria-label="Eliminar tarea"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
        </button>
      </div>

      {isExpanded && hasExtraContent && (
        <div className="task-details">
          {task.description && (
            <p className="task-description">{task.description}</p>
          )}
          
          {task.completed && (
            <div className="task-proof-section">
              <p className="attachments-title">Evidencia de que se finalizó la tarea:</p>
              
              <div className="attachment-grid">
                {task.attachments && task.attachments.map((att, index) => (
                  <div 
                    key={index} 
                    className="attachment-card"
                    title={att.name}
                  >
                    <button 
                      className="remove-att-btn" 
                      onClick={(e) => { e.stopPropagation(); onDeleteAttachment(task.id, index); }}
                      title="Eliminar evidencia"
                    >
                      ✕
                    </button>
                    
                    <div onClick={() => handleAttachmentClick(att)} style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      {att.file_type && att.file_type.startsWith('image/') ? (
                        <div className="att-image-preview" style={{ backgroundImage: `url(${API_BASE_URL}${att.file_path})` }} />
                      ) : (
                        <div className="att-file-icon">📄</div>
                      )}
                      <span className="att-name-small">{att.name}</span>
                    </div>
                  </div>
                ))}

                <div 
                  className="attachment-card add-proof-btn"
                  onClick={() => fileInputRef.current.click()}
                  title="Añadir evidencia"
                >
                  <div className="att-file-icon">+</div>
                  <span className="att-name-small">Subir</span>
                </div>
              </div>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                style={{ display: 'none' }} 
                multiple
                accept="image/*,.pdf,.doc,.docx,.txt"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
