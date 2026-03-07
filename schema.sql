-- Creación de la Base de Datos
CREATE DATABASE IF NOT EXISTS tareas_db;
USE tareas_db;

-- Tabla de Configuraciones Globales (Para persistir Telegram Tokens de forma centralizada)
CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(50) PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL
);

-- Tabla de Áreas / Categorías
CREATE TABLE IF NOT EXISTS categories (
  name VARCHAR(100) PRIMARY KEY
);

-- Insertar "General" por defecto
INSERT IGNORE INTO categories (name) VALUES ('General');

-- Tabla de Tareas
CREATE TABLE IF NOT EXISTS tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100) DEFAULT 'General',
  dueDate DATETIME,
  completed BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category) REFERENCES categories(name) ON DELETE SET NULL ON UPDATE CASCADE
);

-- Tabla para guardar múltiples evidencias por tarea
CREATE TABLE IF NOT EXISTS attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  file_type VARCHAR(100),
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
