import { useState } from 'react';
import { TaskItem } from './TaskItem';
import './TaskList.css';

export function TaskList({ tasks, onToggle, onDelete, onAddAttachment, onDeleteAttachment }) {
  const [filterCategory, setFilterCategory] = useState('Todas');

  if (!tasks || tasks.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">📝</div>
        <p>No tienes tareas pendientes.</p>
        <p className="empty-subtitle">Agrega una arriba para comenzar</p>
      </div>
    );
  }

  // Obtener categorías únicas actuales
  const uniqueCategories = ['Todas', ...new Set(tasks.map(t => t.category || 'General'))];

  // Filtrar tareas por categoría
  const filteredTasks = filterCategory === 'Todas' 
    ? tasks 
    : tasks.filter(t => (t.category || 'General') === filterCategory);

  const sortedTasks = [...filteredTasks].sort((a, b) => {
    if (a.completed !== b.completed) {
      return a.completed ? 1 : -1;
    }
    
    if (a.dueDate && b.dueDate) {
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    }
    
    if (a.dueDate && !b.dueDate) return -1;
    if (!a.dueDate && b.dueDate) return 1;
    
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <div className="task-list-container">
      <div className="task-list-header">
        <div className="header-title-row">
          <h2>Tus Tareas</h2>
          <span className="task-count">
            {filteredTasks.filter(t => !t.completed).length} pendientes
          </span>
        </div>
        
        {uniqueCategories.length > 2 && (
          <div className="category-filters">
            {uniqueCategories.map(cat => (
              <button
                key={cat}
                className={`filter-btn ${filterCategory === cat ? 'active' : ''}`}
                onClick={() => setFilterCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>
      
      <div className="task-list">
        {sortedTasks.length === 0 ? (
          <p className="empty-filter">No hay tareas en esta categoría.</p>
        ) : (
          sortedTasks.map(task => (
            <TaskItem 
              key={task.id} 
              task={task} 
              onToggle={onToggle}
              onDelete={onDelete}
              onAddAttachment={onAddAttachment}
              onDeleteAttachment={onDeleteAttachment}
            />
          ))
        )}
      </div>
    </div>
  );
}
