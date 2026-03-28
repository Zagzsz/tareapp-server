const { scrapeAcademicManager } = require('./scraper');
const { syncTaskToNotion } = require('./notionSync');

let syncInProgress = false;
let lastSyncMeta = null;

async function syncAcademicTasks({ pool, academicUser, academicPass, source = 'manual' }) {
  if (syncInProgress) {
    return {
      busy: true,
      message: 'Ya hay una sincronizacion en progreso. Intenta de nuevo en un momento.',
      lastSyncMeta
    };
  }

  syncInProgress = true;
  const startedAt = new Date().toISOString();

  try {
    const academicTasks = await scrapeAcademicManager(academicUser, academicPass);

    let added = 0;
    let updated = 0;
    let notionSynced = 0;

    for (const task of academicTasks) {
      const [existing] = await pool.query('SELECT id FROM tasks WHERE title = ?', [task.title]);
      const mysqlDate = task.dueDate;
      let taskId = null;

      if (existing.length === 0) {
        if (task.category && task.category !== 'General') {
          await pool.query('INSERT IGNORE INTO categories (name) VALUES (?)', [task.category]);
        }

        const [insertRes] = await pool.query(
          'INSERT INTO tasks (title, description, dueDate, category) VALUES (?, ?, ?, ?)',
          [task.title, task.description, mysqlDate, task.category || 'General']
        );

        taskId = insertRes.insertId;
        added++;
      } else {
        taskId = existing[0].id;
        const [updateRes] = await pool.query('UPDATE tasks SET dueDate = ?, description = ?, category = ? WHERE id = ?', [mysqlDate, task.description, task.category || 'General', taskId]);
        if (updateRes.changedRows > 0) {
          updated++;
          await pool.query('DELETE FROM sent_notifications WHERE task_id = ?', [taskId]);
        }
      }

      if (taskId) {
        const [taskRows] = await pool.query('SELECT id, title, description, category, dueDate, completed FROM tasks WHERE id = ?', [taskId]);
        if (taskRows.length > 0) {
          const notionResult = await syncTaskToNotion(pool, taskRows[0], { upsert: true });
          if (notionResult.synced) notionSynced++;
        }
      }
    }

    lastSyncMeta = {
      source,
      startedAt,
      finishedAt: new Date().toISOString(),
      found: academicTasks.length,
      added,
      updated,
      notionSynced,
      success: true
    };

    return {
      busy: false,
      ...lastSyncMeta
    };
  } catch (error) {
    lastSyncMeta = {
      source,
      startedAt,
      finishedAt: new Date().toISOString(),
      success: false,
      error: error.message
    };

    throw error;
  } finally {
    syncInProgress = false;
  }
}

function isAcademicSyncRunning() {
  return syncInProgress;
}

module.exports = {
  syncAcademicTasks,
  isAcademicSyncRunning
};
