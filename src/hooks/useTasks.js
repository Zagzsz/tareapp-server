import { useState, useEffect } from 'react';
import { API_URL } from '../config';

const TASKS_STORAGE_KEY = 'app_tareas_data';
const CATEGORIES_STORAGE_KEY = 'app_tareas_categories';

export function useTasks() {
  const [tasks, setTasks] = useState([]);
  const [categories, setCategories] = useState(['General']);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [catsRes, tasksRes] = await Promise.all([
          fetch(`${API_URL}/categories`),
          fetch(`${API_URL}/tasks`)
        ]);
        if (catsRes.ok) {
          const catData = await catsRes.json();
          if (catData && catData.length > 0) setCategories(catData);
        }
        if (tasksRes.ok) {
          const rawTasks = await tasksRes.json();
          // Cargar archivos adjuntos para cada tarea
          const tasksWithAtt = await Promise.all(rawTasks.map(async t => {
            const attRes = await fetch(`${API_URL}/tasks/${t.id}/attachments`);
            const attachments = attRes.ok ? await attRes.json() : [];
            return {
              ...t,
              completed: Boolean(t.completed),
              attachments
            };
          }));
          setTasks(tasksWithAtt);
        }
      } catch (e) {
        console.error('Error fetching data from server:', e);
      }
    };
    fetchData();
  }, []);



  const addTask = async (task) => {
    try {
      const res = await fetch(`${API_URL}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(task)
      });
      if (res.ok) {
        const newTask = await res.json();
        setTasks(prev => [...prev, { ...newTask, completed: Boolean(newTask.completed), attachments: [] }]);
        return newTask;
      }
    } catch (e) { console.error('Error adding task:', e); }
  };

  const updateTask = async (id, updates) => {
    try {
      setTasks(prev => prev.map(task => task.id === id ? { ...task, ...updates } : task));
      const taskObj = tasks.find(t=>t.id === id);
      const payload = { ...taskObj, ...updates };

      await fetch(`${API_URL}/tasks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) { console.error('Error updating task:', e); }
  };

  const toggleTaskCompletion = async (id) => {
    const taskObj = tasks.find(t=>t.id === id);
    if (!taskObj) return;
    const newCompletedState = !taskObj.completed;
    try {
      setTasks(prev => prev.map(task => task.id === id ? { ...task, completed: newCompletedState } : task));
      await fetch(`${API_URL}/tasks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...taskObj, completed: newCompletedState })
      });
    } catch (e) { console.error('Error toggling completion:', e); }
  };

  const deleteTask = async (id) => {
    try {
      setTasks(prev => prev.filter(task => task.id !== id));
      await fetch(`${API_URL}/tasks/${id}`, { method: 'DELETE' });
    } catch (e) { console.error('Error deleting task:', e); }
  };

  const addCategory = async (categoryName) => {
    const name = categoryName.trim();
    if (!name || categories.includes(name)) return;
    try {
      setCategories(prev => [...prev, name]);
      await fetch(`${API_URL}/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
    } catch (e) { console.error('Error adding category:', e); }
  };

  const deleteCategory = async (categoryName) => {
    if (categoryName === 'General') return;
    try {
      setCategories(prev => prev.filter(cat => cat !== categoryName));
      setTasks(prev => prev.map(task => task.category === categoryName ? { ...task, category: 'General' } : task));
      await fetch(`${API_URL}/categories/${categoryName}`, { method: 'DELETE' });
    } catch (e) { console.error('Error deleting category:', e); }
  };

  const addAttachmentToTask = async (taskId, file) => {
    try {
      const formData = new FormData();
      formData.append('evidence', file);

      const res = await fetch(`${API_URL}/tasks/${taskId}/attachments`, {
        method: 'POST',
        body: formData
      });
      if (res.ok) {
        const newAtt = await res.json();
        setTasks(prev => prev.map(task => {
          if (task.id === taskId) {
            return { ...task, attachments: [...(task.attachments||[]), newAtt] };
          }
          return task;
        }));
      }
    } catch (e) { console.error('Error attaching file:', e); }
  };

  const deleteAttachmentFromTask = async (taskId, attachmentIndex) => {
    const taskObj = tasks.find(t=>t.id === taskId);
    if (!taskObj || !taskObj.attachments || !taskObj.attachments[attachmentIndex]) return;
    const attToDelete = taskObj.attachments[attachmentIndex];
    
    try {
      setTasks(prev => prev.map(task => {
        if (task.id === taskId) {
          return {
            ...task,
            attachments: task.attachments.filter((_, i) => i !== attachmentIndex)
          };
        }
        return task;
      }));
      await fetch(`${API_URL}/attachments/${attToDelete.id}`, { method: 'DELETE' });
    } catch (e) { console.error('Error deleting attachment:', e); }
  };

  return {
    tasks,
    categories,
    addTask,
    updateTask,
    toggleTaskCompletion,
    deleteTask,
    addCategory,
    deleteCategory,
    addAttachmentToTask,
    deleteAttachmentFromTask
  };
}
