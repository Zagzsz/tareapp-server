import { useState, useRef, useEffect } from 'react';
import { fileToBase64, validateFileSize, isImageBase64 } from '../utils/fileUtils';
import './TaskForm.css';

export function TaskForm({ onAddTask, categories, onAddCategory, onDeleteCategory }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState(categories[0] || 'General');
  const [dueDate, setDueDate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  
  const [newCatName, setNewCatName] = useState('');
  const [isAddingCat, setIsAddingCat] = useState(false);

  // Asegurarnos de que siempre haya una categoría seleccionada válida si las categorías cambian
  useEffect(() => {
    if (!categories.includes(category) && categories.length > 0) {
      setCategory(categories[0]);
    }
  }, [categories, category]);
  const handleSubmit = (e) => {
    e.preventDefault();
    if (!title.trim()) return;

    setIsSubmitting(true);
    
    // Simplificamos la llamada para evitar bugs de asincronicidad en componentes
    onAddTask({
      title: title.trim(),
      description: description.trim(),
      category: category,
      dueDate: dueDate || null
    });
    
    // Reset form
    setTitle('');
    setDescription('');
    // Al resetear la categoría volvemos al estado inicial válido
    setCategory(categories.includes(category) ? category : categories[0]);
    setDueDate('');
    setIsExpanded(false);
    setIsSubmitting(false);
  };

  const handleAddCategory = () => {
    if (newCatName.trim()) {
      onAddCategory(newCatName.trim());
      setCategory(newCatName.trim());
      setNewCatName('');
      setIsAddingCat(false);
    }
  };

  const getMinDateTime = () => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  };

  return (
    <form className={`task-form ${isExpanded ? 'expanded' : ''}`} onSubmit={handleSubmit}>
      <div className="input-group main-row">
        <input
          type="text"
          placeholder="Título de la tarea (Obligatorio)..."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={() => setIsExpanded(true)}
          required
          className="task-input title-input"
          disabled={isSubmitting}
        />
        <button 
          type="button" 
          className="expand-btn"
          onClick={() => setIsExpanded(!isExpanded)}
          title="Opciones avanzadas"
        >
          {isExpanded ? '▲' : '▼'}
        </button>
      </div>

      {isExpanded && (
        <div className="advanced-options">
          <div className="cat-management-row">
            {!isAddingCat ? (
              <div className="input-group">
                <select 
                  value={category} 
                  onChange={(e) => setCategory(e.target.value)}
                  className="category-select"
                >
                  {categories.map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
                <button 
                  type="button" 
                  className="btn outline add-cat-btn"
                  onClick={() => setIsAddingCat(true)}
                  title="Añadir nueva área/asignatura"
                >
                  + Área
                </button>
                {category !== 'General' && (
                  <button 
                    type="button" 
                    className="btn outline delete-cat-btn"
                    onClick={() => onDeleteCategory(category)}
                    title="Eliminar área actual"
                  >
                    🗑️
                  </button>
                )}
                <input
                  type="datetime-local"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  min={getMinDateTime()}
                  className="date-input"
                  disabled={isSubmitting}
                />
              </div>
            ) : (
              <div className="input-group new-cat-group">
                <input 
                  type="text" 
                  placeholder="Nombre de la nueva área..." 
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  className="category-input"
                  autoFocus
                />
                <button type="button" className="btn primary" onClick={handleAddCategory}>✓</button>
                <button type="button" className="btn outline" onClick={() => setIsAddingCat(false)}>✕</button>
              </div>
            )}
          </div>

          <textarea
            placeholder="Añade una descripción (opcional)..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="desc-input"
            rows="3"
            disabled={isSubmitting}
          ></textarea>
        </div>
      )}

      {isExpanded && (
        <div className="form-actions">
          <button 
            type="submit" 
            className={`submit-btn ${isSubmitting ? 'submitting' : ''}`}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Guardando...' : '+ Guardar Tarea'}
          </button>
        </div>
      )}
      
      {!isExpanded && (
        <button 
          type="submit" 
          className="submit-btn mini-submit"
          disabled={isSubmitting}
        >
          {isSubmitting ? '...' : '+'}
        </button>
      )}
    </form>
  );
}
